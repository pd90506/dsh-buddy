/**
 * Host row `dsh-buddy/skills`: the assembly point of the whole phase.
 *
 * It owns the parts that must outlive one conversation — the skills root under
 * the buddy home, the three `buddy` domain tables, the review coordinator, the
 * write path's jurisdiction — and publishes them as `ctx.buddySkills`. The
 * companion preset row (`dsh-buddy/skills-agent`, Task 14) is what *registers*
 * the provider, the `skill_manage` tool and the event listeners; a registration
 * lands in the calling context's layer, so only the preset row can put them in
 * the buddy scope. This row is where the state behind those registrations lives,
 * because its readers sit outside the preset (the typert gateway, the panel, and
 * a later phase's scheduler and board).
 *
 * Four things shape the code more than the method list does:
 *
 * - **Only `buddyStore` is hard.** This row must mount in a profile with no
 *   subagent plane, no session query, no agent registry and no typert registry —
 *   each of those is read with `ctx.get` and degrades rather than throwing. In
 *   particular a review with no `subagents` service is *skipped with one log
 *   line*, because a turn boundary must never raise into the harness.
 * - **`onTurnEnd` forwards the route and the surface.** Spec §7.1 chooses the
 *   review's input path by comparing the configured review model against the
 *   route the conversation **actually ran on**; substituting `buddy.model` for
 *   it makes a cheap-model review run as an expensive fork (or the reverse) on
 *   any session pinned by `/model`. The surface is what the cheap path needs for
 *   its digest, and it is soft: without `sessionQuery` the fork path is
 *   unaffected and only the digest path degrades.
 * - **The heartbeat is bounded by a timer, not by hope.** `noteAgentRowMounted`
 *   is the agent row saying "I am here"; ten seconds after boot the row decides
 *   the preset did not mount and says so. That converts the phase's signature
 *   failure — installed, silently doing nothing — into a visible state.
 * - **Nothing but the panel can raise a skill's scope.** The action set the
 *   write path accepts has no `visibility`, and {@link BuddySkillsService.setVisibility}
 *   is reachable only through the `buddySkills/visibility` endpoint. That is the
 *   one hard guarantee that a habit learned in Buddy cannot leak into ordinary
 *   coding sessions.
 * @module dsh-buddy/skills
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Service } from "@deepseek-ai/cordis";
import type { KvTable } from "@deepseek-ai/dsh-storage-domain";
import type { BuddyConfig } from "../config.ts";
import type { BuddyPaths } from "../paths.ts";
import type { ReviewUsageRecord, SkillLedgerRecord, SkillUsageRecord } from "../store/domain.ts";
import type { DigestMessage } from "./digest.ts";
import {
	BuddySkillsGateway,
	type BuddySkillsRemote,
	type ReviewUsageView,
	type SkillLedgerView,
	type SkillMutationView,
	type SkillUsageView,
	type SkillView,
} from "./gateway.ts";
import { backgroundWriteGuard, markRead, type WriteVerdict } from "./guards.ts";
import { listEntries, rollbackEntry, type LedgerDeps } from "./ledger.ts";
import { runOperations, type ManageDeps, type Operation, type SkillAction } from "./manage.ts";
import { createBuddyProvider, createPromotedProvider, PROMOTED_SKILL_PROVIDER_NAME, type SkillCandidate } from "./provider.ts";
import { ReviewCoordinator, type ReviewCoordinatorDeps, type ReviewSpawnInput, type ReviewSpawnResult } from "./review.ts";
import { activityCount, adopt, latestActivityAt, setPinned } from "./usage.ts";
import { validateSkillName } from "./validate.ts";

/** Cordis plugin name used by loader diagnostics. */
export const name = "dsh-buddy-skills";

/**
 * Hard dependency: the skills root, the three domain tables and the settings
 * section all arrive through the store row. Everything else is soft.
 */
export const inject = ["buddyStore"];

/**
 * How long after boot the row waits for the agent row's heartbeat before it
 * declares the preset unsynchronized.
 *
 * An **internal liveness constant, not a user tunable**: it belongs to neither
 * `Config` nor the settings tab, and no profile can raise it. It is the same
 * class of value as the store row's two-second settings barrier. Ten seconds is
 * far longer than the agent row's own mount takes — the loader mounts both rows
 * in the same pass — so the bound cannot fire on a merely busy event loop, while
 * still being short enough that a user who opens the panel reads the truth
 * rather than a stale "nothing is wrong".
 */
const PRESET_HEARTBEAT_TIMEOUT_MS = 10_000;

/**
 * The six actions `skill_manage` accepts — and the complete set.
 *
 * Exported because the negative space is what matters: `visibility` is **not**
 * in it, so no tool argument can raise a skill's scope (spec §4.3, §7.1). The
 * guarantee is enforced twice — here, and by `applyOne`'s switch, which refuses
 * an action it does not know.
 */
export const SKILL_MANAGE_ACTIONS = ["create", "patch", "edit", "delete", "write_file", "remove_file"] as const;

/** The `buddyStore` members this row uses. */
interface StoreHandle {
	readonly paths: BuddyPaths;
	config(): BuddyConfig;
	skillUsage(): KvTable<string, SkillUsageRecord>;
	skillLedger(): KvTable<string, SkillLedgerRecord>;
	reviewUsage(): KvTable<string, ReviewUsageRecord>;
}

