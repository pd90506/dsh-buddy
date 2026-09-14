/**
 * The `skill_manage` action vocabulary — the complete set of mutations the tool
 * accepts, and nothing else.
 *
 * A **leaf**: this module imports nothing, from this package or anywhere else.
 * That is its entire reason to exist as a separate file. The host row
 * (`./index.ts`) owns the state and the write path, and the preset row
 * (`../skills-agent/index.ts`) owns the tool that reaches it — but the two rows
 * are built as **separate artifacts**, and an ES module import is a whole-graph
 * edge, not a single-symbol one: importing even one constant from `./index.ts`
 * pulls `prompt.ts`, `review.ts`, `ledger.ts`, `store/domain.ts` and the rest of
 * the host row's graph into `lib/skills-agent.js`, which is exactly the boundary
 * the phase's two-row split exists to draw. Reading the list from here gives both
 * rows the same single definition with no edge between them.
 *
 * The negative space is the load-bearing part: `visibility` is **not** in this
 * list, so no tool argument can raise a skill's scope. That guarantee is enforced
 * twice — here, and by `applyOne`'s switch in `./manage.ts`, which refuses an
 * action it does not know — and it is the one hard rule keeping a habit learned
 * in Buddy out of ordinary coding sessions (spec §4.3, §7.1).
 * @module dsh-buddy/skills/actions
 */

/**
 * The six actions `skill_manage` accepts — and the complete set.
 *
 * The one source of truth for the vocabulary: the tool's `parameters` schema, the
 * host row's re-export and every test compare against this array rather than
 * restating it.
 */
export const SKILL_MANAGE_ACTIONS = ["create", "patch", "edit", "delete", "write_file", "remove_file"] as const;
