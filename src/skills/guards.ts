/**
 * Jurisdiction over a skill write: who may touch which skill at all.
 *
 * `skill_manage`'s write path has no opinion about its caller; this module is
 * the opinion. The phase is built on one rule — **the automatic review curates
 * only what the review itself created** — and for a background review it
 * decomposes into three refusals, judged in this order:
 *
 * 1. **Pinned.** A pinned skill is exempt from the automatic pass whatever its
 *    provenance, so the pin is the reason reported when it holds.
 * 2. **Not curator-managed.** A skill the human created (`created_by: null`) is
 *    never the review's to rewrite. The refusal names `adopt`, the explicit
 *    hand-over that puts the skill under automatic management (spec §8.5).
 * 3. **Read before write.** The review must have loaded a skill before it may
 *    modify it, so a summary cannot rewrite what it never read. This applies to
 *    the four actions that change existing content and not to `create`, which
 *    is making something new rather than modifying something prior.
 *
 * The **foreground has no jurisdiction restriction**: when a human is chatting
 * with Buddy, every skill in their own home is theirs, so `reviewSession:
 * false` allows immediately.
 *
 * Nothing here reads a cordis service or holds a live harness object. The record
 * is a `skill_usage` row (Task 2's telemetry) reduced to the fields this
 * decision reads, the read set is a plain `Map` of review-session id to skill
 * names owned by the host row, and the host row injects the verdict into the
 * write path through `ManageDeps.guard` rather than letting `manage.ts` learn
 * where provenance comes from.
 * @module dsh-buddy/skills/guards
 */
import type { SkillAction } from "./manage.ts";

/**
 * The actions that change something the review should have read first.
 *
 * `create` is deliberately absent — there is nothing prior to have read — and
 * so is `delete`, which the batch rules already confine to a single-operation
 * call.
 */
const READ_REQUIRED_ACTIONS: ReadonlySet<SkillAction> = new Set<SkillAction>([
	"patch",
	"edit",
	"write_file",
	"remove_file",
]);

/**
 * The provenance a jurisdiction decision reads off a usage row.
 *
 * Structural rather than the stored `SkillUsageRecord` on purpose: the decision
 * is a pure predicate over these fields, so a caller can hand it a row read from
 * the table or a literal without inventing counters.
 */
export interface GuardRecord {
	/** `"agent"` when an automatic review created the skill, `null` when a human did. */
	readonly created_by?: string | null;
	/** The pin flag, so a caller holding only the row needs no second lookup. */
	readonly pinned?: boolean;
}

/** Everything one jurisdiction decision needs. */
export interface BackgroundWriteInput {
	/** `true` when this call comes from a review sub-session the host row started. */
	readonly reviewSession: boolean;
	/** The target skill's usage row, absent when the skill has none yet. */
	readonly record?: GuardRecord | undefined;
	/** The pin flag as the caller resolved it; the row's own flag is honoured too. */
	readonly pinned?: boolean;
	/** Which action is being attempted. */
	readonly action: SkillAction;
	/** The skill directory name the action names. */
	readonly skill: string;
	/** The skills this review has already read, by name. */
	readonly readSet: Set<string>;
}

/** The guard's answer: allow, or refuse with the reason the caller reports. */
export type WriteVerdict = { readonly allow: true } | { readonly allow: false; readonly reason: string };

/**
 * @param record - a usage row, or nothing when the skill has none.
 * @returns `true` only for a skill an automatic review created.
 */
export function isCuratorManaged(record: GuardRecord | undefined | null): boolean {
	return record?.created_by === "agent";
}

/**
 * Judge one attempted write against the review's jurisdiction.
 *
 * A foreground caller is allowed immediately: the restriction exists to keep the
 * *automatic* review inside what it created, not to police the human. A review
 * is then refused in the order pinned → not curator-managed → read-before-write,
 * so the reported reason is the strongest one that holds. `create` is allowed
 * once it is past the pin check: a skill the review is about to create has no
 * prior provenance to own and nothing to have read.
 * @param input - the caller's identity, the target's telemetry, the action and
 * the review's read set.
 * @returns the verdict; refusing never throws and touches nothing.
 */
export function backgroundWriteGuard(input: BackgroundWriteInput): WriteVerdict {
	if (input.reviewSession !== true) return { allow: true };

	// Pinned first: a pin outranks provenance, so the reported reason is the pin
	// rather than whatever `created_by` happens to say.
	if (input.pinned === true || input.record?.pinned === true) {
		return {
			allow: false,
			reason: `skill '${input.skill}' is pinned; the automatic review does not modify a pinned skill`,
		};
	}

	// A create has no prior skill to own: the review is the author of what it is
	// about to write, so provenance cannot refuse it — and there was nothing for
	// it to have read.
	if (input.action === "create") return { allow: true };

	if (!isCuratorManaged(input.record)) {
		return {
			allow: false,
			reason: `skill '${input.skill}' is not curator-managed; use 'adopt' to hand it to automatic management`,
		};
	}

	if (READ_REQUIRED_ACTIONS.has(input.action) && !input.readSet.has(input.skill)) {
		return {
			allow: false,
			reason: `the review must read skill '${input.skill}' before it can ${input.action} it`,
		};
	}

	return { allow: true };
}

/**
 * Remember that one review read one skill.
 *
 * The read sets are the host row's map of review-session id to the skills that
 * session has loaded, and this is the only writer: a preset-row
 * `tools/post-execute` listener calls it when it observes a `skill` tool call,
 * per spec §8.4. Nothing here is global state.
 * @param readSets - the review-session-id → read-skills map.
 * @param sessionId - the review sub-session that did the reading.
 * @param skill - the skill name it read.
 */
export function markRead(readSets: Map<string, Set<string>>, sessionId: string, skill: string): void {
	const read = readSets.get(sessionId);
	if (read === undefined) {
		readSets.set(sessionId, new Set([skill]));
		return;
	}
	read.add(skill);
}

/**
 * Forget one review's read set.
 *
 * Called when a review ends, so the next review starts from an empty set and can
 * never inherit the previous one's reads — the DSH-shaped equivalent of the
 * reference implementation's reset-a-read-set-per-review rule (spec §8.4).
 * @param readSets - the review-session-id → read-skills map.
 * @param sessionId - the review sub-session to forget.
 */
export function resetReadSet(readSets: Map<string, Set<string>>, sessionId: string): void {
	readSets.delete(sessionId);
}