/** The context members this row uses. */
interface PluginContext {
	get(name: string): unknown;
	effect(effect: () => (() => void) | Promise<() => void>, label?: string): unknown;
	buddyStore: StoreHandle;
}

/** One live Agent, reduced to the identity the seam needs. */
interface ParentAgent {
	readonly id: string;
}

/** One content block of a child's initial prompt. */
interface PromptBlock {
	readonly type: "text";
	readonly text: string;
}

/** The one-shot run `ctx.subagents.start` answers with, reduced to what we use. */
interface SubagentRun {
	/** The child's durable session id. */
	readonly id: string;
	/** Settles with the child's terminal outcome; by contract it does not reject for a child-level failure. */
	readonly result: Promise<unknown>;
	/** Cancel remaining work and reach child quiescence. Idempotent. */
	dispose(): Promise<void>;
}

/** What this row asks the subagent plane to start. */
interface SubagentStartRequest {
	readonly prompt: PromptBlock[];
	readonly parent: ParentAgent;
	readonly signal: AbortSignal;
	readonly label?: string;
	readonly agentOptions?: { readonly provider: string; readonly model: string };
	readonly toolFilter?: { readonly allow: readonly string[] };
}

/** The authority one interrupt is admitted under (spec §7.4: an ancestor stop). */
interface SubagentInterruptAuthority {
	readonly kind: "ancestor";
	readonly agent: ParentAgent;
}

/**
 * The `ctx.subagents` slice this row uses.
 *
 * Declared locally rather than imported: `subagents` is soft, the row must mount
 * without it, and the shape it reads is exactly the two calls it makes. The
 * declaration mirrors the shipped contract
 * (`@deepseek-ai/dsh-subagent/lib/types/index.d.ts:296` for `start`,
 * `:161` for `interrupt`; the request and run shapes are in `.../types.d.ts`).
 */
interface SubagentService {
	start(name: string, request: SubagentStartRequest): Promise<SubagentRun>;
	interrupt(targetSessionId: string, authority: SubagentInterruptAuthority): void;
}

/** The live-agent lookup this row uses to turn a session id into a parent Agent. */
interface AgentRegistry {
	get(sessionId: string): ParentAgent | undefined;
}

/** The `sessionQuery` slice this row reads, and only on the digest path. */
interface SessionQuery {
	readSurface(sessionId: string): Promise<{ readonly events: readonly unknown[] }>;
}

/** Anything that names a session: an Agent, a header, or a bare id. */
type SessionActor = string | { readonly id?: string } | undefined;

/** One live review, as the row tracks it for interruption and cleanup. */
interface LiveReview {
	readonly run: SubagentRun;
	/** The parent Agent, which is the authority an ancestor interrupt is admitted under. */
	readonly parent: ParentAgent;
	/**
	 * The cancellation channel the start request was given.
	 *
	 * Held so a stopped review is cancelled through the same signal `start`
	 * received — the canonical channel the shipped providers watch after
	 * publication — rather than relying on `dispose` alone.
	 */
	readonly signal: AbortController;
}

/**
 * The `buddySkills` service.
 *
 * Fields are TypeScript-`private`, never `#`-private: cordis hands this service
 * out as a traceable proxy and dispatches through `Reflect.apply`, which
 * substitutes a shadow receiver for `this`, and a `#` field's brand cannot cross
 * a proxy.
 */
export class BuddySkillsService extends Service {
	private readonly host: PluginContext;

	/** The review coordinator, constructed here so its seam can close over this instance. */
	private readonly coordinator: ReviewCoordinator;

	/** Skills a running review has loaded, so read-before-write can be judged. */
	private readonly readSets = new Map<string, Set<string>>();

	/** The session ids this row started a review for. */
	private readonly reviewSessions = new Set<string>();

	/** Live review runs, by child session id, so disposal can stop them. */
	private readonly liveReviews = new Map<string, LiveReview>();

	/** The parent Agent each flying review belongs to, by child session id. */
	private readonly parentLinks = new Map<string, ParentAgent>();

	/** The Agent the in-flight `spawn`/`refine` call belongs to. */
	private pendingParent: ParentAgent | undefined;

	/** Whether the agent row has reported that it mounted. */
	private heartbeat = false;

	/** Whether the heartbeat deadline passed without a report. */
	private heartbeatMissed = false;

	/**
	 * @param ctx - the plugin fiber's context; the service registers immediately.
	 */
	constructor(ctx: PluginContext) {
		super(ctx as never, "buddySkills");
		this.host = ctx;
		this.coordinator = new ReviewCoordinator(this.coordinatorDeps());
	}

	// ── the trigger path (driven by the preset row's listeners) ──────────────

	/**
	 * Count one model round of a conversation toward its next review.
	 * @param sessionId - the conversation's session id.
	 */
	noteStep(sessionId: string): void {
		this.coordinator.noteStep(sessionId);
	}

	/**
	 * Reset a conversation's counter because the model curated a skill itself.
	 *
	 * Deliberately unconditional, unlike {@link noteStep}: a curation that
	 * happened is a fact about the conversation whatever the setting said at the
	 * instant it happened.
	 * @param sessionId - the conversation whose tool call this was.
	 */
	noteSkillManageCalled(sessionId: string): void {
		this.coordinator.noteSkillManageCalled(sessionId);
	}

