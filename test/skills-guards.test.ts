/**
 * Task 8: jurisdiction over the write path — who may write which skill at all.
 *
 * One rule carries the meaning, with three teeth:
 *
 * 1. **The review curates only what it created.** A skill the human made
 *    (`created_by: null`) is refused, and the refusal names `adopt`, the
 *    explicit hand-over.
 * 2. **Pinned is absolute.** Whatever the provenance, a pinned skill is never
 *    touched by the review.
 * 3. **Read before write.** A review must have loaded a skill before it may
 *    modify it; `create` has nothing prior to have read, so it needs no marker,
 *    and the foreground has no jurisdiction restriction at all.
 *
 * The last block goes **through `runOperations`** rather than calling the guard
 * directly: the guard is injected as `ManageDeps.guard`, so a correct predicate
 * is not by itself evidence that the write path consults it.
 *
 * Every filesystem test uses a real temp directory and tears it down in
 * `finally`. No test writes into `~/.dsh`.
 * @module test/skills-guards
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { KvTable } from "@deepseek-ai/dsh-storage-domain";
import { backgroundWriteGuard, isCuratorManaged, markRead, resetReadSet, type GuardRecord } from "../src/skills/guards.ts";
import { runOperations, type ManageDeps } from "../src/skills/manage.ts";
import { emptyUsageRecord, type SkillLedgerRecord, type SkillUsageRecord } from "../src/store/domain.ts";
import { tableStub } from "./support/domain-tables.ts";

/** The one timestamp every fixture stamps, so nothing here depends on the wall clock. */
const NOW = "2026-09-13T00:00:00.000Z";

/**
 * A document that passes the write path's validation for `name`.
 *
 * The body contains the word `one` on purpose: the wiring tests patch `one`, so
 * a refusal that still touched the file is visible in its bytes.
 * @param name - the skill name, which the frontmatter must echo.
 * @returns a valid SKILL.md.
 */
function validDoc(name: string): string {
	return `---\nname: ${name}\ndescription: helps with one thing\n---\n\n## When to Use\n\nUse this when one needs it.\n`;
}

/** A review caller's dependencies, plus the host-row state its guard closes over. */
interface ReviewDeps extends ManageDeps {
	/** Every review's read set, keyed by sub-session id. */
	readonly readSets: Map<string, Set<string>>;
	/** The review sub-session's id. */
	readonly sessionId: string;
	/** Remove the temp home. */
	cleanup(): Promise<void>;
}

/**
 * Build a `ManageDeps` whose `guard` is the real one, wired the way the host row
 * wires it: the closure holds whether this call comes from a review, the target
 * skill's `skill_usage` row and this review's read set, and delegates the
 * verdict to {@link backgroundWriteGuard}. That closure is the whole point of
 * the seam — `manage.ts` never learns where provenance comes from.
 * @param record - the seed usage row for skill `a-b`, or `undefined` for none.
 * @param options - `pinned` overrides the seed row's pin flag, `read` seeds the
 * read set, and `reviewSession: false` makes the caller the foreground.
 * @returns the deps; the caller must `cleanup()` them in a `finally`.
 */
