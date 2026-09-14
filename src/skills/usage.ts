/**
 * Skill usage telemetry: the counters a pruning pass reads, and the actions
 * that move them.
 *
 * These are the **only** writers of a `skill_usage` row besides the domain
 * schema itself, so the field semantics live here rather than in the callers:
 *
 * - A **create resets the whole record** and does **not** bump `patch_count` —
 *   a create is a new logical skill, not a revision of one.
 * - The four **mutating actions** (`patch`, `edit`, `write_file`,
 *   `remove_file`) bump `patch_count` *and* advance `patch_generation`;
 *   `bumpUse` then remembers which generation a skill was last actually reused
 *   at, which is what makes "the patch landed but nobody reloaded it" visible.
 * - `created_at` is **not activity**. {@link latestActivityAt} and
 *   {@link activityCount} both exclude it, so a never-used skill stays
 *   distinguishable from a used-but-old one.
 * - `state` and `archived_at` belong to the next phase's pruning and
 *   archiving; this phase only declares the fields, so nothing here writes
 *   them.
 *
 * **Telemetry is not a gate.** No function here throws or rejects: a load or a
 * mutation that has already happened must never be refused — or, worse, turned
 * into an unhandled rejection on a fire-and-forget listener — because
 * bookkeeping failed. A failed table write is logged once and swallowed, the
 * way the sibling mutation ledger does it. A skill with no row yet is likewise
 * normal rather than an error: bundled, project and hand-authored skills are
 * loaded without ever having been created, so the bumpers seed a row with null
 * provenance instead of dropping the event.
 *
 * Records are plain values, so every writer reads a **copy** and puts a fresh
 * object back rather than mutating whatever handle storage returned. Nothing
 * here reads a cordis service or holds a live object.
 * @module dsh-buddy/skills/usage
 */
import type { KvTable } from "@deepseek-ai/dsh-storage-domain";
import { emptyUsageRecord, type SkillUsageRecord } from "../store/domain.ts";

/** One row of the `skill_usage` table. */
export type UsageTable = KvTable<string, SkillUsageRecord>;

/**
 * The actions that advance the patch counters.
 *
 * `create` is deliberately absent: a create is recorded by
 * {@link recordCreated}, and counting it as a patch would make every
 * freshly-created skill look edited. The ledger-only actions (`archive`,
 * `restore`, `pre-rollback`, `rollback`) never reach this module.
 */
export type PatchAction = "patch" | "edit" | "write_file" | "remove_file";

/** The derived activity fields, in the order a tie is broken. */
const USAGE_FIELDS = ["use_count", "view_count", "patch_count"] as const;

/** The activity timestamps; `created_at` is deliberately not one of them. */
const ACTIVITY_KEYS = ["last_used_at", "last_viewed_at", "last_patched_at"] as const;

/**
 * Note that a skill was created, resetting whatever record was there before.
 *
 * A create is a new logical skill, so counters, timestamps and `pinned` all go
 * back to zero — carrying them over would silently credit the new skill with
 * the old one's history, and a stale `pinned: true` would exempt it from
 * pruning. Only provenance (`created_by`) and the new `created_at` survive.
 *
 * This deliberately does **not** bump `patch_count`: see {@link bumpPatch}.
 *
 * Never throws and never rejects: telemetry is not a gate (see the module
 * header), so a table failure is logged and the create the caller already
 * applied is unaffected.
 * @param table - the `skill_usage` table (`ctx.buddyStore.skillUsage`).
 * @param name - the skill name, which is the table key.
 * @param options - `agentCreated` is `true` when an automatic review created the
 * skill and `false` when a human did; `now` is the ISO-8601 timestamp to stamp.
 */
export async function recordCreated(
	table: UsageTable,
	name: string,
	options: { agentCreated: boolean; now: string },
): Promise<void> {
	try {
		const fresh = emptyUsageRecord(options.now);
		await table.put(name, { ...fresh, created_by: options.agentCreated ? "agent" : null });
	} catch (error) {
		console.error("skill_usage: recordCreated('%s') failed (%s) — skill creation unaffected", name, messageOf(error));
	}
}

