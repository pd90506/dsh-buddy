/**
 * Task 6: the skill usage telemetry accessors.
 *
 * Three contracts carry the meaning here, and each one is easy to get subtly
 * wrong:
 *
 * 1. **`recordCreated` resets the whole record.** A create is a new logical
 *    skill, so counters, timestamps and `pinned` all go back to zero — only
 *    `created_by` and `created_at` carry information forward.
 * 2. **A create does not bump `patch_count`** — the four mutating actions do —
 *    so every accessor here except {@link recordCreated} keeps the counter
 *    inert.
 * 3. **`created_at` is not activity.** `latestActivityAt` and `activityCount`
 *    both exclude it, which is what keeps a never-used skill distinguishable
 *    from a used-but-old one; the pruning pass in the next phase depends on
 *    exactly that distinction.
 *
 * Every test drives the same in-memory table stub the other suites use, so no
 * storage backend and no cordis context is mounted.
 * @module test/skills-usage
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { KvTable } from "@deepseek-ai/dsh-storage-domain";
import {
	activityCount,
	adopt,
	bumpPatch,
	bumpUse,
	bumpView,
	latestActivityAt,
	recordCreated,
	setPinned,
} from "../src/skills/usage.ts";
import { emptyUsageRecord, type SkillUsageRecord } from "../src/store/domain.ts";
import { tableStub } from "./support/domain-tables.ts";

/** The timestamp most tests stamp; ISO-8601, as the domain schema stores it. */
const now = "2026-09-13T00:00:00.000Z";

/** One fresh table per test; nothing is shared between cases. */
function freshTable(): KvTable<string, SkillUsageRecord> {
	return tableStub<SkillUsageRecord>();
}

/**
 * A table whose storage is broken in the one direction named.
 *
 * The optional seed is written straight through the backing map, so a test can
 * set up a row the broken `put` could never have created — otherwise a
 * write-failing table could only ever be tested against a skill with no row.
 * @param where - `"read"` throws from `get`; `"write"` keeps `get` working and
 * throws from `put`.
 * @param seed - `[name, record]` pre-inserted without going through `put`.
 * @returns a table that fails every access it is asked to serve.
 */
function failingTable(
	where: "read" | "write",
	seed?: readonly [string, SkillUsageRecord] | undefined,
): KvTable<string, SkillUsageRecord> {
	const stored = tableStub<SkillUsageRecord>();
	if (seed !== undefined) {
		const [name, record] = seed;
		void stored.put(name, record);
	}
	return {
		...stored,
		get: (key) => {
			if (where === "read") throw new Error("storage read failed");
			return stored.get(key);
		},
		put: async (key, value) => {
			if (where === "write") throw new Error("storage write failed");
			await stored.put(key, value);
		},
	};
}

test("recordCreated resets the whole record and stamps provenance", async () => {
	const table = freshTable();
	// Seed every field away from its default, so a partial reset — or a
	// same-value rewrite — fails this instead of passing by coincidence.
	const seeded: SkillUsageRecord = {
		created_by: null,
		use_count: 5,
		view_count: 7,
		last_used_at: "2026-01-01T00:00:00.000Z",
		last_viewed_at: "2026-01-02T00:00:00.000Z",
		patch_count: 3,
		patch_generation: 3,
		last_reused_patch_generation: 2,
		last_patched_at: "2026-01-03T00:00:00.000Z",
		created_at: "2025-12-31T00:00:00.000Z",
		state: "archived",
		pinned: true,
		archived_at: "2026-01-04T00:00:00.000Z",
	};
	await table.put("a-b", seeded);
	await recordCreated(table, "a-b", { agentCreated: true, now });
	assert.deepEqual(table.get("a-b"), { ...emptyUsageRecord(now), created_by: "agent" });
});

test("recordCreated stamps created_at and a null creator for a human", async () => {
	const table = freshTable();
	await recordCreated(table, "a-b", { agentCreated: false, now });
	const record = table.get("a-b")!;
	assert.equal(record.created_by, null);
	assert.equal(record.created_at, now);
	assert.equal(record.patch_generation, 0);
	assert.equal(record.last_patched_at, null);
	assert.equal(record.state, "active");
});

test("create does not bump patch_count; the four mutating actions do", async () => {
	const table = freshTable();
	await recordCreated(table, "a-b", { agentCreated: false, now });
	assert.equal(table.get("a-b")!.patch_count, 0);
	await bumpPatch(table, "a-b", "patch", now);
	assert.equal(table.get("a-b")!.patch_count, 1);
	assert.equal(table.get("a-b")!.patch_generation, 1);
});

