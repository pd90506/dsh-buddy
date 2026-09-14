/**
 * The skill mutation ledger: what changed, by whom, and how to undo it.
 *
 * The ledger is **telemetry, not a gate**. Every write path here swallows and
 * logs its failures — {@link recordMutation}, {@link captureBefore} and
 * {@link listEntries} never throw — because a bookkeeping problem must never be
 * the reason a skill edit is refused. The one exception is {@link rollbackEntry},
 * which **fails closed**: it restores files, so every step before the first write
 * either completes or leaves the tree exactly as it found it.
 *
 * `before` and `after` are content-addressed manifests — `{ path, sha256 }`,
 * absolute paths, blobs named by their own digest in the snapshots directory —
 * so one mutation can be undone exactly and identical content is stored once.
 *
 * Ordering: entries sort `ts` descending, then `id` descending. Ids embed the
 * same timestamp plus a process-local monotonic sequence, so two entries written
 * inside the same millisecond still have a total order (the wall clock alone
 * cannot supply one); the trailing random suffix only breaks ties across
 * processes.
 * @module dsh-buddy/skills/ledger
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { KvTable } from "@deepseek-ai/dsh-storage-domain";
import type { SkillLedgerRecord } from "../store/domain.ts";
import { listSnapshotFiles, readBlob, storeBlob, type SnapshotEntry } from "./snapshot.ts";

/**
 * Everything the ledger helpers need, and nothing live.
 *
 * Deliberately a small plain object of real handles rather than a context or a
 * service: a test builds one from a temp directory plus the in-memory table
 * stub, with no cordis mounted. `home` is the store's resolved
 * `paths.home` — read from the store, never re-derived from settings, so a
 * relocated buddy home keeps working.
 */
export interface LedgerDeps {
	/** The buddy home root; every rollback path must resolve inside it. */
	readonly home: string;
	/** Content-addressed blob directory (`paths.skillSnapshots`). */
	readonly snapshotsDir: string;
	/** The mutation ledger table (`buddyStore.skillLedger()`). */
	readonly ledger: KvTable<string, SkillLedgerRecord>;
}

/** One mutation, as {@link recordMutation} receives it. */
export interface MutationInput {
	/** Who wrote: the curation pass, an automatic review, or a human. */
	actor: SkillLedgerRecord["actor"];
	/** What kind of mutation it was. */
	action: SkillLedgerRecord["action"];
	/** The skill the mutation belongs to. */
	skill: string;
	/** Anything worth keeping about the mutation; stored verbatim. */
	evidence?: Record<string, unknown> | undefined;
	/** The pre-mutation manifest, normally from {@link captureBefore}. */
	before?: SnapshotEntry[] | undefined;
	/** The root to manifest *after* the mutation; omit for a delete. */
	afterRoot?: string | undefined;
}

/** A manifest filter for {@link listEntries}. */
export interface LedgerFilter {
	/** Only entries for this skill. */
	skill?: string | undefined;
	/** At most this many entries, newest first. */
	limit?: number | undefined;
}

/** The actor a rollback is attributed to: the curation pass owns maintenance. */
const ROLLBACK_ACTOR: SkillLedgerRecord["actor"] = "curator";

/** Actions whose `before` may be incomplete and is topped up at rollback time. */
const TOP_UP_ACTIONS: readonly SkillLedgerRecord["action"][] = ["delete", "archive"];

/** The actor values the domain schema accepts, kept in step with it at compile time. */
const ACTORS = ["curator", "agent", "user"] as const satisfies readonly SkillLedgerRecord["actor"][];

/** The action values the domain schema accepts, kept in step with it at compile time. */
const ACTIONS = [
	"create",
	"edit",
	"patch",
	"delete",
	"write_file",
	"remove_file",
	"archive",
	"restore",
	"pre-rollback",
	"rollback",
] as const satisfies readonly SkillLedgerRecord["action"][];

/** Process-local sequence, zero-padded so lexicographic order is numeric order. */
let entrySequence = 0;

