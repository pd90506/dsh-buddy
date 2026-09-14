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
	const fresh = emptyUsageRecord(options.now);
	await table.put(name, { ...fresh, created_by: options.agentCreated ? "agent" : null });
}

/**
 * Count one load of a skill (the DSH `skill` tool call) as a use.
 *
 * Also records the reuse generation: when the record has already been used at
 * least once and its `patch_generation` has advanced past
 * `last_reused_patch_generation`, this use marks the current generation as
 * reused. The first use after a patch is normally the patch's own authoring
 * pass, which is not a reuse of it — hence the `use_count > 0` guard.
 * @param table - the `skill_usage` table.
 * @param name - the skill name.
 * @param now - the ISO-8601 timestamp to stamp.
 * @throws when the skill has no usage record; a use cannot invent one.
 */
export async function bumpUse(table: UsageTable, name: string, now: string): Promise<void> {
	const record = requireRecord(table, name);
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
}

/**
 * Count one view of a skill.
 *
 * A view and a use share a timestamp here because DSH has exactly one load
 * path — the `skill` tool — so both counters observe the same event and the
 * pair only becomes interesting once a second, read-only path exists.
 * @param table - the `skill_usage` table.
 * @param name - the skill name.
 * @param now - the ISO-8601 timestamp to stamp.
 * @throws when the skill has no usage record.
 */
export async function bumpView(table: UsageTable, name: string, now: string): Promise<void> {
	const record = requireRecord(table, name);
	await table.put(name, { ...record, view_count: safeInt(record.view_count) + 1, last_viewed_at: now });
}

/**
 * Count one successful mutating action against a skill.
 *
 * Bumps `patch_count`, advances `patch_generation` and stamps
 * `last_patched_at`. `create` is inert here by design: {@link recordCreated}
 * owns creation, and a create that also counted as a patch would skew both the
 * activity total and the reuse generation a load compares against.
 * @param table - the `skill_usage` table.
 * @param name - the skill name.
 * @param action - the mutation the caller applied; only the four mutating
 * actions count.
 * @param now - the ISO-8601 timestamp to stamp.
 * @throws when the skill has no usage record.
 */
export async function bumpPatch(
	table: UsageTable,
	name: string,
	action: PatchAction | "create",
	now: string,
): Promise<void> {
	if (action === "create") return;
	const record = requireRecord(table, name);
	await table.put(name, {
		...record,
		patch_count: safeInt(record.patch_count) + 1,
		patch_generation: safeInt(record.patch_generation) + 1,
		last_patched_at: now,
	});
}

/**
 * Pin or unpin a skill.
 *
 * A pinned skill is exempt from pruning, so this is the one user-facing flag
 * that changes what the next phase's pass may touch. It writes `pinned` and
 * nothing else — in particular it never touches `state` or `archived_at`,
 * which belong to archiving rather than to pinning.
 * @param table - the `skill_usage` table.
 * @param name - the skill name.
 * @param pinned - the new flag value.
 * @returns `true` when the flag was written, `false` when the skill has no
 * usage record (a pin cannot invent one).
 */
export async function setPinned(table: UsageTable, name: string, pinned: boolean): Promise<boolean> {
	const record = table.get(name);
	if (record === undefined) return false;
	await table.put(name, { ...record, pinned });
	return true;
}

/**
 * Hand a skill over to automatic management by stamping `created_by: "agent"`.
 *
 * Adoption is a **provenance declaration, not an activity**: it deliberately
 * leaves every counter and timestamp alone, so the skill's inactivity clock
 * keeps running from wherever it was. It also never touches `state` or
 * `archived_at` — restoring or archiving is a separate decision.
 * @param table - the `skill_usage` table.
 * @param name - the skill name.
 * @returns `true` when the skill is (now) agent-created, `false` when it has no
 * usage record.
 */
export async function adopt(table: UsageTable, name: string): Promise<boolean> {
	const record = table.get(name);
	if (record === undefined) return false;
	if (record.created_by === "agent") return true;
	await table.put(name, { ...record, created_by: "agent" });
	return true;
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
 * Read the record a bump applies to.
 * @param table - the `skill_usage` table.
 * @param name - the skill name.
 * @returns the stored record.
 * @throws when no record exists; telemetry never fabricates one, because a
 * counter bump with no create behind it means the caller wired the wrong key.
 */
function requireRecord(table: UsageTable, name: string): SkillUsageRecord {
	const record = table.get(name);
	if (record === undefined) throw new Error(`no skill usage record for '${name}'`);
	return record;
}

/**
 * Coerce a possibly absent or malformed counter to a non-negative integer.
 * @param value - the stored counter.
 * @returns the counter, or `0` when it is not a usable number.
 */
function safeInt(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}