test("bumpPatch bumps every mutating action and stamps last_patched_at", async () => {
	for (const action of ["patch", "edit", "write_file", "remove_file"] as const) {
		const table = freshTable();
		await recordCreated(table, "a-b", { agentCreated: true, now });
		await bumpPatch(table, "a-b", action, now);
		const record = table.get("a-b")!;
		assert.equal(record.patch_count, 1, action);
		assert.equal(record.patch_generation, 1, action);
		assert.equal(record.last_patched_at, now, action);
	}
});

test("bumpPatch is inert for a create action", async () => {
	const table = freshTable();
	await recordCreated(table, "a-b", { agentCreated: true, now });
	await bumpPatch(table, "a-b", "create", now);
	const record = table.get("a-b")!;
	assert.equal(record.patch_count, 0);
	assert.equal(record.patch_generation, 0);
	assert.equal(record.last_patched_at, null);
});

test("bumpUse and bumpView count, stamp, and keep the patch generation", async () => {
	const table = freshTable();
	await recordCreated(table, "a-b", { agentCreated: true, now });
	await bumpUse(table, "a-b", now);
	await bumpView(table, "a-b", now);
	const record = table.get("a-b")!;
	assert.equal(record.use_count, 1);
	assert.equal(record.view_count, 1);
	assert.equal(record.last_used_at, now);
	assert.equal(record.last_viewed_at, now);
	assert.equal(record.patch_count, 0);
});

test("bumpUse records the generation a skill was reused at, but only once the record has been used before", async () => {
	const table = freshTable();
	await recordCreated(table, "a-b", { agentCreated: true, now });

	await bumpPatch(table, "a-b", "patch", now);
	await bumpUse(table, "a-b", now);
	// The guard is `use_count > 0`, i.e. "this record has never been used":
	// the very first load after a patch is a patch's own authoring use, not a
	// reuse of it.
	assert.equal(table.get("a-b")!.last_reused_patch_generation, 0);

	await bumpPatch(table, "a-b", "edit", now);
	await bumpUse(table, "a-b", now);
	// A use after the generation advanced marks the new generation reused.
	assert.equal(table.get("a-b")!.last_reused_patch_generation, 2);

	await bumpUse(table, "a-b", now);
	assert.equal(table.get("a-b")!.last_reused_patch_generation, 2);
});

test("a use -> patch -> use sequence credits the generation a single patch advanced to", async () => {
	const table = freshTable();
	await recordCreated(table, "a-b", { agentCreated: true, now });
	// The record has been used before, so the guard does not suppress this.
	await bumpUse(table, "a-b", now);
	await bumpPatch(table, "a-b", "patch", now);
	await bumpUse(table, "a-b", now);
	assert.equal(table.get("a-b")!.last_reused_patch_generation, 1);
});

test("latest activity excludes created_at so a never-used skill stays distinguishable", async () => {
	const record = emptyUsageRecord("2026-09-13T00:00:00.000Z");
	assert.equal(latestActivityAt(record), undefined);
	assert.equal(activityCount(record), 0);
});

test("latestActivityAt returns the newest of the three activity stamps", async () => {
	const table = freshTable();
	await recordCreated(table, "a-b", { agentCreated: true, now });
	await bumpUse(table, "a-b", "2026-09-13T00:00:00.000Z");
	await bumpView(table, "a-b", "2026-09-13T00:00:00.000Z");
	await bumpPatch(table, "a-b", "patch", "2026-09-14T00:00:00.000Z");
	assert.equal(latestActivityAt(table.get("a-b")!), "2026-09-14T00:00:00.000Z");
});

test("latestActivityAt compares instants, not strings, and ignores unparseable stamps", async () => {
	const base = emptyUsageRecord(now);
	// A plain string compare picks the `+02:00` form; the instants say it is the
	// earlier one (07:00Z versus 08:00Z), so only a parsed compare gets this right.
	const offset = { ...base, last_used_at: "2026-09-13T09:00:00.000+02:00", last_viewed_at: "2026-09-13T08:00:00.000Z" };
	assert.equal(latestActivityAt(offset), "2026-09-13T08:00:00.000Z");
	assert.equal(latestActivityAt({ ...base, last_patched_at: "not a date" }), undefined);
});

test("activityCount sums the three counters, not the number of stamps", async () => {
	const table = freshTable();
	await recordCreated(table, "a-b", { agentCreated: true, now });
	await bumpUse(table, "a-b", now);
	await bumpUse(table, "a-b", now);
	await bumpView(table, "a-b", now);
	await bumpPatch(table, "a-b", "patch", now);
	const record = table.get("a-b")!;
	// Three non-null stamps, four events: the sum is 2 + 1 + 1.
	assert.equal(activityCount(record), 4);
	assert.equal(latestActivityAt(record), now);
});

