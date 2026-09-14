/**
 * The `skill_manage` write path: six mutating actions and an atomic batch
 * executor.
 *
 * Everything the model writes to disk passes through {@link runOperations}, so
 * the rules live here rather than in the tool registration:
 *
 * - A **batch is atomic**. Every distinct touched skill is copied aside before
 *   the first mutation, and an operation that fails restores the whole batch, so
 *   the observable state matches the pre-batch state.
 * - **Two snapshots, opposite semantics.** The atomicity copy in
 *   {@link snapshotTouched} is a gate — no snapshot, no atomicity, and the batch
 *   aborts with nothing touched. The audit ledger in `ledger.ts` is telemetry —
 *   a capture failure only means the entry has no `before`, and the write
 *   continues. Neither may be turned into the other.
 * - **Lint is advisory.** A create that trips lint rules still succeeds; the
 *   findings ride along as `lint_warnings` and a `lint_hint` that says so.
 * - **Names are validated before any path is built.** A skill name is joined
 *   onto {@link ManageDeps.skillsRoot}, so an invalid one must be refused before
 *   a snapshot or a write can act on the traversal.
 *
 * Dependencies are a small plain object of real handles and two closures — no
 * cordis context, no live harness object — so a test builds one from temp
 * directories plus the in-memory table stub.
 * @module dsh-buddy/skills/manage
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SkillLedgerRecord } from "../store/domain.ts";
import { captureBefore, captureManifest, recordMutation, type LedgerDeps } from "./ledger.ts";
import { lintSkill, type LintFinding } from "./linter.ts";
import { atomicSnapshot, type SnapshotEntry } from "./snapshot.ts";
import { bumpPatch, recordCreated, type UsageTable } from "./usage.ts";
import { validateSkillDocument, validateSkillName, validateSupportBytes, validateSupportPath } from "./validate.ts";

/** The most operations one `skill_manage` call may carry. */
export const MAX_BATCH_OPERATIONS = 20;

/** One mutating action the tool understands. */
export type SkillAction = "create" | "patch" | "edit" | "delete" | "write_file" | "remove_file";

/** One requested mutation, as the model writes it. */
export interface Operation {
	/** Which action to apply. */
	readonly action: SkillAction;
	/** The skill directory name, in DSH's kebab-case grammar. */
	readonly name: string;
	/** The complete document for `create`/`edit`, or a support file's body. */
	readonly content?: string;
	/** The exact text `patch` replaces. */
	readonly old_string?: string;
	/** What `patch` puts in its place. */
	readonly new_string?: string;
	/** The skill-relative support path for `write_file`/`remove_file`. */
	readonly file_path?: string;
	/** Reserved for a later phase's absorbed-skill bookkeeping; unused here. */
	readonly absorbed_into?: string;
}

/**
 * Everything the write path needs, and nothing live.
 *
 * Extends {@link LedgerDeps} so the same object goes straight to
 * `captureBefore` and `recordMutation`. `now` is a **clock function**, not a
 * fixed timestamp: `runOperations` takes no timestamp of its own, and a batch
 * spans many awaits, so each mutation should be stamped at its own instant
 * while a test injects a frozen closure and stays deterministic without faking
 * the global clock. `actor` is likewise declared by the caller (the review
 * sub-session knows it is `agent`; a chat turn is `user`) rather than inferred.
 */
export interface ManageDeps extends LedgerDeps {
	/** Where skill directories live (`paths.skills`). */
	readonly skillsRoot: string;
	/** The `skill_usage` table (`buddyStore.skillUsage`). */
	readonly usage: UsageTable;
	/** Who is writing; `agent` is reserved for the automatic review. */
	actor(): SkillLedgerRecord["actor"];
	/** The current ISO-8601 instant, read once per mutation. */
	now(): string;
}

/** What a batch reports to its caller. */
export interface BatchOutcome {
	/** Whether every operation applied and the batch was recorded. */
	readonly success: boolean;
	/** One value per completed operation, in order. */
	readonly results: unknown[];
	/** The index of the operation that failed; absent when none ran. */
	readonly failed_index?: number;
	/** How many operations completed before that failure. */
	readonly completed_before_failure?: number;
	/** The refusal message, when the batch did not apply. */
	readonly error?: string;
}

