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

test("recordCreated resets the whole record and stamps provenance", async () => {
	const table = freshTable();
	await table.put("a-b", { ...emptyUsageRecord(now), use_count: 5, pinned: true });
	await recordCreated(table, "a-b", { agentCreated: true, now });
	const record = table.get("a-b")!;
	assert.equal(record.created_by, "agent");
	assert.equal(record.use_count, 0); // whole record reset
	assert.equal(record.pinned, false);
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

test("bumpUse records the generation a skill was reused at, but not on its own first use", async () => {
	const table = freshTable();
	await recordCreated(table, "a-b", { agentCreated: true, now });

	await bumpPatch(table, "a-b", "patch", now);
	await bumpUse(table, "a-b", now);
	// The first load is the patch's own authoring use, not a reuse of it.
	assert.equal(table.get("a-b")!.last_reused_patch_generation, 0);

	await bumpPatch(table, "a-b", "edit", now);
	await bumpUse(table, "a-b", now);
	// A use after the generation advanced marks the new generation reused.
	assert.equal(table.get("a-b")!.last_reused_patch_generation, 2);

	await bumpUse(table, "a-b", now);
	assert.equal(table.get("a-b")!.last_reused_patch_generation, 2);
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
	await recordCreated(table, "a-b", { agentCreated: false, now });
	assert.equal(await setPinned(table, "a-b", true), true);
	assert.equal(table.get("a-b")!.pinned, true);
	assert.equal(table.get("a-b")!.state, "active");
	assert.equal(table.get("a-b")!.archived_at, null);

	// Adoption declares provenance and leaves the inactivity clock alone.
	await bumpUse(table, "a-b", now);
	assert.equal(await adopt(table, "a-b"), true);
	const record = table.get("a-b")!;
	assert.equal(record.created_by, "agent");
	assert.equal(record.use_count, 1);
	assert.equal(record.last_used_at, now);
	assert.equal(record.state, "active");
	assert.equal(record.archived_at, null);
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

test("a bump on an absent record rejects rather than fabricating one", async () => {
	const table = freshTable();
	await assert.rejects(() => bumpUse(table, "missing", now));
	await assert.rejects(() => bumpView(table, "missing", now));
	await assert.rejects(() => bumpPatch(table, "missing", "patch", now));
	assert.equal(table.get("missing"), undefined);
});