/**
 * Count one load of a skill (the DSH `skill` tool call) as a use.
 *
 * A load is a fact about **any** skill, so this does not require a prior
 * {@link recordCreated}: DSH's `skill` tool also loads bundled, project and
 * hand-authored skills that never went through a create, and their telemetry
 * must land too. An absent row is seeded with
 * `emptyUsageRecord(now)` and `created_by: null` — null provenance is what
 * keeps such a row out of curator management, so the seed never claims the
 * skill is agent-created.
 *
 * Also records the reuse generation: when the record has already been used at
 * least once (`use_count > 0`) and its `patch_generation` has advanced past
 * `last_reused_patch_generation`, this use marks the current generation as
 * reused. The guard is about the record *never having been used*, not about
 * the first use after a patch: a `use → patch → use` sequence does credit the
 * new generation, because that middle load is what a patch's own authoring
 * pass looks like and it must not be mistaken for a reuse.
 *
 * Never throws and never rejects: telemetry is not a gate (see the module
 * header), so a table failure is logged and the load is unaffected.
 * @param table - the `skill_usage` table.
 * @param name - the skill name.
 * @param now - the ISO-8601 timestamp to stamp.
 */
export async function bumpUse(table: UsageTable, name: string, now: string): Promise<void> {
	try {
		const record = loadRecord(table, name, now);
		const uses = safeInt(record.use_count);
		const generation = safeInt(record.patch_generation);
		const lastReused = Math.min(safeInt(record.last_reused_patch_generation), generation);
		const reuseAfterPatch = uses > 0 && generation > lastReused;
		await table.put(name, {
			...record,
			use_count: uses + 1,
			last_used_at: now,
			patch_generation: generation,
			last_reused_patch_generation: reuseAfterPatch ? generation : lastReused,
		});
	} catch (error) {
		console.error("skill_usage: bumpUse('%s') failed (%s) — skill load unaffected", name, messageOf(error));
	}
}

/**
 * Count one view of a skill.
 *
 * Seeded from an absent row exactly like {@link bumpUse}, and never throws or
 * rejects for the same reason. A view and a use share a timestamp here because
 * DSH has exactly one load path — the `skill` tool — so both counters observe
 * the same event and the pair only becomes interesting once a second,
 * read-only path exists.
 * @param table - the `skill_usage` table.
 * @param name - the skill name.
 * @param now - the ISO-8601 timestamp to stamp.
 */
export async function bumpView(table: UsageTable, name: string, now: string): Promise<void> {
	try {
		const record = loadRecord(table, name, now);
		await table.put(name, { ...record, view_count: safeInt(record.view_count) + 1, last_viewed_at: now });
	} catch (error) {
		console.error("skill_usage: bumpView('%s') failed (%s) — skill load unaffected", name, messageOf(error));
	}
}

/**
 * Count one successful mutating action against a skill.
 *
 * Bumps `patch_count`, advances `patch_generation` and stamps
 * `last_patched_at`. `create` is inert here by design: {@link recordCreated}
 * owns creation, and a create that also counted as a patch would skew both the
 * activity total and the reuse generation a load compares against. An absent
 * row is seeded like {@link bumpUse}'s, so a mutation records its own history
 * even when nothing created the row first.
 *
 * Never throws and never rejects: a table failure is logged and the mutation
 * the caller already applied is unaffected.
 * @param table - the `skill_usage` table.
 * @param name - the skill name.
 * @param action - the mutation the caller applied; only the four mutating
 * actions count.
 * @param now - the ISO-8601 timestamp to stamp.
 */
export async function bumpPatch(
	table: UsageTable,
	name: string,
	action: PatchAction | "create",
	now: string,
): Promise<void> {
	if (action === "create") return;
	try {
		const record = loadRecord(table, name, now);
		await table.put(name, {
			...record,
			patch_count: safeInt(record.patch_count) + 1,
			patch_generation: safeInt(record.patch_generation) + 1,
			last_patched_at: now,
		});
	} catch (error) {
		console.error("skill_usage: bumpPatch('%s', %s) failed (%s) — mutation unaffected", name, action, messageOf(error));
	}
}

/**
 * Pin or unpin a skill.
 *
 * A pinned skill is exempt from pruning, so this is the one user-facing flag
 * that changes what the next phase's pass may touch. It writes `pinned` and
 * nothing else — in particular it never touches `state` or `archived_at`,
 * which belong to archiving rather than to pinning.
 *
 * Never throws and never rejects: a table failure is logged and answered with
 * `false`, so a panel handler reports "did not land" rather than crashing.
 * @param table - the `skill_usage` table.
 * @param name - the skill name.
 * @param pinned - the new flag value.
 * @returns `true` when the flag was written, `false` when the skill has no
 * usage record (a pin cannot invent one) or the write failed.
 */