	/**
	 * The post-commit end of a turn: maybe start a review.
	 *
	 * The route is the caller's own and is forwarded verbatim, because §7.1's
	 * decision compares the configured review model against it. The surface is
	 * read from `sessionQuery` only after the coordinator's own cheap gates —
	 * it is a real log read, and the common path (an interval that has not
	 * elapsed, a delegated turn) must not pay for it.
	 *
	 * Nothing here throws: a missing `subagents` plane, a missing Agent, or a
	 * failing surface read all degrade to "no review this turn" plus a log line.
	 * @param input - the ended turn: its session, reason, route, and any caller-known
	 *   Agent (the preset row has one; the automatic path resolves it instead).
	 */
	async onTurnEnd(input: {
		readonly sessionId: string;
		readonly reason: { readonly kind: string };
		readonly origin?: string | undefined;
		readonly delegationDepth?: number | undefined;
		readonly route?: { readonly provider: string; readonly model: string } | undefined;
		readonly agent?: ParentAgent | undefined;
	}): Promise<void> {
		if (input.origin === "subagent" || (input.delegationDepth ?? 0) > 0) return;
		if (input.reason.kind !== "completed") return;
		// A cheap gate *in front of* the transcript read, not a second decision:
		// the coordinator still owns the trigger, and this only keeps a log read
		// off the turns that cannot possibly earn a review. The surface itself is
		// read lazily through `surface` below, so the fork path never pays for it.
		if (!this.coordinator.wouldReview(input.sessionId)) return;

		const agent = input.agent ?? this.agentFor(input.sessionId);
		if (agent !== undefined) this.pendingParent = agent;
		try {
			const turn: Parameters<ReviewCoordinator["onTurnEnd"]>[0] = {
				sessionId: input.sessionId,
				reason: input.reason,
				...(input.route === undefined ? {} : { route: input.route }),
				surface: () => this.surfaceFor(input.sessionId),
			};
			await this.coordinator.onTurnEnd(turn);
		} finally {
			// The pending link is only read by the `spawn` seam *during* this call;
			// leaving it set would pin one dead Agent per conversation forever.
			this.pendingParent = undefined;
		}
	}

	/**
	 * Start a review on demand, for the preset row's `/refine` command.
	 *
	 * Unlike the automatic path this one is *explicit*: the user asked for it, so
	 * the nudge counter is irrelevant and the focus, when there is one, reaches
	 * the prompt through the coordinator. The Agent comes from the command
	 * invocation, which is the one caller that always has it.
	 * @param agent - the conversation's live Agent.
	 * @param focus - the user's focus text, or nothing.
	 */
	async refine(agent: ParentAgent, focus: string): Promise<void> {
		this.pendingParent = agent;
		try {
			await this.coordinator.refine(agent.id, focus);
		} finally {
			this.pendingParent = undefined;
		}
	}

	/**
	 * Observe one event of a review's child session and enforce its budgets.
	 * @param childSessionId - the child session the event belongs to.
	 * @param event - the raw event; only its type and usage are read.
	 */
	noteChildEvent(childSessionId: string, event: unknown): void {
		this.coordinator.noteChildEvent(childSessionId, event);
	}

	/**
	 * Stop every review still flying and release the coordinator's state.
	 *
	 * Called from the owning effect's disposer, because a row that has been
	 * unloaded must not leave a child spending tokens under budgets nobody is
	 * enforcing any more. Fail-safe: a failing interrupt or disposal is a log
	 * line, never a throw out of a fiber teardown.
	 * @returns resolution once each review's teardown has settled.
	 */
	async dispose(): Promise<void> {
		await this.coordinator.dispose();
		for (const childSessionId of [...this.liveReviews.keys()]) await this.stopReview(childSessionId);
		this.pendingParent = undefined;
		this.parentLinks.clear();
		this.reviewSessions.clear();
		this.readSets.clear();
	}

	// ── the heartbeat (spec §5.2's third bullet) ─────────────────────────────

	/**
	 * Report that the agent row mounted, clearing the not-synced notice.
	 *
	 * Called by the preset row at mount time. This is the only writer: the
	 * deadline below records a *miss*, so a preset that mounts late still clears
	 * the notice instead of latching into a warning.
	 */
	noteAgentRowMounted(): void {
		this.heartbeat = true;
		// A late heartbeat *clears* the notice: the bound identifies "the preset
		// did not mount", not "the preset mounted late", and a user who repaired
		// the wiring should see the warning go away without a reload.
		this.heartbeatMissed = false;
	}

	/**
	 * Whether the agent row has reported in.
	 * @returns `true` once the heartbeat arrived.
	 */
	async presetSynced(): Promise<boolean> {
		return this.heartbeat;
	}

	/**
	 * Whether the not-synced notice is showing.
	 *
	 * Exposed beside {@link presetSynced} so the panel can name the failure —
	 * "the preset did not mount" is actionable, "false" is not. A heartbeat that
	 * arrives after the bound clears it, so the two reads can never disagree in
	 * the direction that matters: a synced preset never reports a miss.
	 * @returns `true` while the bound has fired and no heartbeat has arrived.
	 */
	async presetSyncMissed(): Promise<boolean> {
		return this.heartbeatMissed;
	}