test("setPinned and adopt touch neither state nor archived_at", async () => {
	const table = freshTable();
	// Seed non-default lifecycle values: asserting against the defaults would
	// pass even if the write rewrote the whole record.
	const lifecycle = { state: "archived", archived_at: "2026-09-01T00:00:00.000Z" } as const;
	await table.put("a-b", { ...emptyUsageRecord(now), ...lifecycle });

	assert.equal(await setPinned(table, "a-b", true), true);
	assert.equal(table.get("a-b")!.pinned, true);
	assert.equal(table.get("a-b")!.state, lifecycle.state);
	assert.equal(table.get("a-b")!.archived_at, lifecycle.archived_at);

	// Adoption declares provenance and leaves the inactivity clock alone.
	await bumpUse(table, "a-b", now);
	assert.equal(await adopt(table, "a-b"), true);
	const record = table.get("a-b")!;
	assert.equal(record.created_by, "agent");
	assert.equal(record.use_count, 1);
	assert.equal(record.last_used_at, now);
	assert.equal(record.state, lifecycle.state);
	assert.equal(record.archived_at, lifecycle.archived_at);
});

test("a bump on a skill with no row seeds one with null provenance", async () => {
	const table = freshTable();
	// Bundled, project and hand-authored skills are loaded without ever having
	// been created, so their telemetry has to land on a fresh row.
	assert.equal(table.get("never-created"), undefined);
	await bumpUse(table, "never-created", now);
	assert.deepEqual(table.get("never-created"), {
		...emptyUsageRecord(now),
		use_count: 1,
		last_used_at: now,
		created_by: null,
	});

	await bumpView(table, "never-created", now);
	assert.equal(table.get("never-created")!.view_count, 1);
	assert.equal(table.get("never-created")!.last_viewed_at, now);

	await bumpPatch(table, "never-created", "write_file", now);
	const seeded = table.get("never-created")!;
	assert.equal(seeded.patch_count, 1);
	assert.equal(seeded.patch_generation, 1);
	assert.equal(seeded.last_patched_at, now);
	// Null provenance is what keeps a row out of curator management.
	assert.equal(seeded.created_by, null);
});

test("adopt is idempotent and refuses an absent record", async () => {
	const table = freshTable();
	assert.equal(await adopt(table, "missing"), false);
	await recordCreated(table, "a-b", { agentCreated: true, now });
	assert.equal(await adopt(table, "a-b"), true);
	assert.equal(table.get("a-b")!.created_by, "agent");
});

test("setPinned refuses an absent record instead of inventing one", async () => {
	const table = freshTable();
	assert.equal(await setPinned(table, "missing", true), false);
	assert.equal(table.get("missing"), undefined);
});

test("a failing table is logged, never thrown, and never rejects", async () => {
	const failures: string[] = [];
	const logged = console.error;
	console.error = (...parts: unknown[]) => {
		failures.push(parts.map(String).join(" "));
	};
	try {
		// A table that throws on every read: the row cannot even be loaded, so
		// every writer must still resolve.
		const unreadable = failingTable("read");
		await assert.doesNotReject(() => bumpUse(unreadable, "a-b", now));
		await assert.doesNotReject(() => bumpView(unreadable, "a-b", now));
		await assert.doesNotReject(() => bumpPatch(unreadable, "a-b", "patch", now));
		await assert.doesNotReject(() => adopt(unreadable, "a-b"));

		// A table whose read works and whose write fails: the row loads, the
		// bump is applied, and only the store rejects. This is the path a
		// fire-and-forget listener would otherwise turn into an unhandled
		// rejection, so it must be logged and answered, not thrown.
		const unwritable = failingTable("write", ["a-b", emptyUsageRecord(now)]);
		await assert.doesNotReject(() => bumpUse(unwritable, "a-b", now));
		await assert.doesNotReject(() => bumpView(unwritable, "a-b", now));
		await assert.doesNotReject(() => bumpPatch(unwritable, "a-b", "patch", now));
		assert.equal(await setPinned(unwritable, "a-b", true), false);
		assert.equal(await adopt(unwritable, "a-b"), false);
	} finally {
		console.error = logged;
	}
	// One log line per failure, on the ledger's own prefix convention, each
	// saying what was left unaffected. Only the branches that actually reach
	// the store log: `setPinned`/`adopt` on a table with no row simply answer
	// `false`, which is a refusal rather than a storage failure.
	assert.equal(failures.length, 9);
	for (const line of failures) {
		// The stub captures the format string unexpanded, so match the ledger's
		// shape — prefix, function name, and what was left unaffected.
		assert.match(line, /^skill_usage: (bumpUse|bumpView|bumpPatch|setPinned|adopt)\(/);
		assert.match(line, /unaffected|not written|unchanged/);
	}
});