export async function setPinned(table: UsageTable, name: string, pinned: boolean): Promise<boolean> {
	try {
		const record = table.get(name);
		if (record === undefined) return false;
		await table.put(name, { ...record, pinned });
		return true;
	} catch (error) {
		console.error("skill_usage: setPinned('%s') failed (%s) — flag not written", name, messageOf(error));
		return false;
	}
}

/**
 * Hand a skill over to automatic management by stamping `created_by: "agent"`.
 *
 * Adoption is a **provenance declaration, not an activity**: it deliberately
 * leaves every counter and timestamp alone, so the skill's inactivity clock
 * keeps running from wherever it was. It also never touches `state` or
 * `archived_at` — restoring or archiving is a separate decision.
 *
 * Never throws and never rejects: a table failure is logged and answered with
 * `false`, so the panel reports "did not land" rather than crashing.
 * @param table - the `skill_usage` table.
 * @param name - the skill name.
 * @returns `true` when the skill is (now) agent-created, `false` when it has no
 * usage record or the write failed.
 */
export async function adopt(table: UsageTable, name: string): Promise<boolean> {
	try {
		const record = table.get(name);
		if (record === undefined) return false;
		if (record.created_by === "agent") return true;
		await table.put(name, { ...record, created_by: "agent" });
		return true;
	} catch (error) {
		console.error("skill_usage: adopt('%s') failed (%s) — provenance unchanged", name, messageOf(error));
		return false;
	}
}

/**
 * The newest recorded activity, as the original timestamp string.
 *
 * `created_at` is excluded on purpose: a skill that has never been loaded must
 * answer `undefined` so the pruning pass can tell "never used" from "used long
 * ago". Comparison is by parsed instant rather than by string order, because a
 * record written with a UTC offset would otherwise sort by its spelling; a
 * null or unparseable stamp is treated as absent instead of throwing.
 * @param record - one usage record.
 * @returns the newest of `last_used_at`, `last_viewed_at` and `last_patched_at`,
 * or `undefined` when none of them is a usable timestamp.
 */
export function latestActivityAt(record: SkillUsageRecord): string | undefined {
	let best: { readonly at: number; readonly raw: string } | undefined;
	for (const key of ACTIVITY_KEYS) {
		const raw = record[key];
		if (raw === null) continue;
		const at = Date.parse(raw);
		if (Number.isNaN(at)) continue;
		if (best === undefined || at > best.at) best = { at, raw };
	}
	return best?.raw;
}

/**
 * The total number of observed activity events: `use + view + patch`.
 *
 * This is a **sum of the three counters**, not a count of how many timestamp
 * fields are set — a skill loaded five times has one `last_used_at`. Like
 * {@link latestActivityAt} it excludes `created_at`, so a brand-new record is
 * `0`. A missing or non-numeric counter counts as zero rather than throwing,
 * since a derived read must not be able to break a list view.
 * @param record - one usage record.
 * @returns the summed counters.
 */
export function activityCount(record: SkillUsageRecord): number {
	let total = 0;
	for (const key of USAGE_FIELDS) total += safeInt(record[key]);
	return total;
}

/**
 * Read the record a bump applies to, seeding an absent one.
 *
 * A load or a mutation of a skill that has no row yet is **normal**, not
 * caller error: DSH's `skill` tool loads bundled, project and hand-authored
 * skills that never went through {@link recordCreated}, and nothing backfills
 * them. Dropping their telemetry would make the panel and the pruning pass read
 * "never used" for a skill the model really did load. The seed is
 * `emptyUsageRecord(now)` with `created_by: null` — null provenance is what
 * keeps the row out of curator management, so the seed never quietly claims the
 * skill is agent-created.
 *
 * The returned value is always an owned copy: callers spread it into a fresh
 * object rather than mutating whatever storage handed back.
 * @param table - the `skill_usage` table.
 * @param name - the skill name.
 * @param now - the ISO-8601 timestamp an absent record is created at.
 * @returns the stored record, or a fresh empty one when there is none.
 */
function loadRecord(table: UsageTable, name: string, now: string): SkillUsageRecord {
	return table.get(name) ?? emptyUsageRecord(now);
}

/**
 * Coerce a possibly absent or malformed counter to a non-negative integer.
 * @param value - the stored counter.
 * @returns the counter, or `0` when it is not a usable number.
 */
function safeInt(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/**
 * @param error - an unknown throwable.
 * @returns its message, or the value rendered.
 */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