	/**
	 * Record that the heartbeat deadline fired. Called by this row's own timer.
	 */
	notePresetSyncMissed(): void {
		if (!this.heartbeat) this.heartbeatMissed = true;
	}

	// ── the write path ───────────────────────────────────────────────────────

	/**
	 * Apply one batch of `skill_manage` operations.
	 *
	 * Jurisdiction is decided here, not by the caller: a session this row started
	 * a review for is the automatic review and is held to pinned / curator-managed
	 * / read-before-write, while any other session is the human's own and is free
	 * to write. The actor string is what the ledger records.
	 * @param actor - the calling session, an Agent, or a bare id.
	 * @param operations - the requested mutations, untrusted.
	 * @returns the batch outcome plus the fresh listing.
	 */
	async manage(actor: SessionActor, operations: readonly unknown[]): Promise<SkillMutationView> {
		const sessionId = sessionIdOf(actor);
		// The endpoint normalizes the wire, but the preset row calls this
		// directly with whatever the tool arguments held, so a non-array is
		// answered as the empty batch it is — a refusal — rather than throwing
		// into a tool execution.
		const clean = cleanOperations(Array.isArray(operations) ? operations : []);
		const outcome = await runOperations(this.manageDeps(sessionId), clean);
		return await this.mutationView(
			outcome.success,
			outcome.success ? `applied ${clean.length} operation(s)` : (outcome.error ?? "the batch was refused"),
		);
	}

	/**
	 * Raise or lower one skill's tier — the human-only promotion (spec §4.3).
	 *
	 * The write goes through the same atomic path as `skill_manage` (snapshot,
	 * validation, ledger, rollback), but it is **not** a `skill_manage`
	 * operation: {@link SKILL_MANAGE_ACTIONS} has no `visibility` and `applyOne`
	 * refuses an action it does not know, so no tool argument can reach this.
	 *
	 * The rewrite is the frontmatter's `visibility` value, which is exactly what
	 * the providers resolve — so the promotion is real for the sessions the
	 * promoted provider serves, not a panel-only flag.
	 * @param skill - the skill directory name.
	 * @param tier - `"buddy"`, `"global"` or `"project:<path>"`.
	 * @returns the outcome plus the fresh listing.
	 */
	async setVisibility(skill: string, tier: unknown): Promise<SkillMutationView> {
		const parsed = parseTier(tier);
		if (parsed === undefined) return await this.mutationView(false, `unrecognized visibility '${String(tier)}'`);
		const nameError = validateSkillName(skill);
		if (nameError !== undefined) return await this.mutationView(false, nameError);
		let document: string;
		try {
			document = await readFile(join(this.host.buddyStore.paths.skills, skill, "SKILL.md"), "utf8");
		} catch (error) {
			return await this.mutationView(false, `skill '${skill}' has no readable SKILL.md (${messageOf(error)})`);
		}
		const patched = withVisibility(document, parsed);
		if (patched === undefined) {
			return await this.mutationView(false, `skill '${skill}' has no frontmatter to declare a visibility in`);
		}
		// `actor: "user"`: the promotion is the human's act whatever session the
		// panel was open in, and the ledger should say so. The guard is the
		// foreground one, which allows everything.
		const outcome = await runOperations(this.manageDeps("", "user"), [
			{ action: "patch", name: skill, old_string: document, new_string: patched },
		]);
		return await this.mutationView(
			outcome.success,
			outcome.success ? `'${skill}' is now visible to ${parsed}` : (outcome.error ?? "the promotion was refused"),
		);
	}

	/**
	 * The panel's name for {@link listSkills}.
	 *
	 * The endpoint methods and the service methods are named one for one on
	 * purpose: the panel verbs (list / pin / adopt / visibility / rollback) are
	 * the wire surface, and a reader comparing them against
	 * {@link SKILL_MANAGE_ACTIONS} can see immediately that `visibility` has no
	 * tool counterpart.
	 * @returns one owned view per skill, in name order.
	 */
	async list(): Promise<readonly SkillView[]> {
		return await this.listSkills();
	}

	/**
	 * The panel's name for {@link setPinned}.
	 * @param skill - the skill directory name.
	 * @param pinned - the new flag value.
	 * @returns the outcome plus the fresh listing.
	 */
	async pin(skill: string, pinned: boolean): Promise<SkillMutationView> {
		return await this.setPinned(skill, pinned);
	}

	/**
	 * The panel's name for {@link setVisibility}.
	 *
	 * A distinct entry point rather than an alias kept for symmetry: this is the
	 * method the `visibility` endpoint dispatches to, and naming it here keeps
	 * the panel's verbs (list / pin / adopt / visibility / rollback) one for one
	 * with the service's, so a reader can see at a glance that `skill_manage` has
	 * no counterpart for it at all.
	 * @param skill - the skill directory name.
	 * @param tier - `"buddy"`, `"global"` or `"project:<path>"`.
	 * @returns the outcome plus the fresh listing.
	 */
	async visibility(skill: string, tier: unknown): Promise<SkillMutationView> {
		return await this.setVisibility(skill, tier);
	}