function reviewDeps(
	record: GuardRecord | undefined,
	options: { pinned?: boolean; read?: readonly string[]; reviewSession?: boolean } = {},
): ReviewDeps {
	const home = mkdtempSync(join(tmpdir(), "buddy-guards-"));
	const skillsRoot = join(home, "main", "skills");
	for (const name of ["a-b", "c-d"]) {
		mkdirSync(join(skillsRoot, name), { recursive: true });
		writeFileSync(join(skillsRoot, name, "SKILL.md"), validDoc(name));
	}
	const usage: KvTable<string, SkillUsageRecord> = tableStub<SkillUsageRecord>();
	if (record !== undefined) {
		void usage.put("a-b", { ...emptyUsageRecord(NOW), ...record, pinned: options.pinned ?? record.pinned ?? false });
	}
	const ledger: KvTable<string, SkillLedgerRecord> = tableStub<SkillLedgerRecord>();
	const sessionId = "review-1";
	const reviewSession = options.reviewSession ?? true;
	const readSets = new Map<string, Set<string>>([[sessionId, new Set(options.read ?? [])]]);
	return {
		home,
		snapshotsDir: join(skillsRoot, ".snapshots"),
		ledger,
		skillsRoot,
		usage,
		actor: () => (reviewSession ? "agent" : "user"),
		now: () => NOW,
		guard: (action, skill) =>
			backgroundWriteGuard({
				reviewSession,
				record: usage.get(skill),
				pinned: usage.get(skill)?.pinned ?? false,
				action,
				skill,
				readSet: readSets.get(sessionId) ?? new Set<string>(),
			}),
		readSets,
		sessionId,
		cleanup: () => rm(home, { recursive: true, force: true }),
	};
}

test("only an agent-created record is curator-managed", () => {
	assert.equal(isCuratorManaged({ created_by: "agent" }), true);
	assert.equal(isCuratorManaged({ created_by: null }), false);
	assert.equal(isCuratorManaged({}), false);
	assert.equal(isCuratorManaged(undefined), false);
});

test("an automatic review may not touch a skill the human created", () => {
	const verdict = backgroundWriteGuard({ reviewSession: true, record: { created_by: null, pinned: false }, pinned: false, action: "patch", skill: "a-b", readSet: new Set(["a-b"]) });
	assert.equal(verdict.allow, false);
	assert.match(verdict.allow === false ? verdict.reason : "", /not curator-managed/);
	assert.match(verdict.allow === false ? verdict.reason : "", /adopt/);
});

test("a pinned skill is refused even when managed", () => {
	const verdict = backgroundWriteGuard({ reviewSession: true, record: { created_by: "agent", pinned: true }, pinned: true, action: "patch", skill: "a-b", readSet: new Set(["a-b"]) });
	assert.equal(verdict.allow, false);
	assert.match(verdict.allow === false ? verdict.reason : "", /pinned/);
});

test("read-before-write applies only to the review and only to the target", () => {
	const managed = { created_by: "agent", pinned: false };
	const forgetful = backgroundWriteGuard({ reviewSession: true, record: managed, pinned: false, action: "patch", skill: "a-b", readSet: new Set() });
	assert.equal(forgetful.allow, false);
	assert.match(forgetful.allow === false ? forgetful.reason : "", /read/i);
	const foreground = backgroundWriteGuard({ reviewSession: false, record: { created_by: null, pinned: false }, pinned: false, action: "patch", skill: "a-b", readSet: new Set() });
	assert.equal(foreground.allow, true);
});

test("read-before-write covers patch, edit, write_file and remove_file", () => {
	for (const action of ["patch", "edit", "write_file", "remove_file"] as const) {
		const verdict = backgroundWriteGuard({ reviewSession: true, record: { created_by: "agent", pinned: false }, pinned: false, action, skill: "a-b", readSet: new Set() });
		assert.equal(verdict.allow, false, `${action} must need a read marker`);
		assert.match(verdict.allow === false ? verdict.reason : "", /read/i);
	}
});

test("a read marker for one skill does not license another", () => {
	const verdict = backgroundWriteGuard({ reviewSession: true, record: { created_by: "agent", pinned: false }, pinned: false, action: "patch", skill: "a-b", readSet: new Set(["c-d"]) });
	assert.equal(verdict.allow, false);
	assert.match(verdict.allow === false ? verdict.reason : "", /read/i);
});

test("a review may create a skill it has not read", () => {
	const fresh = backgroundWriteGuard({ reviewSession: true, record: undefined, pinned: false, action: "create", skill: "brand-new", readSet: new Set() });
	assert.equal(fresh.allow, true);
});