/**
 * Capture the current state of a skill before a mutation, best effort.
 *
 * **This is not a gate.** Every failure — an unreadable file, an unwritable
 * snapshot directory — is logged and answered with `undefined`, and the caller
 * carries on with the mutation. Only {@link rollbackEntry} fails closed.
 *
 * `completePackage: true` asks for a baseline that must be whole: the capture
 * then refuses to drop an entry it cannot read, because a partial baseline is
 * exactly the "empty shell" a later delete-rollback would restore. Without it,
 * an unreadable entry is skipped so the rest of the manifest survives.
 * @param deps - the home, the snapshot directory and the ledger table.
 * @param root - the directory to capture; `undefined` captures nothing.
 * @param options - `completePackage` for a strict baseline; `skill` names the
 * subject for the caller's own bookkeeping (the manifest needs no label).
 * @returns the manifest, or `undefined` when nothing could be captured.
 */
export async function captureBefore(
	deps: LedgerDeps,
	root: string | undefined,
	options: { completePackage?: boolean | undefined; skill?: string | undefined } = {},
): Promise<SnapshotEntry[] | undefined> {
	try {
		if (root === undefined) return [];
		return await captureManifest(deps, root, options.completePackage === true);
	} catch (error) {
		console.error("skill_ledger: before-capture failed (%s) — mutation unaffected", messageOf(error));
		return undefined;
	}
}

/**
 * Record one mutation in the ledger, best effort.
 *
 * Never throws and never rejects: the mutation has already happened by the time
 * this runs, so a ledger failure is logged and dropped. The `after` manifest is
 * captured from `afterRoot` when one is given, and an after-capture failure
 * simply leaves `after` empty rather than losing the entry.
 * @param deps - the home, the snapshot directory and the ledger table.
 * @param input - the actor, action, skill, evidence, `before` and `afterRoot`.
 */
export async function recordMutation(deps: LedgerDeps, input: MutationInput): Promise<void> {
	try {
		const ts = new Date().toISOString();
		let after: SnapshotEntry[] = [];
		if (input.afterRoot !== undefined) {
			try {
				after = await captureManifest(deps, input.afterRoot, false);
			} catch (error) {
				console.error("skill_ledger: after-capture failed (%s) — mutation unaffected", messageOf(error));
			}
		}
		const record: SkillLedgerRecord = {
			id: nextEntryId(ts),
			ts,
			actor: input.actor,
			action: input.action,
			skill: input.skill,
			evidence: input.evidence ?? {},
			before: ownManifest(input.before),
			after,
		};
		await deps.ledger.put(record.id, record);
	} catch (error) {
		console.error("skill_ledger: mutation record failed (%s) — mutation unaffected", messageOf(error));
	}
}

/**
 * List ledger entries, newest first.
 *
 * A malformed row is skipped rather than thrown: the ledger is telemetry, and
 * one corrupt record — a hand-edited store, a schema that drifted — must not be
 * able to break every reader. A failed iteration returns what was read so far.
 * @param deps - the home, the snapshot directory and the ledger table.
 * @param filter - optional skill name and result limit.
 * @returns the entries, newest first.
 */
export async function listEntries(deps: LedgerDeps, filter: LedgerFilter = {}): Promise<SkillLedgerRecord[]> {
	const found: SkillLedgerRecord[] = [];
	try {
		for (const [, value] of deps.ledger.entries()) {
			if (!isLedgerRecord(value)) continue;
			if (filter.skill !== undefined && value.skill !== filter.skill) continue;
			found.push(value);
		}
	} catch (error) {
		console.error("skill_ledger: ledger iteration failed (%s) — returning what was read", messageOf(error));
	}
	found.sort(newestFirst);
	return filter.limit === undefined ? found : found.slice(0, Math.max(0, filter.limit));
}

/**
 * Undo one ledger entry — the single fail-closed operation in this module.
 *
 * The order is the contract:
 *
 * 1. take the entry;
 * 2. refuse it unless every `before`/`after` path is inside the buddy home —
 *    a hand-edited ledger must not become an arbitrary-write primitive;
 * 3. for `delete` and `archive`, top `before` up from the most recent full
 *    snapshot, or the restore would produce an empty shell;
 * 4. precheck every `before` blob, aborting **with nothing changed** when one
 *    is missing;
 * 5. write the `pre-rollback` safety entry recording the current state, and
 *    abort if it cannot be written;
 * 6. restore every `before` file and delete the files that appear only in `after`;
 * 7. record the `rollback` entry.
 *
 * @param deps - the home, the snapshot directory and the ledger table.
 * @param entryId - the ledger key to undo.
 * @returns `ok` plus a message the caller can show; failures after step 6 say
 * the rollback was partial rather than pretending nothing happened.
 */