	/**
	 * Pin or unpin a skill. A pin cannot invent a usage row.
	 * @param skill - the skill directory name.
	 * @param pinned - the new flag value.
	 * @returns the outcome plus the fresh listing.
	 */
	async setPinned(skill: string, pinned: boolean): Promise<SkillMutationView> {
		const landed = await setPinned(this.host.buddyStore.skillUsage(), skill, pinned === true);
		return await this.mutationView(
			landed,
			landed ? `'${skill}' pinned=${pinned === true}` : `skill '${skill}' has no usage record`,
		);
	}

	/**
	 * Hand a skill to automatic management.
	 * @param skill - the skill directory name.
	 * @returns the outcome plus the fresh listing.
	 */
	async adopt(skill: string): Promise<SkillMutationView> {
		const landed = await adopt(this.host.buddyStore.skillUsage(), skill);
		return await this.mutationView(
			landed,
			landed ? `'${skill}' is now curator-managed` : `skill '${skill}' has no usage record`,
		);
	}

	/**
	 * Undo one ledger entry.
	 * @param entryId - the ledger key.
	 * @returns whether it applied, and what it did.
	 */
	async rollback(entryId: string): Promise<{ success: boolean; message: string }> {
		const outcome = await rollbackEntry(this.ledgerDeps(), entryId);
		return { success: outcome.ok, message: outcome.message };
	}

	// ── the panel reads ──────────────────────────────────────────────────────

	/**
	 * Every skill under the buddy root, merged with its telemetry.
	 *
	 * Discovery is the providers' own coupling point, so the tiers are read from
	 * them rather than re-parsed here: the buddy provider contributes the `buddy`
	 * tier and the promoted provider the `global` / `project:` ones, so the tier
	 * a skill landed in *is* its visibility. A skill with no usage row reads as
	 * never used instead of vanishing — the row is only written once something
	 * observes the skill.
	 * @returns one owned view per skill, in name order.
	 */
	async listSkills(): Promise<readonly SkillView[]> {
		const root = this.host.buddyStore.paths.skills;
		const [buddy, promoted] = await Promise.all([
			createBuddyProvider({ skillsRoot: root }).list({}),
			// No `cwd`: the panel lists every promoted skill, including the
			// `project:` ones only sessions inside their path can load.
			createPromotedProvider({ skillsRoot: root }).list({}),
		]);
		const candidates = new Map<string, SkillCandidate>();
		for (const candidate of [...buddy, ...promoted]) candidates.set(candidate.name, candidate);
		const usage = this.host.buddyStore.skillUsage();
		const rows: SkillView[] = [];
		for (const candidate of candidates.values()) {
			const record = usage.get(candidate.name);
			const latest = record === undefined ? undefined : latestActivityAt(record);
			rows.push({
				name: candidate.name,
				description: candidate.description,
				visibility: visibilityOf(candidate.provider),
				useCount: record?.use_count ?? 0,
				activityCount: record === undefined ? 0 : activityCount(record),
				// `exactOptionalPropertyTypes`: omit rather than pass `undefined`.
				...(latest === undefined ? {} : { latestActivityAt: latest }),
				pinned: record?.pinned === true,
				curatorManaged: record?.created_by === "agent",
			});
		}
		return rows.sort((left, right) => left.name.localeCompare(right.name));
	}

	/**
	 * The raw usage rows, so the panel can show counters the listing does not.
	 * @returns one owned view per recorded skill, in name order.
	 */
	async usage(): Promise<readonly SkillUsageView[]> {
		const rows: SkillUsageView[] = [];
		for (const [skill, record] of this.host.buddyStore.skillUsage().entries()) {
			const latest = latestActivityAt(record);
			rows.push({
				skill,
				createdBy: record.created_by === "agent" ? "agent" : "human",
				useCount: record.use_count,
				viewCount: record.view_count,
				patchCount: record.patch_count,
				...(record.last_used_at === null ? {} : { lastUsedAt: record.last_used_at }),
				...(record.last_viewed_at === null ? {} : { lastViewedAt: record.last_viewed_at }),
				...(record.last_patched_at === null ? {} : { lastPatchedAt: record.last_patched_at }),
				...(latest === undefined ? {} : { latestActivityAt: latest }),
				activityCount: activityCount(record),
				pinned: record.pinned === true,
				archived: record.state === "archived" || record.archived_at !== null,
			});
		}
		return rows.sort((left, right) => left.skill.localeCompare(right.skill));
	}

	/**
	 * Every review's attributed cost, newest first.
	 * @returns one owned view per review-usage row.
	 */
	async reviewUsage(): Promise<readonly ReviewUsageView[]> {
		const rows: ReviewUsageView[] = [];
		for (const [, record] of this.host.buddyStore.reviewUsage().entries()) {
			rows.push({
				id: record.id,
				ts: record.ts,
				parentSessionId: record.parentSessionId,
				childSessionId: record.childSessionId,
				provider: record.provider,
				model: record.model,
				steps: record.steps,
				inputTokens: record.inputTokens,
				outputTokens: record.outputTokens,
				cacheReadTokens: record.cacheReadTokens,
				outcome: record.outcome,
			});
		}
		return rows.sort((left, right) => (left.ts < right.ts ? 1 : -1));
	}