/** One operation's outcome, before {@link runOperations} folds it into a batch. */
export type ApplyOutcome =
	| { readonly success: true; readonly value: unknown }
	| { readonly success: false; readonly error: string };

/** The value a successful action reports back to the model. */
interface AppliedOperation {
	readonly action: SkillAction;
	readonly name: string;
	readonly path: string;
	/** Lint findings, on a create only; advisory by contract. */
	readonly lint_warnings?: LintFinding[];
	/** One line saying the findings above do not block the write. */
	readonly lint_hint?: string;
}

/** One skill the batch may touch, and where its pre-batch copy lives. */
interface SnapshotTarget {
	readonly name: string;
	readonly source: string;
	readonly dest: string;
	/** `false` for a skill the batch is about to create. */
	readonly existed: boolean;
}

/** The per-batch atomicity snapshot: one directory copy per touched skill. */
interface BatchSnapshot {
	/** The per-batch destination under the snapshots directory. */
	readonly root: string;
	readonly targets: readonly SnapshotTarget[];
}

/**
 * Apply one batch of operations atomically.
 *
 * The guards run first and touch nothing: an empty batch, more operations than
 * {@link MAX_BATCH_OPERATIONS}, a `delete` that is not alone, or a name outside
 * DSH's grammar are all refused before a snapshot or a file write. Then the
 * whole batch is snapshotted (a gate), the audit `before` manifest is captured
 * per skill (best effort), and each operation is applied in order. The first
 * failure restores every touched skill and reports the failing index; a success
 * records one ledger entry and reports every value.
 * @param deps - paths, tables, actor and clock.
 * @param operations - the requested mutations, in order.
 * @returns the batch outcome; never throws for a refusal.
 */
export async function runOperations(deps: ManageDeps, operations: readonly Operation[]): Promise<BatchOutcome> {
	if (operations.length === 0) return { success: false, results: [], error: "no operations" };
	if (operations.length > MAX_BATCH_OPERATIONS) {
		return { success: false, results: [], error: `at most ${MAX_BATCH_OPERATIONS} operations per call` };
	}
	if (operations.some((operation) => operation.action === "delete") && operations.length > 1) {
		return { success: false, results: [], error: "delete must be the sole operation; compose with other ops' rollback" };
	}
	// A name is joined onto the skills root below, so it is checked before any
	// path is built — this is also what keeps `snapshotTouched` from copying (and
	// `restoreSnapshot` from rewriting) something outside the skills root.
	for (const operation of operations) {
		const nameError = validateSkillName(operation.name);
		if (nameError !== undefined) return { success: false, results: [], error: nameError };
	}

	// The atomicity snapshot is the gate the spec insists on: a batch that
	// cannot be undone must not start.
	const snapshot = await snapshotTouched(deps, operations);
	if (!snapshot.ok) return { success: false, results: [], error: snapshot.error };

	// The audit manifests are best effort — a capture failure only means this
	// entry carries no manifest, and the write continues. Each capture takes one
	// root, so every touched skill is captured on its own and the parts are merged
	// into the flat `{ path, sha256 }[]` the ledger stores: all-or-nothing, so one
	// failed part voids the whole manifest rather than half-building one. A skill
	// the batch is about to create has no pre-batch state and is left out of
	// `before`, which also stops the "before-capture failed" line a create batch
	// used to log for it.
	const roots = [...new Set(operations.map((operation) => join(deps.skillsRoot, operation.name)))];
	const before = await captureBeforeAll(deps, await existingRoots(roots));

	const results: unknown[] = [];
	for (const [index, operation] of operations.entries()) {
		const outcome = await applyOne(deps, operation);
		if (!outcome.success) {
			const restored = await restoreSnapshot(snapshot.snapshot);
			return {
				success: false,
				results,
				failed_index: index,
				completed_before_failure: index,
				error: restored.ok ? outcome.error : `${outcome.error} (rollback failed: ${restored.error})`,
			};
		}
		results.push(outcome.value);
	}

	// The batch is whole, so the atomicity copy is spent.
	await discardSnapshot(snapshot.snapshot);
	// `after` mirrors `before`: the same touched roots, now in their new state. A
	// root the batch deleted is gone, so it is left out — capturing it could only
	// log an ENOENT line — and a root the batch created is in. Whole-root capture
	// is deliberately NOT used here: it would sweep in every unrelated skill and
	// the snapshot blobs, and `rollbackEntry` would then remove and rewrite them.
	await recordMutation(deps, {
		actor: deps.actor(),
		action: operations[0]!.action,
		skill: operations[0]!.name,
		evidence: {},
		before,
		after: await captureAfterAll(deps, await existingRoots(roots)),
	});
	return { success: true, results };
}