export async function rollbackEntry(deps: LedgerDeps, entryId: string): Promise<{ ok: boolean; message: string }> {
	const raw: unknown = deps.ledger.get(entryId);
	if (raw === undefined) return { ok: false, message: `no ledger entry '${entryId}'` };
	if (!isLedgerRecord(raw)) return { ok: false, message: `ledger entry '${entryId}' is malformed; refusing to roll it back` };
	const entry = raw;

	// Step 2: containment first, before anything is read or written, so an
	// escaping row can never even influence the top-up below.
	for (const item of [...entry.before, ...entry.after]) {
		const violation = await outsideHome(deps.home, item.path);
		if (violation !== undefined) return { ok: false, message: `rollback refused: ${violation}` };
	}

	// Step 3: a delete or archive may only have recorded part of the package.
	const before = TOP_UP_ACTIONS.includes(entry.action) ? await topUpBefore(deps, entry, entry.before) : entry.before;

	// Step 4: fail closed on a missing blob, having changed nothing so far.
	for (const item of before) {
		if ((await readBlob(deps.snapshotsDir, item.sha256)) === undefined) {
			return {
				ok: false,
				message: `rollback aborted, nothing was changed: snapshot blob ${item.sha256} for '${item.path}' is missing`,
			};
		}
	}

	// Step 5: record the state the restore is about to overwrite. Without this
	// entry there is no way back from a bad rollback, so failing to write it
	// aborts while the tree is still untouched.
	const affected = [...before.map((item) => item.path), ...entry.after.map((item) => item.path)];
	let current: SnapshotEntry[] = [];
	const safetyTs = new Date().toISOString();
	const safetyId = nextEntryId(safetyTs);
	try {
		current = await capturePaths(deps, affected);
		await deps.ledger.put(safetyId, {
			id: safetyId,
			ts: safetyTs,
			actor: ROLLBACK_ACTOR,
			action: "pre-rollback",
			skill: entry.skill,
			evidence: { rollbackOf: entry.id, was: entry.action },
			before: current,
			after: [],
		});
	} catch (error) {
		return {
			ok: false,
			message: `rollback aborted, nothing was changed: the pre-rollback entry could not be recorded (${messageOf(error)})`,
		};
	}

	// Step 6: restore, then remove what the original mutation added.
	let restored = 0;
	let removed = 0;
	try {
		for (const item of before) {
			const bytes = await readBlob(deps.snapshotsDir, item.sha256);
			if (bytes === undefined) {
				// The precheck passed a moment ago; only a concurrent prune gets here.
				return { ok: false, message: `rollback partially applied: snapshot blob ${item.sha256} vanished` };
			}
			await mkdir(dirname(item.path), { recursive: true });
			await writeFile(item.path, bytes);
			restored += 1;
		}
		const kept = new Set(before.map((item) => item.path));
		for (const item of entry.after) {
			if (kept.has(item.path)) continue;
			await rm(item.path, { force: true });
			removed += 1;
		}
	} catch (error) {
		return { ok: false, message: `rollback partially applied: ${messageOf(error)}` };
	}

	// Step 7: record the rollback itself, which can be rolled back in turn.
	const rollbackTs = new Date().toISOString();
	const rollbackId = nextEntryId(rollbackTs);
	let after: SnapshotEntry[] = ownManifest(before);
	try {
		after = await capturePaths(deps, before.map((item) => item.path));
	} catch {
		// Telemetry only: the intended state is a truthful `after` when the
		// restored files cannot be re-read.
	}
	try {
		await deps.ledger.put(rollbackId, {
			id: rollbackId,
			ts: rollbackTs,
			actor: ROLLBACK_ACTOR,
			action: "rollback",
			skill: entry.skill,
			evidence: { rollbackOf: entry.id, of: entry.action, restored, removed },
			before: current,
			after,
		});
	} catch (error) {
		return { ok: false, message: `rollback applied, but the rollback entry could not be recorded (${messageOf(error)})` };
	}
	return { ok: true, message: `restored ${restored} file(s) and removed ${removed} file(s) from '${entry.id}'` };
}