	/**
	 * The mutation ledger, newest first — the rollback list's source.
	 * @returns one owned view per entry, carrying only file paths from the manifests.
	 */
	async ledger(): Promise<readonly SkillLedgerView[]> {
		const entries = await listEntries(this.ledgerDeps());
		return entries.map((entry) => ({
			id: entry.id,
			ts: entry.ts,
			actor: entry.actor,
			action: entry.action,
			skill: entry.skill,
			before: entry.before.map((item) => item.path),
			after: entry.after.map((item) => item.path),
		}));
	}

	/**
	 * Remember that a review loaded a skill, so read-before-write can be judged.
	 *
	 * Called by the preset row's `tools/post-execute` observer, the only place a
	 * `skill` tool call is visible. Kept host-side because the verdict is host
	 * state: `manage.ts` must not learn where provenance or the read set come
	 * from.
	 * @param sessionId - the review sub-session that did the reading.
	 * @param skill - the skill name it read.
	 */
	noteSkillRead(sessionId: string, skill: string): void {
		markRead(this.readSets, sessionId, skill);
	}

	// ── internals ────────────────────────────────────────────────────────────

	/**
	 * Build the coordinator's dependencies over this row's store and soft planes.
	 *
	 * A method rather than free code so the seam closes over *this* instance:
	 * the `spawn` seam needs the pending parent and the live-review map, and the
	 * coordinator is the one object that must not know a cordis context exists.
	 * @returns the seam `ReviewCoordinator` was written against.
	 */
	private coordinatorDeps(): ReviewCoordinatorDeps {
		return {
			config: () => this.host.buddyStore.config(),
			spawn: (input) => this.spawnReview(input),
			interrupt: (childSessionId) => this.stopReview(childSessionId),
			now: () => new Date().toISOString(),
			log: (line) => console.error(`dsh-buddy-skills: ${line}`),
			reviewUsage: this.host.buddyStore.reviewUsage(),
		};
	}

	/**
	 * Start one review child through the soft `subagents` plane.
	 *
	 * Asynchronous because the child does not exist until `start` resolves, and
	 * the coordinator needs its **real id** before it can charge events or
	 * enforce a budget against it: awaiting here is what makes the returned
	 * `childSessionId` exact instead of a guess the coordinator would have to
	 * resolve from a single flying review.
	 *
	 * A missing plane or a missing parent Agent **rejects**, which the coordinator
	 * records as a failed — and still attributed — review. That is deliberate:
	 * returning a promise nothing settles would hang the review's `finally` and
	 * leave `inFlight` set for the conversation forever.
	 * @param input - the parent conversation, provider, prompt, and whitelist.
	 * @returns the child's id and the promise that settles when it ends.
	 */
	private async spawnReview(input: ReviewSpawnInput): Promise<ReviewSpawnResult> {
		const subagents = this.host.get("subagents") as SubagentService | undefined;
		const parent = this.pendingParent ?? this.agentFor(input.parentSessionId);
		if (subagents === undefined) throw new Error("the subagent plane is unavailable");
		if (parent === undefined) throw new Error("the conversation has no live agent");
		const settings = this.host.buddyStore.config().skills;
		// The route override belongs to the cheap-model path; on the fork path the
		// child must inherit the parent's route or the seed's cache parity is lost.
		const agentOptions =
			input.provider === "spawn" ? { provider: settings.reviewProvider, model: settings.reviewModel } : undefined;
		const controller = new AbortController();
		const request: SubagentStartRequest = {
			// `prompt` is `ContentBlock[]` on the shipped contract: a bare string
			// would be rejected at start, so the coordinator's text becomes one
			// text block.
			prompt: [{ type: "text", text: input.prompt }],
			parent,
			signal: controller.signal,
			label: "buddy skill review",
			// `toolFilter` is one visibility gate — an off-list tool is absent from
			// the child's directory *and* refused at dispatch — so the
			// coordinator's whitelist is the review's whole capability boundary.
			toolFilter: { allow: input.toolFilter },
			...(agentOptions === undefined ? {} : { agentOptions }),
		};
		const run = await subagents.start(input.provider, request);
		this.liveReviews.set(run.id, { run, parent, signal: controller });
		this.parentLinks.set(run.id, parent);
		this.reviewSessions.add(run.id);
		const ready = run;
		return {
			childSessionId: run.id,
			done: (async () => {
				try {
					// By contract `result` does not reject for a child-level failure;
					// an infrastructure fault can still reject it, and the
					// coordinator's `finally` attributes the review either way.
					return await ready.result;
				} catch (error) {
					console.error(`dsh-buddy-skills: a background review ended abnormally (${messageOf(error)})`);
					return undefined;
				} finally {
					this.liveReviews.delete(ready.id);
					this.parentLinks.delete(ready.id);
					this.reviewSessions.delete(ready.id);
					this.readSets.delete(ready.id);
				}
			})(),
		};
	}