/**
 * Apply one operation, refusing a bad name before it builds a path.
 *
 * Filesystem failures are answered as refusals rather than thrown, so a batch
 * sees them as the failing operation and rolls back — an exception escaping here
 * would leave the earlier operations applied with no restore.
 * @param deps - paths, tables, actor and clock.
 * @param operation - the requested mutation.
 * @returns the applied value, or the refusal.
 */
export async function applyOne(deps: ManageDeps, operation: Operation): Promise<ApplyOutcome> {
	const nameError = validateSkillName(operation.name);
	if (nameError !== undefined) return { success: false, error: nameError };
	try {
		switch (operation.action) {
			case "create":
				return await createSkill(deps, operation);
			case "patch":
				return await patchSkill(deps, operation);
			case "edit":
				return await editSkill(deps, operation);
			case "delete":
				return await deleteSkill(deps, operation);
			case "write_file":
				return await writeSkillFile(deps, operation);
			case "remove_file":
				return await removeSkillFile(deps, operation);
		}
	} catch (error) {
		return { success: false, error: `${operation.action} '${operation.name}' failed: ${messageOf(error)}` };
	}
	return { success: false, error: `unknown skill action '${operation.action}'` };
}

/**
 * Create a new skill directory and its SKILL.md.
 *
 * The document is validated **first** — before the existence check and before
 * any write — so a malformed create never leaves a directory behind. Lint runs
 * afterwards and only decorates the result: a create that trips every rule still
 * succeeds, because read-before-write and jurisdiction (Task 8) are the gates,
 * not style.
 * @param deps - paths, tables, actor and clock.
 * @param operation - the create request.
 * @returns the applied value, or the refusal.
 */
async function createSkill(deps: ManageDeps, operation: Operation): Promise<ApplyOutcome> {
	const name = operation.name;
	const content = operation.content;
	if (typeof content !== "string") return { success: false, error: `create '${name}' needs 'content'` };
	const validated = validateSkillDocument({ name, content, creating: true });
	if (!validated.ok) return { success: false, error: validated.error };
	const dir = join(deps.skillsRoot, name);
	if (await pathExists(dir)) return { success: false, error: `skill '${name}' already exists` };

	await mkdir(dir, { recursive: true });
	const file = join(dir, "SKILL.md");
	await writeFile(file, content);
	// Telemetry is never a gate, and `recordCreated` cannot reject (see
	// `usage.ts`), so a storage hiccup cannot fail a create that did land.
	await recordCreated(deps.usage, name, { agentCreated: deps.actor() === "agent", now: deps.now() });

	const findings = lintSkill({
		content,
		skillDir: dir,
		skillName: name,
		frontmatter: validated.frontmatter,
		dirExists: (rel) => existsSync(join(dir, rel)),
	});
	if (findings.length === 0) return { success: true, value: { action: "create", name, path: file, lint_warnings: findings } };
	return {
		success: true,
		value: {
			action: "create",
			name,
			path: file,
			lint_warnings: findings,
			lint_hint: `${findings.length} advisory lint finding(s), not blockers — the skill was created.`,
		},
	};
}

/**
 * Replace every occurrence of `old_string` in an existing SKILL.md.
 *
 * The replacement is a literal `split`/`join`, which matches the reference
 * implementation's `str.replace` (all occurrences) and, unlike
 * `String.replace` with a string replacement, cannot interpret `$&` in the
 * model's `new_string`. The patched document is revalidated before it is
 * written, so a patch cannot leave an invalid skill behind.
 * @param deps - paths, tables, actor and clock.
 * @param operation - the patch request.
 * @returns the applied value, or the refusal.
 */