/**
 * Hash every file under a root and store each blob, in one pass.
 * @param deps - the snapshot directory.
 * @param root - the directory to capture.
 * @param completePackage - `true` refuses to drop an unreadable entry.
 * @returns the manifest, in sorted path order.
 */
async function captureManifest(deps: LedgerDeps, root: string, completePackage: boolean): Promise<SnapshotEntry[]> {
	const manifest: SnapshotEntry[] = [];
	for (const path of await listSnapshotFiles(root, completePackage ? "throw" : "skip")) {
		let bytes: Buffer;
		try {
			bytes = await readFile(path);
		} catch (error) {
			if (completePackage) throw error;
			console.error("skill_ledger: skipped '%s' (%s)", path, messageOf(error));
			continue;
		}
		// A manifest entry whose blob is absent is worse than no manifest at all:
		// rollback is fail-closed and would abort on it. So a blob failure fails
		// the whole capture instead of yielding an un-restorable manifest.
		manifest.push({ path, sha256: await storeBlob(deps.snapshotsDir, bytes) });
	}
	return manifest;
}

/**
 * Capture the current bytes of the named files, skipping those that are gone.
 * @param deps - the snapshot directory.
 * @param paths - the absolute file paths to capture.
 * @returns the manifest of the files that exist, in the given order.
 * @throws when an existing file cannot be read or stored.
 */
async function capturePaths(deps: LedgerDeps, paths: readonly string[]): Promise<SnapshotEntry[]> {
	const manifest: SnapshotEntry[] = [];
	const seen = new Set<string>();
	for (const path of paths) {
		if (seen.has(path)) continue;
		seen.add(path);
		let bytes: Buffer;
		try {
			bytes = await readFile(path);
		} catch {
			// Absent is a normal state here: the mutation may have removed it.
			continue;
		}
		manifest.push({ path, sha256: await storeBlob(deps.snapshotsDir, bytes) });
	}
	return manifest;
}

/**
 * Merge in the closest older full snapshot of the same skill.
 *
 * The newest older entry with a contained, non-empty `before` is the baseline;
 * an entry carrying `evidence.completePackage === true` wins over a newer
 * partial one, because a partial baseline is what the top-up exists to avoid.
 * @param deps - the ledger table and the home.
 * @param entry - the entry being rolled back.
 * @param before - its own manifest, possibly empty.
 * @returns `before` plus every baseline path it did not already name.
 */
async function topUpBefore(
	deps: LedgerDeps,
	entry: SkillLedgerRecord,
	before: readonly SnapshotEntry[],
): Promise<SnapshotEntry[]> {
	const known = new Set(before.map((item) => item.path));
	const candidates: SkillLedgerRecord[] = [];
	for (const candidate of await listEntries(deps, { skill: entry.skill })) {
		if (candidate.id === entry.id) continue;
		if (newestFirst(candidate, entry) <= 0) continue;
		if (candidate.before.length === 0) continue;
		if (!(await manifestInsideHome(deps.home, candidate.before))) continue;
		candidates.push(candidate);
	}
	const baseline = candidates.find((candidate) => candidate.evidence["completePackage"] === true) ?? candidates[0];
	if (baseline === undefined) return ownManifest(before);
	const added = baseline.before.filter((item) => !known.has(item.path)).map((item) => ({ path: item.path, sha256: item.sha256 }));
	return [...ownManifest(before), ...added];
}

/**
 * Whether every path in a manifest is inside the buddy home.
 * @param home - the buddy home root.
 * @param manifest - the manifest to check.
 * @returns `true` when all paths are contained.
 */
async function manifestInsideHome(home: string, manifest: readonly SnapshotEntry[]): Promise<boolean> {
	for (const item of manifest) {
		if ((await outsideHome(home, item.path)) !== undefined) return false;
	}
	return true;
}

/**
 * Decide whether one path escapes the buddy home.
 *
 * Three checks, because a ledger row is user-editable data and must not become
 * an arbitrary-write primitive: the resolved path must be lexically inside the
 * home, an existing final component must resolve inside it (a symlink named by
 * the row), and the nearest existing parent must resolve inside it (a symlinked
 * directory in the middle of the path).
 * @param home - the buddy home root.
 * @param target - the path a rollback would touch.
 * @returns the refusal reason, or `undefined` when the path is contained.
 */