	/**
	 * Stop one review, under the ancestor authority spec §7.4 asks for.
	 *
	 * Two mechanisms, deliberately. `interrupt` is the continuation-scoped stop
	 * the spec names, and it must not throw out of a disposal; `dispose` is what
	 * actually ends a **one-shot** run, because the continuation manager admits
	 * interrupt only for continuable Activations and treats a one-shot id as an
	 * accepted no-op. Without the second call an over-budget review would keep
	 * spending while the row believed it had stopped it.
	 * @param childSessionId - the review child to stop.
	 * @returns resolution once the run's teardown has settled.
	 */
	private async stopReview(childSessionId: string): Promise<void> {
		const live = this.liveReviews.get(childSessionId);
		this.liveReviews.delete(childSessionId);
		if (live === undefined) return;
		// The request signal first: it is the cancellation channel `start` was
		// handed, and the providers cancel the published child's remaining work on
		// it. `interrupt` and `dispose` follow as the declared and the definitive
		// stop respectively.
		live.signal.abort();
		const subagents = this.host.get("subagents") as SubagentService | undefined;
		if (subagents !== undefined) {
			try {
				subagents.interrupt(childSessionId, { kind: "ancestor", agent: live.parent });
			} catch (error) {
				console.error(`dsh-buddy-skills: interrupting a review failed (${messageOf(error)})`);
			}
		}
		try {
			await live.run.dispose();
		} catch (error) {
			console.error(`dsh-buddy-skills: disposing a review failed (${messageOf(error)})`);
		}
	}

	/**
	 * Build the write path's dependencies.
	 * @param sessionId - the calling session, empty for a panel promotion.
	 * @param actor - the ledger actor to stamp; defaults to the caller's identity.
	 * @returns paths, tables, clock and the jurisdiction guard.
	 */
	private manageDeps(sessionId: string, actor?: SkillLedgerRecord["actor"]): ManageDeps {
		const store = this.host.buddyStore;
		const reviewSession = this.reviewSessions.has(sessionId);
		let reads = this.readSets.get(sessionId);
		if (reads === undefined) {
			reads = new Set<string>();
			this.readSets.set(sessionId, reads);
		}
		const readSet = reads;
		return {
			home: store.paths.home,
			snapshotsDir: store.paths.skillSnapshots,
			skillsRoot: store.paths.skills,
			ledger: store.skillLedger(),
			usage: store.skillUsage(),
			actor: () => actor ?? (reviewSession ? "agent" : "user"),
			now: () => new Date().toISOString(),
			guard: (action: Operation["action"], skill: string): WriteVerdict => {
				// The foreground's own home is theirs: jurisdiction exists to keep
				// the *automatic* review inside what it created.
				if (!reviewSession) return { allow: true };
				return backgroundWriteGuard({
					reviewSession,
					record: store.skillUsage().get(skill),
					action: action as SkillAction,
					skill,
					readSet,
				});
			},
		};
	}

	/**
	 * Build the ledger-only dependencies rollback and listing need.
	 * @returns the home, the snapshot directory and the ledger table.
	 */
	private ledgerDeps(): LedgerDeps {
		return {
			home: this.host.buddyStore.paths.home,
			snapshotsDir: this.host.buddyStore.paths.skillSnapshots,
			ledger: this.host.buddyStore.skillLedger(),
		};
	}

	/**
	 * Build one panel write's answer, with the listing that follows it.
	 * @param success - whether the write applied.
	 * @param message - the line to show.
	 * @returns the outcome plus the fresh listing.
	 */
	private async mutationView(success: boolean, message: string): Promise<SkillMutationView> {
		return { success, message, skills: await this.listSkills() };
	}

	/**
	 * The live Agent a session id belongs to, through the soft registry.
	 * @param sessionId - the durable session id.
	 * @returns the Agent, or `undefined` when the registry is absent or the session is not live.
	 */
	private agentFor(sessionId: string): ParentAgent | undefined {
		const agents = this.host.get("agents") as AgentRegistry | undefined;
		return agents?.get(sessionId);
	}

	/**
	 * The transcript surface a digest would need, or nothing.
	 *
	 * Soft and best-effort: without `sessionQuery` the cheap-model path cannot
	 * build a digest while the fork path is unaffected, so a failed read is a
	 * degraded review rather than a failed turn.
	 * @param sessionId - the conversation that just ended a turn.
	 * @returns the digest messages, or `undefined`.
	 */
	private async surfaceFor(sessionId: string): Promise<readonly DigestMessage[] | undefined> {
		const query = this.host.get("sessionQuery") as SessionQuery | undefined;
		if (query === undefined) return undefined;
		try {
			const snapshot = await query.readSurface(sessionId);
			return digestMessages(snapshot.events);
		} catch (error) {
			console.error(`dsh-buddy-skills: reading the session surface failed (${messageOf(error)})`);
			return undefined;
		}
	}
}

/**
 * Register the service, the endpoints, the heartbeat bound and the coordinator.
 * @param ctx - the plugin fiber's context.
 */
export function apply(ctx: PluginContext): void {
	// A synchronous effect, so the disposer exists before `apply` returns: the
	// coordinator's teardown is registered before anything can start a review,
	// and a dispose that lands mid-`apply` still unwinds.
	ctx.effect(() => {
		const service = new BuddySkillsService(ctx);
		// The panel's wire surface. A missing `typert` throws out of here
		// deliberately — a row whose panel is invisible is a failure to report,
		// not to survive.
		new BuddySkillsGateway(ctx, service as unknown as BuddySkillsRemote);
		return () => {
			void service.dispose();
		};
	}, "dsh-buddy: skills");

	// The heartbeat bound (spec §5.2): if the agent row has not reported by now,
	// the preset did not mount its half — the failure mode this phase exists to
	// make visible. `unref`ed so a pending bound never holds the process open,
	// and cleared on disposal so it dies with the fiber: a bare `setTimeout`
	// would outlive the row and fire against a disposed service. It reads the
	// service through `ctx.get` at firing time rather than closing over it,
	// which keeps the timer independent of construction order.
	ctx.effect(() => {
		const timer = setTimeout(() => {
			const live = ctx.get("buddySkills") as BuddySkillsService | undefined;
			live?.notePresetSyncMissed();
		}, PRESET_HEARTBEAT_TIMEOUT_MS);
		timer.unref();
		return () => clearTimeout(timer);
	}, "dsh-buddy: skills heartbeat");
}