async function patchSkill(deps: ManageDeps, operation: Operation): Promise<ApplyOutcome> {
	const name = operation.name;
	const oldString = operation.old_string;
	const newString = operation.new_string;
	if (typeof oldString !== "string" || oldString === "") {
		return { success: false, error: `patch '${name}' needs a non-empty 'old_string'` };
	}
	if (typeof newString !== "string") return { success: false, error: `patch '${name}' needs 'new_string'` };

	const current = await readSkillDocument(deps, name);
	if (!current.includes(oldString)) {
		return { success: false, error: `patch '${name}' could not find old_string '${preview(oldString)}'` };
	}
	const patched = current.split(oldString).join(newString);
	const validated = validateSkillDocument({ name, content: patched, creating: false });
	if (!validated.ok) return { success: false, error: `patch '${name}' would leave an invalid document: ${validated.error}` };

	const file = join(deps.skillsRoot, name, "SKILL.md");
	await writeFile(file, patched);
	await bumpPatch(deps.usage, name, "patch", deps.now());
	return { success: true, value: { action: "patch", name, path: file } };
}

/**
 * Replace an existing skill's SKILL.md wholesale.
 *
 * `edit` is the deliberate rewrite to `patch`'s surgical replacement, so the
 * skill must already exist and the new document is validated at the existing
 * skill's limits (description ≤ 1024, not the create limit).
 * @param deps - paths, tables, actor and clock.
 * @param operation - the edit request.
 * @returns the applied value, or the refusal.
 */
async function editSkill(deps: ManageDeps, operation: Operation): Promise<ApplyOutcome> {
	const name = operation.name;
	const content = operation.content;
	if (typeof content !== "string") return { success: false, error: `edit '${name}' needs 'content'` };
	await readSkillDocument(deps, name);
	const validated = validateSkillDocument({ name, content, creating: false });
	if (!validated.ok) return { success: false, error: validated.error };

	const file = join(deps.skillsRoot, name, "SKILL.md");
	await writeFile(file, content);
	await bumpPatch(deps.usage, name, "edit", deps.now());
	return { success: true, value: { action: "edit", name, path: file } };
}

/**
 * Delete a skill directory.
 *
 * `delete` is guarded to be the sole operation of its batch, and it writes no
 * usage telemetry: the counters live in the storage domain, which no file
 * snapshot covers, so a later rollback restores the files without pretending to
 * have restored the bookkeeping (spec §8.3's known gap).
 * @param deps - paths, tables, actor and clock.
 * @param operation - the delete request.
 * @returns the applied value, or the refusal.
 */
async function deleteSkill(deps: ManageDeps, operation: Operation): Promise<ApplyOutcome> {
	const name = operation.name;
	const dir = join(deps.skillsRoot, name);
	if (!(await pathExists(dir))) return { success: false, error: `skill '${name}' does not exist` };
	await rm(dir, { recursive: true, force: true });
	return { success: true, value: { action: "delete", name, path: dir } };
}

/**
 * Write one support file inside an existing skill.
 *
 * Only the four allowed subdirectories are reachable and the byte ceiling
 * applies before anything is written; the skill itself must already exist,
 * because inventing one is `create`'s job.
 * @param deps - paths, tables, actor and clock.
 * @param operation - the write_file request.
 * @returns the applied value, or the refusal.
 */
async function writeSkillFile(deps: ManageDeps, operation: Operation): Promise<ApplyOutcome> {
	const name = operation.name;
	const rel = operation.file_path;
	if (typeof rel !== "string") return { success: false, error: `write_file '${name}' needs 'file_path'` };
	const pathError = validateSupportPath(rel);
	if (pathError !== undefined) return { success: false, error: pathError };
	const content = operation.content;
	if (typeof content !== "string") return { success: false, error: `write_file '${name}' needs 'content'` };
	const sizeError = validateSupportBytes(rel, Buffer.byteLength(content, "utf8"));
	if (sizeError !== undefined) return { success: false, error: sizeError };
	await readSkillDocument(deps, name);

	const target = join(deps.skillsRoot, name, normalizeSupportPath(rel));
	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, content);
	await bumpPatch(deps.usage, name, "write_file", deps.now());
	return { success: true, value: { action: "write_file", name, path: target } };
}

