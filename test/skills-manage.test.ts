/**
 * Task 7: the six `skill_manage` actions and the batch-atomic executor.
 *
 * Three contracts carry the meaning here:
 *
 * 1. **A batch is atomic.** Any operation that fails restores every skill the
 *    batch already touched, so the observable state matches the pre-batch state
 *    — the first test is exactly that: a failure at index 1 puts index 0 back.
 * 2. **The two snapshots have opposite failure semantics.** The atomicity
 *    snapshot gates the batch (*no snapshot, no atomicity*), while the audit
 *    ledger is best effort and a ledger failure must never block a write.
 * 3. **Lint is advisory.** A create that trips lint rules still succeeds; the
 *    findings ride along on the tool result as `lint_warnings` / `lint_hint`.
 *
 * Every filesystem test uses a real temp directory — the point is real `fs`
 * behaviour, not a mock — and tears it down in `finally`. No test writes into
 * `~/.dsh`.
 * @module test/skills-manage
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { KvTable } from "@deepseek-ai/dsh-storage-domain";
import { listEntries, rollbackEntry } from "../src/skills/ledger.ts";
import { MAX_BATCH_OPERATIONS, runOperations, type ManageDeps } from "../src/skills/manage.ts";
import { recordCreated } from "../src/skills/usage.ts";
import type { SkillLedgerRecord, SkillUsageRecord } from "../src/store/domain.ts";
import { tableStub } from "./support/domain-tables.ts";

/** The one timestamp every fixture stamps, so nothing here depends on the wall clock. */
const NOW = "2026-09-13T00:00:00.000Z";

/**
 * @param value - text to hash.
 * @returns its lowercase hex sha256, the name a snapshot blob is stored under.
 */