/**
 * The visibility tier a provider's candidate belongs to.
 * @param provider - the provider name from the candidate.
 * @returns the tier name the panel shows.
 */
function visibilityOf(provider: string): string {
	return provider === PROMOTED_SKILL_PROVIDER_NAME ? "global" : "buddy";
}

/**
 * Normalize an untrusted operation batch.
 *
 * A malformed entry stays in the batch as an object with an impossible action,
 * so the write path refuses the whole batch and touches nothing. Dropping it
 * instead would let a client that sent three operations be told "applied 2",
 * which is the one outcome an atomic batch must never report.
 * @param operations - the wire value.
 * @returns the operations the write path should judge.
 */
function cleanOperations(operations: readonly unknown[]): readonly Operation[] {
	return operations.map((entry) => {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			return { action: "" as Operation["action"], name: "" };
		}
		return entry as unknown as Operation;
	});
}

/** The two word tiers one visibility write accepts verbatim. */
const WORD_TIERS = ["buddy", "global"] as const;

/** The prefix a path-scoped tier carries. */
const PROJECT_PREFIX = "project:";

/**
 * Parse one visibility value.
 * @param tier - the untrusted wire value.
 * @returns the canonical tier, or `undefined` when it is not one.
 */
function parseTier(tier: unknown): string | undefined {
	if (typeof tier !== "string") return undefined;
	const value = tier.trim();
	if ((WORD_TIERS as readonly string[]).includes(value)) return value;
	if (value.startsWith(PROJECT_PREFIX) && value.slice(PROJECT_PREFIX.length).trim() !== "") return value;
	return undefined;
}

/**
 * Rewrite one document's `visibility` frontmatter value.
 *
 * The value the providers resolve comes from the frontmatter, so a promotion has
 * to be a document edit. A path that would confuse a YAML reader — it carries
 * `:`, `#`, or surrounding space — is double-quoted, because an unquoted
 * `project: /a b` would otherwise parse as something else and silently leave the
 * skill in the buddy tier, which is exactly the failure a promotion must not
 * have.
 * @param document - the SKILL.md text.
 * @param tier - the canonical tier to write.
 * @returns the patched document, or `undefined` when there is no frontmatter.
 */
function withVisibility(document: string, tier: string): string | undefined {
	const fence = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(document);
	if (fence === null || fence[1] === undefined || fence.index === undefined) return undefined;
	const rendered = needsQuoting(tier) ? `"${tier}"` : tier;
	const body = fence[1];
	const line = /^[ \t]*visibility[ \t]*:.*$/mu;
	const head = document.slice(0, fence.index);
	const tail = document.slice(fence.index + fence[0].length);
	return line.test(body)
		? `${head}---\n${body.replace(line, `visibility: ${rendered}`)}\n---${tail}`
		: `${head}---\n${body}\nvisibility: ${rendered}\n---${tail}`;
}

/**
 * @param value - a frontmatter scalar.
 * @returns `true` when it must be quoted to parse back as itself.
 */
function needsQuoting(value: string): boolean {
	return /[:#]/.test(value) || value !== value.trim() || value === "";
}

/**
 * @returns the digest messages one surface snapshot carries.
 */
function digestMessages(events: readonly unknown[]): readonly DigestMessage[] {
	const messages: DigestMessage[] = [];
	for (const event of events) {
		if (typeof event !== "object" || event === null) continue;
		const record = event as { type?: unknown; content?: unknown };
		const role =
			record.type === "user/message"
				? "user"
				: record.type === "assistant/message"
					? "assistant"
					: record.type === "tool/result"
						? "tool"
						: undefined;
		if (role === undefined) continue;
		const text = textOf(record.content);
		// An assistant turn with tool calls is what the digest renders as a name
		// list; the surface does not carry those names here, so the text alone is
		// what this row can honestly contribute.
		messages.push({ role, text });
	}
	return messages;
}

/**
 * Flatten one event's content blocks to plain text.
 * @param content - the untrusted content value.
 * @returns the concatenated text blocks, newline-joined.
 */
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const record = block as { type?: unknown; text?: unknown };
		if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
	}
	return parts.join("\n");
}

/**
 * Read a session id off anything that names one.
 * @param actor - an Agent, a session header, a bare id, or nothing.
 * @returns the id, or the empty string.
 */
function sessionIdOf(actor: SessionActor): string {
	if (typeof actor === "string") return actor;
	const id = actor?.id;
	return typeof id === "string" ? id : "";
}

/**
 * @param error - an unknown throwable.
 * @returns its message, or the value rendered.
 */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