/**
 * Remove one support file from an existing skill.
 *
 * A missing file is a refusal rather than a silent success: the model asked for
 * a change that did not happen, and reporting success would hide that.
 * @param deps - paths, tables, actor and clock.
 * @param operation - the remove_file request.
 * @returns the applied value, or the refusal.
 */
async function removeSkillFile(deps: ManageDeps, operation: Operation): Promise<ApplyOutcome> {
	const name = operation.name;
	const rel = operation.file_path;
	if (typeof rel !== "string") return { success: false, error: `remove_file '${name}' needs 'file_path'` };
	const pathError = validateSupportPath(rel);
	if (pathError !== undefined) return { success: false, error: pathError };
	await readSkillDocument(deps, name);

	const target = join(deps.skillsRoot, name, normalizeSupportPath(rel));
	let present = false;
	try {
		present = (await stat(target)).isFile();
	} catch {
		present = false;
	}
	if (!present) return { success: false, error: `support file '${rel}' does not exist in skill '${name}'` };
	await rm(target, { force: true });
	await bumpPatch(deps.usage, name, "remove_file", deps.now());
	return { success: true, value: { action: "remove_file", name, path: target } };
}

/**
 * The subset of roots that exists right now.
 *
 * Called once before the batch and once after it, which is what makes the two
 * audit manifests mirror each other: a root a create will add is absent from
 * `before` and present in `after`, and a root a delete removes is the reverse.
 * @param roots - the touched roots.
 * @returns those that exist, in the given order.
 */
async function existingRoots(roots: readonly string[]): Promise<string[]> {
	const found: string[] = [];
	for (const root of roots) {
		if (await pathExists(root)) found.push(root);
	}
	return found;
}

/**
 * Capture the pre-mutation manifest of every root, best effort.
 *
 * All-or-nothing: `captureBefore` answers `undefined` for a root it could not
 * capture, and one such part voids the whole manifest rather than recording a
 * partial baseline a later rollback would trust.
 * @param deps - the home, the snapshot directory and the ledger table.
 * @param roots - the roots to capture.
 * @returns the merged manifest, or `undefined` when any part failed.
 */
async function captureBeforeAll(deps: ManageDeps, roots: readonly string[]): Promise<SnapshotEntry[] | undefined> {
	const captured = await Promise.all(roots.map((root) => captureBefore(deps, root)));
	return captured.every((part) => part !== undefined) ? captured.flatMap((part) => part ?? []) : undefined;
}

/**
 * Capture the post-mutation manifest of every root, best effort.
 *
 * `captureManifest` is the throwing counterpart of `captureBefore`, so the
 * try/catch lives here and the merge is all-or-nothing like
 * {@link captureBeforeAll}: a failure answers `undefined` — no manifest — rather
 * than a half-built one. The unreadable-entry policy stays the one the ledger's
 * own after-capture used (`completePackage: false`): an unreadable entry is
 * skipped, so the rest of the manifest still lets a rollback remove what the
 * batch created.
 * @param deps - the home, the snapshot directory and the ledger table.
 * @param roots - the roots to capture.
 * @returns the merged manifest, or `undefined` when the capture failed.
 */
async function captureAfterAll(deps: ManageDeps, roots: readonly string[]): Promise<SnapshotEntry[] | undefined> {
	try {
		const captured = await Promise.all(roots.map((root) => captureManifest(deps, root, false)));
		return captured.flat();
	} catch (error) {
		console.error("skill_manage: after-capture failed (%s) — mutation unaffected", messageOf(error));
		return undefined;
	}
}

/**
 * Copy every existing touched skill aside before the batch mutates anything.
 *
 * This is the gating snapshot: if any copy fails, the batch aborts and — because
 * nothing has been written yet — no file was touched. A skill the batch is about
 * to create has nothing to copy; its rollback is the removal of the half-written
 * directory, which is why a non-existent source is recorded as `existed: false`
 * rather than treated as a snapshot failure.
 * @param deps - the snapshots directory and the skills root.
 * @param operations - the batch's operations.
 * @returns the snapshot, or the refusal message.
 */