async function outsideHome(home: string, target: string): Promise<string | undefined> {
	const homeRoot = resolve(home);
	const resolved = resolve(target);
	if (!inside(homeRoot, resolved)) return `'${target}' is outside the buddy home`;
	const realHome = await realpath(homeRoot).catch(() => homeRoot);
	const realTarget = await realpath(resolved).catch(() => undefined);
	if (realTarget !== undefined && !inside(realHome, realTarget)) {
		return `'${target}' is outside the buddy home (a link resolves out of it)`;
	}
	const parent = await nearestRealpath(dirname(resolved));
	if (parent !== undefined && !inside(realHome, join(parent, basename(resolved)))) {
		return `'${target}' is outside the buddy home (a link resolves out of it)`;
	}
	return undefined;
}

/**
 * Resolve the deepest existing ancestor of a path.
 * @param dir - the directory to start from.
 * @returns its real path, or `undefined` when nothing up to the filesystem root exists.
 */
async function nearestRealpath(dir: string): Promise<string | undefined> {
	let current = resolve(dir);
	for (;;) {
		const real = await realpath(current).catch(() => undefined);
		if (real !== undefined) return real;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

/**
 * @param parent - the candidate ancestor.
 * @param child - the candidate descendant.
 * @returns `true` when `child` sits strictly below `parent` (equal is not inside).
 */
function inside(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * The total order the ledger reports in: newest first.
 * @param a - one entry.
 * @param b - the other entry.
 * @returns negative when `a` is newer, positive when older, `0` when identical.
 */
function newestFirst(a: SkillLedgerRecord, b: SkillLedgerRecord): number {
	if (a.ts !== b.ts) return a.ts < b.ts ? 1 : -1;
	if (a.id === b.id) return 0;
	return a.id < b.id ? 1 : -1;
}

/**
 * Build a ledger key that sorts with its own timestamp.
 *
 * The wall clock cannot order two entries written in the same millisecond, so
 * the key carries a process-local monotonic sequence; the random suffix only
 * keeps keys unique across processes.
 * @param ts - the entry's ISO-8601 timestamp.
 * @returns the entry id.
 */
function nextEntryId(ts: string): string {
	entrySequence += 1;
	return `${ts}-${entrySequence.toString().padStart(9, "0")}-${randomUUID().slice(0, 8)}`;
}

/**
 * Copy a manifest into a small owned array.
 * @param manifest - the manifest, possibly absent.
 * @returns `{ path, sha256 }` objects with nothing else attached.
 */
function ownManifest(manifest: readonly SnapshotEntry[] | undefined): SnapshotEntry[] {
	return (manifest ?? []).map((item) => ({ path: item.path, sha256: item.sha256 }));
}

/**
 * Structural guard for a ledger row read back from storage.
 *
 * Hand-written rather than a runtime import of the domain module, so this file
 * stays a pure file/ledger helper; the `satisfies` clauses above keep the two
 * enums aligned with `SkillLedgerRecord` at compile time.
 * @param value - whatever storage returned.
 * @returns `true` when the value is a complete ledger row.
 */
function isLedgerRecord(value: unknown): value is SkillLedgerRecord {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	const actor = record["actor"];
	const action = record["action"];
	if (typeof actor !== "string" || !(ACTORS as readonly string[]).includes(actor)) return false;
	if (typeof action !== "string" || !(ACTIONS as readonly string[]).includes(action)) return false;
	const evidence = record["evidence"];
	if (typeof evidence !== "object" || evidence === null || Array.isArray(evidence)) return false;
	return (
		typeof record["id"] === "string" &&
		typeof record["ts"] === "string" &&
		typeof record["skill"] === "string" &&
		isManifest(record["before"]) &&
		isManifest(record["after"])
	);
}

/**
 * @param value - a candidate manifest.
 * @returns `true` when it is an array of `{ path, sha256 }` strings.
 */
function isManifest(value: unknown): value is { path: string; sha256: string }[] {
	if (!Array.isArray(value)) return false;
	return value.every((item: unknown) => {
		if (typeof item !== "object" || item === null) return false;
		const entry = item as Record<string, unknown>;
		return typeof entry["path"] === "string" && typeof entry["sha256"] === "string";
	});
}

/**
 * @param error - an unknown throwable.
 * @returns its message, or the value rendered.
 */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