function sha256Of(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

/**
 * Every entry under a snapshots directory, or `[]` when it does not exist yet.
 *
 * A refused batch must leave the directory empty: the guards run before any
 * snapshot work, so nothing — not a `.batch-*` copy, not a stray escaped copy —
 * may appear there.
 * @param snapshotsDir - the snapshots directory to list.
 * @returns its entry names.
 */
async function snapshotEntries(snapshotsDir: string): Promise<string[]> {
	try {
		return await readdir(snapshotsDir);
	} catch {
		return [];
	}
}

/**
 * A document that passes the write path's validation for `name`.
 *
 * The body deliberately contains the word `one`, because the atomicity test
 * patches `one` and then asserts the file is byte-identical after the rollback.
 * @param name - the skill name, which the frontmatter must echo.
 * @returns a valid SKILL.md.
 */
function validDoc(name: string): string {
	return `---\nname: ${name}\ndescription: helps with one thing\n---\n\n## When to Use\n\nUse this when one needs it.\n`;
}

/** A temp buddy home plus the handles a test drives through it. */
interface Fixture {
	/** The temp buddy home root. */
	readonly home: string;
	/** `<home>/main/skills`, where skill directories live. */
	readonly skillsRoot: string;
	/** The dependencies under test, with a frozen clock and a `user` actor. */
	readonly deps: ManageDeps;
	/** The usage table `deps` writes through. */
	readonly usage: KvTable<string, SkillUsageRecord>;
	/** The ledger table `deps` writes through. */
	readonly ledger: KvTable<string, SkillLedgerRecord>;
	/** Remove the temp home. */
	cleanup(): Promise<void>;
}

/**
 * Create one temp buddy home holding skills `a-b` and `c-d`.
 * @returns the fixture; the caller must `cleanup()` it in a `finally`.
 */
async function fixture(): Promise<Fixture> {
	const home = await mkdtemp(join(tmpdir(), "buddy-manage-"));
	const skillsRoot = join(home, "main", "skills");
	for (const name of ["a-b", "c-d"]) {
		await mkdir(join(skillsRoot, name), { recursive: true });
		await writeFile(join(skillsRoot, name, "SKILL.md"), validDoc(name));
	}
	const usage = tableStub<SkillUsageRecord>();
	const ledger = tableStub<SkillLedgerRecord>();
	return {
		home,
		skillsRoot,
		usage,
		ledger,
		deps: {
			home,
			snapshotsDir: join(skillsRoot, ".snapshots"),
			ledger,
			skillsRoot,
			usage,
			actor: () => "user",
			now: () => NOW,
			// These fixtures are foreground callers: every write is in
			// jurisdiction, so the guard allows unconditionally. The review's
			// restrictions are exercised in `skills-guards.test.ts`.
			guard: () => ({ allow: true }),
		},
		cleanup: () => rm(home, { recursive: true, force: true }),
	};
}

test("a batch is atomic: a failure at index 1 restores index 0", async () => {
	const f = await fixture();
	try {
		const before = await readFile(join(f.skillsRoot, "a-b", "SKILL.md"), "utf8");
		const result = await runOperations(f.deps, [
			{ action: "patch", name: "a-b", old_string: "one", new_string: "two" },
			{ action: "patch", name: "c-d", old_string: "absent", new_string: "x" },
		]);
		assert.equal(result.success, false);
		assert.equal(result.failed_index, 1);
		assert.equal(result.completed_before_failure, 1);
		assert.equal(await readFile(join(f.skillsRoot, "a-b", "SKILL.md"), "utf8"), before);
	} finally {
		await f.cleanup();
	}
});

test("create refuses an existing name and validates the document first", async () => {
	const f = await fixture();
	try {
		const exists = await runOperations(f.deps, [{ action: "create", name: "a-b", content: validDoc("a-b") }]);
		assert.equal(exists.success, false);
		assert.match(String(exists.error), /already exists/);
		const bad = await runOperations(f.deps, [{ action: "create", name: "a-b", content: "---\nname: a-b\n---\n" }]);
		assert.equal(bad.success, false);
	} finally {
		await f.cleanup();
	}
});

test("a create returns advisory lint findings without failing", async () => {
	const f = await fixture();
	try {
		const result = await runOperations(f.deps, [
			{ action: "create", name: "e-f", content: "---\nname: e-f\ndescription: robust helper\n---\nno heading here\n" },
		]);
		assert.equal(result.success, true);
		const first = result.results[0] as { lint_warnings?: unknown[]; lint_hint?: string };
		assert.ok(Array.isArray(first.lint_warnings) && first.lint_warnings.length > 0);
		assert.match(String(first.lint_hint), /not blockers/);
	} finally {
		await f.cleanup();
	}
});

test("delete must be the sole operation in its call", async () => {
	const f = await fixture();
	try {
		const before = await readFile(join(f.skillsRoot, "a-b", "SKILL.md"), "utf8");
		const result = await runOperations(f.deps, [
			{ action: "delete", name: "a-b" },
			{ action: "patch", name: "c-d", old_string: "x", new_string: "y" },
		]);
		assert.equal(result.success, false);
		assert.match(String(result.error), /compose with other ops/);
		// The guards run before any snapshot or filesystem work: the skill is
		// intact AND the snapshots directory was never even created. A reordering
		// that snapshotted first would leave a `.batch-*` copy behind.
		assert.equal(await readFile(join(f.skillsRoot, "a-b", "SKILL.md"), "utf8"), before);
		assert.deepEqual(await snapshotEntries(f.deps.snapshotsDir), []);
	} finally {
		await f.cleanup();
	}
});

test("more than 20 operations is refused", async () => {
	const f = await fixture();
	try {
		const ops = Array.from({ length: MAX_BATCH_OPERATIONS + 1 }, () => ({
			action: "patch" as const,
			name: "a-b",
			old_string: "x",
			new_string: "y",
		}));
		const result = await runOperations(f.deps, ops);
		assert.equal(result.success, false);
		assert.match(String(result.error), /20/);
		// Refused before any snapshot work, so nothing was copied aside.
		assert.deepEqual(await snapshotEntries(f.deps.snapshotsDir), []);
	} finally {
		await f.cleanup();
	}
});

test("an empty batch is refused", async () => {
	const f = await fixture();
	try {
		const result = await runOperations(f.deps, []);
		assert.equal(result.success, false);
		assert.match(String(result.error), /no operations/);
		assert.deepEqual(result.results, []);
	} finally {
		await f.cleanup();
	}
});

test("an unsafe skill name cannot reach outside the skills root", async () => {
	const f = await fixture();
	try {
		// The guard's real job: a name-derived path is what `snapshotTouched`
		// copies and what `restoreSnapshot` rm -rf's, so `../a-b` must never be
		// able to name a real directory above the skills root. The fixture
		// deliberately puts one there, with a sentinel inside it.
		const outside = join(f.home, "main", "a-b");
		await mkdir(outside, { recursive: true });
		await writeFile(join(outside, "keep.md"), "sentinel");

		const result = await runOperations(f.deps, [{ action: "delete", name: "../a-b" }]);
		assert.equal(result.success, false);
		assert.match(String(result.error), /lowercase letters, digits and hyphens/);
		assert.equal(await readFile(join(outside, "keep.md"), "utf8"), "sentinel");
		assert.equal(await readFile(join(f.skillsRoot, "a-b", "SKILL.md"), "utf8"), validDoc("a-b"));
		// Nothing was copied aside either — not under `.batch-*`, and not a
		// stray copy at the escaped destination.
		assert.deepEqual(await snapshotEntries(f.deps.snapshotsDir), []);
	} finally {
		await f.cleanup();
	}
});

test("a batch that creates a skill leaves no trace of it when a later operation fails", async () => {
	const f = await fixture();
	try {
		const before = await readFile(join(f.skillsRoot, "c-d", "SKILL.md"), "utf8");
		const result = await runOperations(f.deps, [
			{ action: "create", name: "g-h", content: validDoc("g-h") },
			{ action: "patch", name: "c-d", old_string: "absent", new_string: "x" },
		]);
		assert.equal(result.success, false);
		assert.equal(result.failed_index, 1);
		// The created skill had no pre-batch state, so the restore removes the
		// half-written directory rather than copying anything back over it.
		await assert.rejects(() => stat(join(f.skillsRoot, "g-h")));
		assert.equal(await readFile(join(f.skillsRoot, "c-d", "SKILL.md"), "utf8"), before);
	} finally {
		await f.cleanup();
	}
});

test("delete removes the skill and records no patch telemetry", async () => {
	const f = await fixture();
	try {
		const result = await runOperations(f.deps, [{ action: "delete", name: "c-d" }]);
		assert.equal(result.success, true);
		await assert.rejects(() => stat(join(f.skillsRoot, "c-d")));
		assert.equal(f.usage.get("c-d"), undefined);
		const entries = await listEntries(f.deps);
		assert.equal(entries.length, 1);
		assert.equal(entries[0]!.action, "delete");
		assert.equal(entries[0]!.skill, "c-d");
		assert.ok(entries[0]!.before.length > 0);
	} finally {
		await f.cleanup();
	}
});

test("delete of a missing skill is refused", async () => {
	const f = await fixture();
	try {
		const result = await runOperations(f.deps, [{ action: "delete", name: "z-z" }]);
		assert.equal(result.success, false);
		assert.match(String(result.error), /does not exist/);
	} finally {
		await f.cleanup();
	}
});

test("edit, write_file and remove_file bump the patch counters", async () => {
	const f = await fixture();
	try {
		await runOperations(f.deps, [{ action: "edit", name: "a-b", content: validDoc("a-b") }]);
		await runOperations(f.deps, [
			{ action: "write_file", name: "a-b", file_path: "references/notes.md", content: "hello" },
		]);
		assert.equal(await readFile(join(f.skillsRoot, "a-b", "references", "notes.md"), "utf8"), "hello");
		await runOperations(f.deps, [{ action: "remove_file", name: "a-b", file_path: "references/notes.md" }]);
		await assert.rejects(() => stat(join(f.skillsRoot, "a-b", "references", "notes.md")));
		const record = f.usage.get("a-b")!;
		assert.equal(record.patch_count, 3);
		assert.equal(record.patch_generation, 3);
		assert.equal(record.last_patched_at, NOW);
		// A create was never recorded, so the seeded row keeps null provenance.
		assert.equal(record.created_by, null);
	} finally {
		await f.cleanup();
	}
});

test("write_file refuses an escaping path, a disallowed directory and an oversized file", async () => {
	const f = await fixture();
	try {
		const escape = await runOperations(f.deps, [
			{ action: "write_file", name: "a-b", file_path: "../outside.md", content: "x" },
		]);
		assert.equal(escape.success, false);
		assert.match(String(escape.error), /must not contain '\.\.'/);

		const wrongDir = await runOperations(f.deps, [
			{ action: "write_file", name: "a-b", file_path: "other/x.md", content: "x" },
		]);
		assert.equal(wrongDir.success, false);
		assert.match(String(wrongDir.error), /references, templates, scripts, assets/);

		const huge = await runOperations(f.deps, [
			{ action: "write_file", name: "a-b", file_path: "assets/big.bin", content: "x".repeat(1_048_577) },
		]);
		assert.equal(huge.success, false);
		assert.match(String(huge.error), /1048576/);

		// None of the refusals wrote anything, including the escaping one.
		await assert.rejects(() => stat(join(f.skillsRoot, "outside.md")));
	} finally {
		await f.cleanup();
	}
});

test("remove_file of an absent support file is refused", async () => {
	const f = await fixture();
	try {
		const result = await runOperations(f.deps, [
			{ action: "remove_file", name: "a-b", file_path: "references/gone.md" },
		]);
		assert.equal(result.success, false);
		assert.match(String(result.error), /does not exist/);
	} finally {
		await f.cleanup();
	}
});

test("patch needs old_string and refuses a missing skill", async () => {
	const f = await fixture();
	try {
		const missing = await runOperations(f.deps, [{ action: "patch", name: "a-b", new_string: "x" }]);
		assert.equal(missing.success, false);
		assert.match(String(missing.error), /old_string/);

		const absentSkill = await runOperations(f.deps, [
			{ action: "patch", name: "z-z", old_string: "x", new_string: "y" },
		]);
		assert.equal(absentSkill.success, false);
		assert.match(String(absentSkill.error), /SKILL\.md/);
	} finally {
		await f.cleanup();
	}
});

test("a create stamps usage provenance from the declared actor", async () => {
	const f = await fixture();
	try {
		const deps: ManageDeps = { ...f.deps, actor: () => "agent" };
		const result = await runOperations(deps, [{ action: "create", name: "g-h", content: validDoc("g-h") }]);
		assert.equal(result.success, true);
		const record = f.usage.get("g-h")!;
		assert.equal(record.created_by, "agent");
		assert.equal(record.created_at, NOW);
		// A create resets the record and does not count as a patch.
		assert.equal(record.patch_count, 0);
		assert.equal(record.patch_generation, 0);
	} finally {
		await f.cleanup();
	}
});

test("a failing atomic snapshot aborts the batch before any file changes", async () => {
	const f = await fixture();
	try {
		// A regular file where the snapshot directory belongs: `cp` cannot create
		// the per-batch destination under it, so the gating snapshot fails. This
		// is the asymmetry the spec insists on — this failure aborts the batch.
		const blocked = join(f.skillsRoot, "blocked");
		await writeFile(blocked, "not a directory");
		const deps: ManageDeps = { ...f.deps, snapshotsDir: blocked };
		const before = await readFile(join(f.skillsRoot, "a-b", "SKILL.md"), "utf8");
		const result = await runOperations(deps, [{ action: "patch", name: "a-b", old_string: "one", new_string: "two" }]);
		assert.equal(result.success, false);
		assert.match(String(result.error), /no snapshot, no atomicity/);
		assert.equal(result.failed_index, undefined);
		assert.equal(await readFile(join(f.skillsRoot, "a-b", "SKILL.md"), "utf8"), before);
	} finally {
		await f.cleanup();
	}
});

test("a failing audit ledger never blocks the write", async () => {
	const f = await fixture();
	const logged = console.error;
	console.error = () => undefined;
	try {
		const ledger: KvTable<string, SkillLedgerRecord> = {
			...tableStub<SkillLedgerRecord>(),
			put: async () => {
				throw new Error("ledger write failed");
			},
		};
		const deps: ManageDeps = { ...f.deps, ledger };
		const result = await runOperations(deps, [{ action: "patch", name: "a-b", old_string: "one", new_string: "two" }]);
		assert.equal(result.success, true);
		assert.match(await readFile(join(f.skillsRoot, "a-b", "SKILL.md"), "utf8"), /two/);
	} finally {
		console.error = logged;
		await f.cleanup();
	}
});

test("a failing audit capture never blocks the write", async () => {
	const f = await fixture();
	const logged = console.error;
	console.error = () => undefined;
	try {
		// Blobs are named by the sha256 of their own bytes, so pre-creating a
		// *directory* at a digest makes `storeBlob`'s rename fail for exactly the
		// content whose capture should fail — and for no other content. That is
		// the seam that lets the audit captures fail while the gating atomicity
		// snapshot (which copies the directory, no blobs involved) still succeeds.
		const original = validDoc("a-b");
		const patched = original.split("one").join("two");

		// The `before` capture fails, and the write still lands.
		await mkdir(join(f.deps.snapshotsDir, sha256Of(original)), { recursive: true });
		const beforeFailed = await runOperations(f.deps, [
			{ action: "patch", name: "a-b", old_string: "one", new_string: "two" },
		]);
		assert.equal(beforeFailed.success, true);
		assert.equal(await readFile(join(f.skillsRoot, "a-b", "SKILL.md"), "utf8"), patched);

		// And the `after` capture fails, with the same outcome. Both digests must
		// be free first: part one left a directory at the original digest and
		// stored the patched bytes as a blob.
		await writeFile(join(f.skillsRoot, "a-b", "SKILL.md"), original);
		await rm(join(f.deps.snapshotsDir, sha256Of(original)), { recursive: true, force: true });
		await rm(join(f.deps.snapshotsDir, sha256Of(patched)), { recursive: true, force: true });
		await mkdir(join(f.deps.snapshotsDir, sha256Of(patched)), { recursive: true });
		const afterFailed = await runOperations(f.deps, [
			{ action: "patch", name: "a-b", old_string: "one", new_string: "two" },
		]);
		assert.equal(afterFailed.success, true);
		assert.equal(await readFile(join(f.skillsRoot, "a-b", "SKILL.md"), "utf8"), patched);

		// The two failures are visible in the ledger as missing manifests — and
		// neither one cost the write, which is the best-effort contract.
		const entries = await listEntries(f.deps);
		assert.equal(entries.length, 2);
		assert.deepEqual(entries[0]!.after, []);
		assert.deepEqual(
			entries[0]!.before.map((item) => item.path),
			[join(f.skillsRoot, "a-b", "SKILL.md")],
		);
		assert.deepEqual(entries[1]!.before, []);
		assert.deepEqual(
			entries[1]!.after.map((item) => item.path),
			[join(f.skillsRoot, "a-b", "SKILL.md")],
		);
	} finally {
		console.error = logged;
		await f.cleanup();
	}
});

test("a successful batch records one ledger entry with the merged per-skill before", async () => {
	const f = await fixture();
	try {
		const result = await runOperations(f.deps, [
			{ action: "patch", name: "a-b", old_string: "one", new_string: "two" },
			{ action: "patch", name: "c-d", old_string: "one", new_string: "two" },
		]);
		assert.equal(result.success, true);
		const entries = await listEntries(f.deps);
		assert.equal(entries.length, 1);
		assert.equal(entries[0]!.actor, "user");
		// `skill`/`action` are the entry's primary pair — the first operation —
		// and `evidence.operations` is the whole call, in order, so a multi-skill
		// batch is not recorded as if it only touched `a-b`.
		assert.equal(entries[0]!.action, "patch");
		assert.equal(entries[0]!.skill, "a-b");
		assert.deepEqual(entries[0]!.evidence["operations"], [
			{ action: "patch", name: "a-b" },
			{ action: "patch", name: "c-d" },
		]);
		assert.deepEqual(
			entries[0]!.before.map((item) => item.path).sort(),
			[join(f.skillsRoot, "a-b", "SKILL.md"), join(f.skillsRoot, "c-d", "SKILL.md")].sort(),
		);
	} finally {
		await f.cleanup();
	}
});

test("rolling back a batch touches only the skills it mutated", async () => {
	const f = await fixture();
	try {
		const siblingBefore = await readFile(join(f.skillsRoot, "c-d", "SKILL.md"), "utf8");
		const result = await runOperations(f.deps, [
			{ action: "patch", name: "a-b", old_string: "one", new_string: "two" },
		]);
		assert.equal(result.success, true);
		const [entry] = await listEntries(f.deps);
		assert.ok(entry);
		// The after manifest names the mutated skill and nothing else. A
		// whole-root capture would sweep in the sibling and the snapshot blobs,
		// so `rollbackEntry` would remove and rewrite files this batch never
		// touched.
		assert.deepEqual(
			entry.after.map((item) => item.path),
			[join(f.skillsRoot, "a-b", "SKILL.md")],
		);

		const rolled = await rollbackEntry(f.deps, entry.id);
		assert.equal(rolled.ok, true);
		// The sibling was never named, so it cannot have been removed and
		// restored — its bytes are exactly the ones the batch found.
		assert.equal(await readFile(join(f.skillsRoot, "c-d", "SKILL.md"), "utf8"), siblingBefore);
		assert.equal(await readFile(join(f.skillsRoot, "a-b", "SKILL.md"), "utf8"), validDoc("a-b"));
	} finally {
		await f.cleanup();
	}
});

test("a batch's before and after cover the same touched roots", async () => {
	const f = await fixture();
	try {
		const result = await runOperations(f.deps, [
			{ action: "patch", name: "a-b", old_string: "one", new_string: "two" },
			{ action: "write_file", name: "c-d", file_path: "references/notes.md", content: "note" },
		]);
		assert.equal(result.success, true);
		const [entry] = await listEntries(f.deps);
		assert.ok(entry);
		// A mixed batch records both operations, with their own actions, in order.
		assert.deepEqual(entry.evidence["operations"], [
			{ action: "patch", name: "a-b" },
			{ action: "write_file", name: "c-d" },
		]);
		assert.deepEqual(
			entry.before.map((item) => item.path).sort(),
			[join(f.skillsRoot, "a-b", "SKILL.md"), join(f.skillsRoot, "c-d", "SKILL.md")].sort(),
		);
		// The file the batch created in the *second* skill is in `after`, so a
		// rollback removes it — a first-root-only after manifest would leave it.
		assert.deepEqual(
			entry.after.map((item) => item.path).sort(),
			[
				join(f.skillsRoot, "a-b", "SKILL.md"),
				join(f.skillsRoot, "c-d", "SKILL.md"),
				join(f.skillsRoot, "c-d", "references", "notes.md"),
			].sort(),
		);

		const rolled = await rollbackEntry(f.deps, entry.id);
		assert.equal(rolled.ok, true);
		await assert.rejects(() => stat(join(f.skillsRoot, "c-d", "references", "notes.md")));
		assert.equal(await readFile(join(f.skillsRoot, "a-b", "SKILL.md"), "utf8"), validDoc("a-b"));
	} finally {
		await f.cleanup();
	}
});

test("a created skill lives in after, not before, so its batch rolls back", async () => {
	const f = await fixture();
	try {
		const result = await runOperations(f.deps, [{ action: "create", name: "g-h", content: validDoc("g-h") }]);
		assert.equal(result.success, true);
		const [entry] = await listEntries(f.deps);
		assert.ok(entry);
		// Create/delete are the asymmetry the two snapshots exist for: a created
		// skill has no prior state, and its manifest is what removes it again.
		assert.deepEqual(entry.before, []);
		assert.deepEqual(
			entry.after.map((item) => item.path),
			[join(f.skillsRoot, "g-h", "SKILL.md")],
		);

		const rolled = await rollbackEntry(f.deps, entry.id);
		assert.equal(rolled.ok, true);
		await assert.rejects(() => stat(join(f.skillsRoot, "g-h", "SKILL.md")));
		assert.equal(await readFile(join(f.skillsRoot, "a-b", "SKILL.md"), "utf8"), validDoc("a-b"));
	} finally {
		await f.cleanup();
	}
});

test("recordCreated never rejects, so a broken usage table cannot fail a create", async () => {
	const f = await fixture();
	const logged = console.error;
	const lines: string[] = [];
	console.error = (...parts: unknown[]) => {
		lines.push(parts.map(String).join(" "));
	};
	try {
		const usage: KvTable<string, SkillUsageRecord> = {
			...tableStub<SkillUsageRecord>(),
			put: async () => {
				throw new Error("storage write failed");
			},
		};
		const deps: ManageDeps = { ...f.deps, usage };
		await assert.doesNotReject(() => recordCreated(usage, "a-b", { agentCreated: true, now: NOW }));
		const result = await runOperations(deps, [{ action: "create", name: "g-h", content: validDoc("g-h") }]);
		assert.equal(result.success, true);
	} finally {
		console.error = logged;
		await f.cleanup();
	}
	// One line per failed telemetry write, on the module's own prefix shape:
	// logged, and the write unaffected. Nothing else is logged — in particular
	// the create no longer captures its own not-yet-existing `before` root, so
	// the spurious "before-capture failed" line is gone too.
	const telemetry = lines.filter((line) => line.startsWith("skill_usage: recordCreated"));
	assert.equal(telemetry.length, 2);
	assert.equal(lines.length, telemetry.length);
	for (const line of telemetry) assert.match(line, /^skill_usage: recordCreated\('%s'\) failed/);
});