async function snapshotTouched(
	deps: ManageDeps,
	operations: readonly Operation[],
): Promise<{ ok: true; snapshot: BatchSnapshot } | { ok: false; error: string }> {
	const root = join(deps.snapshotsDir, `.batch-${randomUUID()}`);
	const targets: SnapshotTarget[] = [];
	for (const name of [...new Set(operations.map((operation) => operation.name))]) {
		const source = join(deps.skillsRoot, name);
		const dest = join(root, name);
		const existed = await pathExists(source);
		targets.push({ name, source, dest, existed });
		if (!existed) continue;
		const captured = await atomicSnapshot(source, dest);
		if (!captured.ok) {
			await rm(root, { recursive: true, force: true }).catch(() => undefined);
			return { ok: false, error: captured.error };
		}
	}
	return { ok: true, snapshot: { root, targets } };
}

/**
 * Put every touched skill back the way the batch found it.
 *
 * Each captured skill is removed and recopied rather than merged, because a
 * merge would keep files a failed `write_file` added. A skill the batch created
 * is simply removed. Failures are collected instead of thrown: the caller
 * reports a partial rollback truthfully rather than claiming a clean undo.
 * @param snapshot - the batch's atomicity snapshot.
 * @returns `ok`, or which skills could not be restored.
 */
async function restoreSnapshot(snapshot: BatchSnapshot): Promise<{ ok: true } | { ok: false; error: string }> {
	const failures: string[] = [];
	for (const target of [...snapshot.targets].reverse()) {
		try {
			await rm(target.source, { recursive: true, force: true });
			if (target.existed) await cp(target.dest, target.source, { recursive: true });
		} catch (error) {
			failures.push(`'${target.name}' (${messageOf(error)})`);
		}
	}
	await discardSnapshot(snapshot);
	if (failures.length > 0) return { ok: false, error: `could not restore ${failures.join(", ")}` };
	return { ok: true };
}

/**
 * Drop a spent per-batch snapshot directory.
 *
 * Best effort: the batch is already decided by the time this runs, so a stray
 * copy must not turn a success into a failure. A failure is logged because it
 * leaks disk, not because anything is at risk.
 * @param snapshot - the batch's atomicity snapshot.
 */
async function discardSnapshot(snapshot: BatchSnapshot): Promise<void> {
	try {
		await rm(snapshot.root, { recursive: true, force: true });
	} catch (error) {
		console.error("skill_manage: could not remove the batch snapshot (%s) — batch unaffected", messageOf(error));
	}
}

/**
 * Read a skill's SKILL.md, or explain that the skill is not there.
 * @param deps - the skills root.
 * @param name - the skill name, already validated.
 * @returns the document text.
 * @throws when the file cannot be read.
 */
async function readSkillDocument(deps: ManageDeps, name: string): Promise<string> {
	try {
		return await readFile(join(deps.skillsRoot, name, "SKILL.md"), "utf8");
	} catch (error) {
		throw new Error(`skill '${name}' has no readable SKILL.md (${messageOf(error)})`);
	}
}

/**
 * Canonicalize a validated support path for the local filesystem.
 *
 * `validateSupportPath` accepts either separator and has already refused `..`
 * and absolute paths; joining a backslash-separated path on POSIX would create a
 * file with a backslash in its name, so the segments are rejoined with `/`.
 * @param rel - a path already accepted by `validateSupportPath`.
 * @returns the slash-joined relative path.
 */
function normalizeSupportPath(rel: string): string {
	return rel
		.split(/[\\/]+/)
		.filter((segment) => segment !== "" && segment !== ".")
		.join("/");
}

/**
 * @param path - a filesystem path.
 * @returns `true` when anything exists there.
 */
async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Shorten a value for an error message.
 * @param value - the text to show.
 * @returns the value, capped so one long `old_string` cannot flood the message.
 */
function preview(value: string): string {
	return value.length <= 80 ? value : `${value.slice(0, 77)}...`;
}

/**
 * @param error - an unknown throwable.
 * @returns its message, or the value rendered.
 */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