test("pinned outranks provenance and the read marker", () => {
	const verdict = backgroundWriteGuard({ reviewSession: true, record: { created_by: "agent", pinned: true }, pinned: true, action: "patch", skill: "a-b", readSet: new Set(["a-b"]) });
	assert.equal(verdict.allow, false);
	assert.match(verdict.allow === false ? verdict.reason : "", /pinned/);
});

test("markRead is per review session and idempotent; resetReadSet forgets one session", () => {
	const readSets = new Map<string, Set<string>>();
	markRead(readSets, "review-1", "a-b");
	markRead(readSets, "review-1", "a-b");
	markRead(readSets, "review-1", "c-d");
	markRead(readSets, "review-2", "e-f");
	assert.deepEqual([...readSets.get("review-1")!].sort(), ["a-b", "c-d"]);
	assert.deepEqual([...readSets.get("review-2")!], ["e-f"]);

	resetReadSet(readSets, "review-1");
	assert.equal(readSets.has("review-1"), false);
	// The other review's reads are untouched, and forgetting an unknown review
	// is a no-op rather than an error.
	assert.deepEqual([...readSets.get("review-2")!], ["e-f"]);
	resetReadSet(readSets, "review-3");
	assert.equal(readSets.size, 1);
});

test("runOperations refuses an unmanaged skill for a review caller", async () => {
	const deps = reviewDeps({ created_by: null });
	try {
		const result = await runOperations(deps, [
			{ action: "patch", name: "a-b", old_string: "one", new_string: "two" },
		]);
		assert.equal(result.success, false);
		assert.match(String(result.error), /not curator-managed/);
		// The refusal is the first thing `applyOne` does, so the file still holds
		// the pre-batch bytes.
		assert.match(await readFile(join(deps.skillsRoot, "a-b", "SKILL.md"), "utf8"), /one/);
	} finally {
		await deps.cleanup();
	}
});

test("runOperations refuses a pinned skill for a review caller", async () => {
	const deps = reviewDeps({ created_by: "agent" }, { pinned: true, read: ["a-b"] });
	try {
		const result = await runOperations(deps, [
			{ action: "patch", name: "a-b", old_string: "one", new_string: "two" },
		]);
		assert.equal(result.success, false);
		assert.match(String(result.error), /pinned/);
	} finally {
		await deps.cleanup();
	}
});

test("runOperations refuses a managed skill the review has not read, then allows it after markRead", async () => {
	const deps = reviewDeps({ created_by: "agent" });
	try {
		const refused = await runOperations(deps, [
			{ action: "patch", name: "a-b", old_string: "one", new_string: "two" },
		]);
		assert.equal(refused.success, false);
		assert.match(String(refused.error), /read/i);

		// The read set is host-row state the passthrough guard consults; marking
		// the read is what turns the same call into an allowed one.
		markRead(deps.readSets, deps.sessionId, "a-b");
		const allowed = await runOperations(deps, [
			{ action: "patch", name: "a-b", old_string: "one", new_string: "two" },
		]);
		assert.equal(allowed.success, true);
		assert.match(await readFile(join(deps.skillsRoot, "a-b", "SKILL.md"), "utf8"), /two/);
	} finally {
		await deps.cleanup();
	}
});

test("runOperations lets a review create a brand-new skill without a read marker", async () => {
	const deps = reviewDeps({ created_by: null });
	try {
		const result = await runOperations(deps, [{ action: "create", name: "g-h", content: validDoc("g-h") }]);
		assert.equal(result.success, true);
		// The create is what stamps the provenance the *next* review's guard reads.
		assert.equal(deps.usage.get("g-h")?.created_by, "agent");
	} finally {
		await deps.cleanup();
	}
});

test("a foreground caller is never refused by the review's jurisdiction", async () => {
	const deps = reviewDeps({ created_by: null }, { reviewSession: false });
	try {
		const result = await runOperations(deps, [
			{ action: "patch", name: "a-b", old_string: "one", new_string: "two" },
		]);
		assert.equal(result.success, true);
	} finally {
		await deps.cleanup();
	}
});
