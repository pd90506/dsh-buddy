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
 *   write path accepts has no `visibility`, *and* the write path refuses any
 *   resulting document whose `visibility` is neither `buddy` nor the tier the
 *   skill already had — so `create`/`edit`/`patch` cannot smuggle one in through
 *   their content either. {@link BuddySkillsService.setVisibility} is the only
 *   writer admitted past that check, and it is reachable only through the
 *   `buddySkills/visibility` endpoint. That is the one hard guarantee that a
 *   habit learned in Buddy cannot leak into ordinary coding sessions.
 * @module dsh-buddy/skills
 */
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Service } from "@deepseek-ai/cordis";
// `import type` only, from the real package: the session envelope and the
// surface event are what the log appends, and a locally declared shape is what
// let both the review budgets and the digest adapter read the wrong level.
import type { SessionEvent, SurfaceEvent } from "@deepseek-ai/dsh-session";
import type { KvTable } from "@deepseek-ai/dsh-storage-domain";
import type { BuddyConfig } from "../config.ts";
import type { BuddyPaths } from "../paths.ts";
import type { ReviewUsageRecord, SkillLedgerRecord, SkillUsageRecord } from "../store/domain.ts";
// `import type` only: this module must not pull `src/store/preset.ts` — and its
// `node:crypto` / `node:fs` imports — into the built `lib/skills.js`.
import type { PresetOwnership } from "../store/preset.ts";
import type { DigestMessage } from "./digest.ts";
import {
	BuddySkillsGateway,
	type BuddySkillsRemote,
	type ReviewUsageView,
	type SkillLedgerView,
	type SkillMutationView,
	type SkillUsageView,
	type SkillView,
	type SkillsStatusView,
} from "./gateway.ts";
// Re-exported from the leaf module rather than declared here: the tool that reads
// this list lives in the preset row, which is a **separate artifact**, and an
// import from this module would drag this row's whole graph into that bundle.
// Re-exporting keeps `skillsRow.SKILL_MANAGE_ACTIONS` working for every existing
// reader while giving the preset row a leaf to import instead.
export { SKILL_MANAGE_ACTIONS } from "./actions.ts";
import { backgroundWriteGuard, markRead, type WriteVerdict } from "./guards.ts";
import { listEntries, rollbackEntry, type LedgerDeps } from "./ledger.ts";
import { createPromotedProvider } from "./provider.ts";
import { runOperations, type ManageDeps, type Operation, type SkillAction } from "./manage.ts";
import { ReviewCoordinator, type ReviewCoordinatorDeps, type ReviewSpawnInput, type ReviewSpawnResult } from "./review.ts";
import { activityCount, adopt, bumpUse, latestActivityAt, setPinned } from "./usage.ts";
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

/** The `buddyStore` members this row uses. */
interface StoreHandle {
	readonly paths: BuddyPaths;
	config(): BuddyConfig;
	skillUsage(): KvTable<string, SkillUsageRecord>;
	skillLedger(): KvTable<string, SkillLedgerRecord>;
	reviewUsage(): KvTable<string, ReviewUsageRecord>;
	/** Who the `buddy` preset directory belongs to, resolved per call. */
	presetOwnership(): Promise<PresetOwnership>;
}

/** The lifecycle and invalidation control one provider registration borrows. */
interface SkillProviderControl {
	/** Aborts when the exact provider registration is disposed. */
	readonly signal: AbortSignal;
	/** Invalidate completed catalogs, while the registration remains active. */
	invalidate(): void;
}

/**
 * The `ctx.skills` slice this row registers the promoted provider against.
 *
 * Declared locally like every other soft-dependency shape here: `dsh-skill` is
 * not in this package's dependency closure, so the row reads exactly the one
 * method it calls rather than importing the registry.
 */
interface SkillRegistryHandle {
	/**
	 * Borrow one same-process provider into the **calling context's layer**.
	 * @param create - the factory, handed this registration's control.
	 * @returns the disposer that unregisters it.
	 */
	registerProvider(create: (control: SkillProviderControl) => { readonly name: string }): () => void;
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

/**
 * A live Agent, with the route it was composed for.
 *
 * `Agent.options` is the *documented* runtime face of a live agent
 * (`@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:139-141`, declared as
 * `readonly options: AgentOptions` on the `Agent` interface and populated by the
 * loop at construction — `dsh-agent-loop/lib/index.js:757`). This is the only
 * route accessor a host row has: neither `SessionHeader` nor
 * `SessionQueryEngine.readSurface` carries a provider/model pair, and the
 * session-controller's durable `modelSelection` is a projection over a live
 * `Session` object this row cannot reach.
 */
interface LiveAgent extends ParentAgent {
	readonly options?: { readonly provider?: string; readonly model?: string };
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
	get(sessionId: string): LiveAgent | undefined;
}

/**
 * The `sessionQuery` slice this row reads.
 *
 * Deliberately no route reader: no shipped `sessionQuery` method returns one
 * (there is no `readRoute` anywhere in the packages), so asking for one would
 * make the row depend on a method that does not exist. The route comes from the
 * live Agent instead — see {@link LiveAgent}.
 */
interface SessionQuery {
	/** The transcript surface; only the cheap-model (digest) path needs it. */
	readSurface(sessionId: string): Promise<{ readonly events: readonly SurfaceEvent[] }>;
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

	/**
	 * The two provider registrations' controls, handed over by the rows that own
	 * them.
	 *
	 * Both are held because **every** write path this row owns changes what the
	 * buddy provider contributes (a create lands in the shared skills root) and
	 * some of them change what the promoted provider contributes as well (a
	 * visibility change, or a document that carries a `visibility:` line). The
	 * registry caches completed catalogs and there is no public
	 * `ctx.skills.invalidate()`, so these controls are the only way to say so.
	 *
	 * The buddy control arrives from the **preset row**, which owns that
	 * registration (spec §4.1's layer split); the promoted one from this row's own
	 * `apply`. A control whose registration has since been disposed needs no
	 * cleanup here: `dsh-skill` looks the registration up by provider identity
	 * before touching the cache (`SkillRegistry.registerProvider`'s `invalidate`,
	 * `dsh-skill/lib/index.js:150-156`) and the disposable clears that reference,
	 * so a stale call is a no-op rather than a resurrection.
	 */
	private buddyControl: SkillProviderControl | undefined;

	/** The promoted provider registration's control — see {@link buddyControl}. */
	private promotedControl: SkillProviderControl | undefined;

	/** Whether the agent row has reported that it mounted. */
	private heartbeat = false;

	/** Whether the heartbeat deadline passed without a report. */
	private heartbeatMissed = false;

	/**
	 * Set by {@link dispose}. A review whose `subagents.start` was still in
	 * flight when the row unloaded must notice and stop itself: nothing else is
	 * left to enforce its budgets or attribute its cost.
	 */
	private disposed = false;

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
	async refine(
		agent: ParentAgent,
		focus: string,
		route?: { readonly provider: string; readonly model: string },
	): Promise<void> {
		this.pendingParent = agent;
		try {
			// The route and the transcript travel exactly as they do on the
			// automatic path: §7.1's decision compares the configured review model
			// against the route this session really ran on, and the spawn path
			// cannot build a digest without the surface. An explicit `/refine` is
			// the *most* user-visible review there is, so it must not be the one
			// that silently falls back to `buddy.model` or reviews blind.
			// A caller with no route to hand over still gets one: prefer the live
			// agent the registry resolves — that object carries `options` — and
			// fall back to the caller's own Agent, which a command invocation may
			// hold as a bare `{ id }`. The documented fallback to `config().model`
			// is taken only when the route is genuinely unavailable, and is logged
			// when it is.
			const resolved = route ?? this.routeFor(this.agentFor(agent.id) ?? agent);
			await this.coordinator.refine(agent.id, focus, {
				...(resolved === undefined ? {} : { route: resolved }),
				surface: () => this.surfaceFor(agent.id),
			});
		} finally {
			this.pendingParent = undefined;
		}
	}

	/**
	 * Observe one event of a review's child session and enforce its budgets.
	 * @param childSessionId - the child session the event belongs to.
	 * @param event - the real session envelope; only its type and data are read.
	 */
	noteChildEvent(childSessionId: string, event: SessionEvent): void {
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
		this.disposed = true;
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

	/**
	 * The preset-sync notice, as the panel reads it (spec §5.2's third bullet).
	 *
	 * The two heartbeat fields are the same fact from both sides so a panel can
	 * render whichever it wants without knowing which one the bound writes.
	 * `preset` is the other half of the diagnosis — told apart, a missing row
	 * because a heartbeat never came and a row that can never come because the
	 * user's own preset owns the id are two different things to a user.
	 * @returns whether the agent row reported in, whether the notice shows, and
	 * who owns the preset directory.
	 */
	async status(): Promise<SkillsStatusView> {
		return {
			synced: this.heartbeat,
			missed: this.heartbeatMissed,
			preset: await this.host.buddyStore.presetOwnership(),
		};
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
		// A `create` or `edit` carries the **whole document** and a `patch` can
		// rewrite a single line, so a batch can change the frontmatter `visibility`
		// the promoted provider filters on without ever going through
		// {@link setVisibility}. Nothing in the outcome says whether it did, and a
		// needless invalidation costs only the next reader one catalog rebuild,
		// while a missed one leaves the promotion invisible to ordinary sessions —
		// so every successful batch refreshes both catalogs.
		if (outcome.success) this.invalidateCatalogs();
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
		//
		// `maySetVisibility` is what makes this the **only** writer that may raise
		// a tier: the same `runOperations` path, reached by `skill_manage`, refuses
		// a resulting non-buddy `visibility` outright (spec §4.3). Without the flag
		// the promotion would be refused here too; without the refusal the tool
		// could promote a skill with a `visibility:` line and no human involved.
		const outcome = await runOperations(this.manageDeps("", "user", true), [
			{ action: "patch", name: skill, old_string: document, new_string: patched },
		]);
		// The rewrite moves the skill between the two tiers, so both cached
		// catalogs are stale the instant this lands.
		if (outcome.success) this.invalidateCatalogs();
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
		// A rollback restores the SKILL.md bytes a prior write replaced — which may
		// be the very `visibility` line a promotion wrote — so both catalogs are
		// stale after it too.
		if (outcome.ok) this.invalidateCatalogs();
		return { success: outcome.ok, message: outcome.message };
	}

	// ── the panel reads ──────────────────────────────────────────────────────

	/**
	 * Every skill under the buddy root, merged with its telemetry.
	 *
	 * The listing enumerates the skills root directly — one level of directories
	 * with a readable `SKILL.md` — and reads each document's name, description
	 * and declared tier, rather than asking the two providers. The providers
	 * answer "what may *this caller* see": the promoted one filters
	 * `project:<path>` skills by cwd, so a provider-based listing would hide a
	 * promoted project skill from the panel entirely, and it cannot distinguish
	 * the two promoted tiers at all. A skill with no usage row reads as never
	 * used instead of vanishing — the row is only written once something observes
	 * the skill.
	 * @returns one owned view per skill, in name order.
	 */
	async listSkills(): Promise<readonly SkillView[]> {
		const usage = this.host.buddyStore.skillUsage();
		const rows: SkillView[] = [];
		for (const entry of await enumerateSkills(this.host.buddyStore.paths.skills)) {
			const record = usage.get(entry.name);
			const latest = record === undefined ? undefined : latestActivityAt(record);
			rows.push({
				name: entry.name,
				description: entry.description,
				// The tier the document declares, *not* a guess from a provider
				// name: `global` and `project:<path>` are served by the same
				// provider, so a provider cannot tell them apart — and a
				// `project:` skill must stay visible to the panel even when no
				// session's cwd would make it loadable.
				visibility: entry.visibility,
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
	 * The absolute skills root both providers are built over.
	 *
	 * The preset row resolves its two providers from here rather than importing
	 * `resolveBuddyPaths` or reaching into the store row: the path travels as a
	 * service call, so the preset bundle carries no store logic and there is one
	 * authority for where a buddy skill lives.
	 * @returns `<buddy home>/main/skills`.
	 */
	skillsRoot(): string {
		return this.host.buddyStore.paths.skills;
	}

	/**
	 * Record one skill load: the usage bump **and** the read mark.
	 *
	 * Called by the preset row's `tools/post-execute` observer, the only place a
	 * `skill` tool call is visible. The two halves belong to one call because they
	 * observe one event: a load is a use (the counters a pruning pass reads), and
	 * for an automatic review it is also the read that read-before-write is
	 * judged against. Splitting them would leave the preset row deciding which
	 * sessions get a read mark, which is host state `manage.ts` must not learn
	 * from a caller.
	 *
	 * Neither half rejects — `bumpUse` swallows a table failure and the read set
	 * is a plain map — so this resolves even when the telemetry write fails.
	 * @param sessionId - the session that did the loading.
	 * @param skill - the skill name it loaded.
	 */
	async noteSkillUsed(sessionId: string, skill: string): Promise<void> {
		await bumpUse(this.host.buddyStore.skillUsage(), skill, new Date().toISOString());
		markRead(this.readSets, sessionId, skill);
	}

	/**
	 * Take ownership of the **buddy** provider registration's control.
	 *
	 * Called by the preset row at the moment it registers that provider. The
	 * control is registration-scoped and only the registering factory is ever
	 * handed it, while everything that makes the buddy catalog stale is a write
	 * path on *this* row — a panel create as much as a tool one, since both land
	 * in the same skills root. Handing it over here is what keeps one owner for
	 * invalidation instead of two half-owners, one of which (the panel path) would
	 * otherwise never reach the buddy catalog at all.
	 * @param control - the lifecycle and invalidation control of that registration.
	 */
	noteBuddyControl(control: SkillProviderControl): void {
		this.buddyControl = control;
	}

	/**
	 * Take ownership of the promoted provider registration's control.
	 *
	 * Called by this row's own `apply` at the moment it registers the promoted
	 * provider, for the same reason as {@link noteBuddyControl}.
	 * @param control - the lifecycle and invalidation control of that registration.
	 */
	notePromotedControl(control: SkillProviderControl): void {
		this.promotedControl = control;
	}

	// ── internals ────────────────────────────────────────────────────────────

	/**
	 * Refresh both providers' cached catalogs, for the registrations that exist.
	 *
	 * Both, always, because the two tiers read the same skills root: one write can
	 * change what either contributes, and telling them apart would mean parsing
	 * the batch for a `visibility:` line — a cheap over-invalidation against a
	 * silent miss, and the miss is the failure the whole write path guards
	 * against. A missing control means no `skills` registry was present at mount,
	 * so there is no catalog to refresh — a degraded plane, never an error.
	 */
	private invalidateCatalogs(): void {
		this.buddyControl?.invalidate();
		this.promotedControl?.invalidate();
	}

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
		if (this.disposed) {
			// The row unloaded while `start` was in flight. Nothing is left to
			// charge this child's events or attribute its cost, so it is stopped
			// here through the same abort/dispose chain a budget stop uses. The
			// review is *stopped*, which the coordinator records in its `finally`
			// with a `completed` outcome and whatever the child managed to spend —
			// there is no child-level failure to report, and claiming one would
			// misdescribe a review that was simply cut short.
			controller.abort();
			await run.dispose().catch((error: unknown) => {
				console.error(`dsh-buddy-skills: disposing a review started during unload failed (${messageOf(error)})`);
			});
			console.error("dsh-buddy-skills: a background review was stopped because the row unloaded while starting it");
			return { childSessionId: run.id, done: Promise.resolve() };
		}
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
	 * @param maySetVisibility - the human-only promotion rail; `false` for every
	 *   `skill_manage` batch, which may never raise a skill's scope (spec §4.3).
	 * @returns paths, tables, clock and the jurisdiction guard.
	 */
	private manageDeps(sessionId: string, actor?: SkillLedgerRecord["actor"], maySetVisibility = false): ManageDeps {
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
			maySetVisibility,
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
	private agentFor(sessionId: string): LiveAgent | undefined {
		const agents = this.host.get("agents") as AgentRegistry | undefined;
		return agents?.get(sessionId);
	}

	/**
	 * The route one live Agent's requests use.
	 *
	 * Read from `agent.options` — see {@link LiveAgent} for why that is the only
	 * route source a host row has. A route that cannot be resolved is **said
	 * out loud**: §7.1's fork/spawn choice compares the configured review model
	 * against this pair, and silently measuring against `buddy.model` instead is
	 * wrong for any session pinned by chat `/model` or by the global default.
	 * The log line is what keeps that degradation actionable rather than
	 * invisible.
	 * @param agent - the conversation's live Agent.
	 * @returns the provider/model pair, or `undefined` when it cannot be read.
	 */
	private routeFor(agent: LiveAgent): { provider: string; model: string } | undefined {
		const options = agent.options;
		const provider = options?.provider;
		const model = options?.model;
		if (typeof provider === "string" && provider !== "" && typeof model === "string" && model !== "") {
			return { provider, model };
		}
		console.error(
			"dsh-buddy-skills: the review route is unknown for this conversation; the fork/spawn decision falls back to buddy.model",
		);
		return undefined;
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
	ctx.effect((): (() => Promise<void>) => {
		const service = new BuddySkillsService(ctx);
		// The panel's wire surface, and only when there is a registry to put it
		// on. `typert` is soft, like every plane besides the store: without it the
		// row still publishes `ctx.buddySkills` — the preset row and the
		// coordinator read that service — and the only loss is the panel, which
		// is reported rather than thrown.
		//
		// Constructed here rather than inside the gateway because the gateway's
		// base class establishes the typert binding at construction: a gateway
		// built with no registry cannot be built at all.
		if (ctx.get("typert") === undefined) {
			console.error(
				"dsh-buddy-skills: the typert registry is unavailable; the Skills panel will have no endpoints",
			);
		} else {
			new BuddySkillsGateway(ctx, service as unknown as BuddySkillsRemote);
		}
		// The **global layer's** half of the two-tier contract (spec §4.3, and
		// §3.1's host-row box). The promoted provider is what an *ordinary* coding
		// session merges, and a registration files into the layer of its calling
		// context's scope: this is a host row, so registering it here lands it in
		// the global layer — while the same factory registered from the preset row
		// would land in the buddy layer and make every panel promotion a silent
		// no-op for the sessions it was meant to reach. The two tiers are
		// registered from two rows for exactly that reason.
		//
		// Registered from *this* effect rather than a sibling one because the
		// registration has to hand its control to `service`, and that instance is
		// only in hand here. A sibling effect cannot substitute: a service a row
		// publishes is not resolvable through `ctx.get` until the row's fiber
		// finishes activating, so a second effect's body would find no
		// `buddySkills` and silently register nothing. (Verified against cordis:
		// inside `apply`, `ctx.get` answers `undefined` for a service the same
		// `apply` just provided.)
		//
		// `skills` is soft, like every plane besides the store: a profile with no
		// skill registry still gets `ctx.buddySkills` — the panel, the write path
		// and the coordinator all read it — and simply contributes no provider.
		const skills = ctx.get("skills") as SkillRegistryHandle | undefined;
		const unregisterPromoted =
			skills === undefined
				? undefined
				: skills.registerProvider((control) => {
						// Handed over so a visibility change and a write can refresh the cache.
						service.notePromotedControl(control);
						return createPromotedProvider({ skillsRoot: ctx.buddyStore.paths.skills });
					});
		// The promise is *returned*, not discarded: cordis awaits a thenable
		// disposer, and a dispose that resolves before the reviews have stopped
		// would let the row's teardown race its own children. The provider comes
		// out first — it is a registration, not part of the service's own state.
		return async () => {
			unregisterPromoted?.();
			await service.dispose();
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

/** One skill as the panel's own listing reads it. */
interface ListedSkill {
	readonly name: string;
	readonly description: string;
	readonly visibility: string;
}

/** The tier a skill with no usable declaration carries — the providers' own default. */
const FALLBACK_TIER = "buddy";

/**
 * Enumerate the skills root for the panel.
 *
 * Read from disk, one level down, rather than through the two providers: the
 * providers answer "what may *this caller* see", and the panel is not a caller —
 * it lists every skill in Buddy's home, including a `project:<path>` skill that
 * no live session's cwd would load. Names come from the directory, the
 * description and tier from the frontmatter, and an unreadable or unparsable
 * document falls back to the directory name and the `buddy` tier, which is the
 * same fail-closed shape the provider's own read path applies.
 * @param root - the absolute skills root.
 * @returns one entry per readable skill directory, in directory order.
 */
async function enumerateSkills(root: string): Promise<ListedSkill[]> {
	let entries: Dirent[];
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch {
		// First boot, or a home that was never created: an empty catalog is the
		// truth, not a failure.
		return [];
	}
	const listed: ListedSkill[] = [];
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		if (!entry.isDirectory()) continue;
		let document: string;
		try {
			document = await readFile(join(root, entry.name, "SKILL.md"), "utf8");
		} catch {
			// Not a skill directory (or unreadable): skip it rather than
			// inventing an entry the panel cannot do anything with.
			continue;
		}
		const frontmatter = parseFrontmatter(document);
		listed.push({
			// The name the provider would accept, or the directory name. Task 9's
			// grammar is the one authority here: a frontmatter name the registry
			// would reject must not become a panel row a human then acts on.
			name: listingName(frontmatter["name"], entry.name),
			description: frontmatter["description"] ?? "",
			// Fail closed to `buddy` for anything that is not a tier the write path
			// would itself accept — an unknown value is not a tier.
			visibility: validatedTier(frontmatter["visibility"]),
		});
	}
	return listed;
}

/**
 * Read a document's frontmatter as flat `key: value` scalars.
 *
 * The same flat subset the skill grammar uses, and deliberately minimal: this is
 * a *display* read, so an exotic document costs one row its label rather than
 * the whole listing.
 * @param document - the SKILL.md text.
 * @returns the scalar pairs; empty when there is no frontmatter fence.
 */
function parseFrontmatter(document: string): Record<string, string> {
	const fence = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(document);
	const body = fence?.[1];
	if (body === undefined) return {};
	const values: Record<string, string> = {};
	for (const line of body.split(/\r?\n/u)) {
		const match = /^[ \t]*([A-Za-z][A-Za-z0-9_-]*)[ \t]*:[ \t]*(.*)$/u.exec(line);
		const key = match?.[1];
		const raw = match?.[2]?.trim();
		if (key === undefined || raw === undefined || raw === "") continue;
		values[key] = raw.replace(/^["']|["']$/gu, "");
	}
	return values;
}

/**
 * The name one listing row carries.
 *
 * A frontmatter `name` is used only when the providers' own validator accepts
 * it; anything else falls back to the directory name, which the provider's
 * discovery already treats as the skill's address. This keeps the panel from
 * showing a name that no provider would ever serve.
 * @param declared - the frontmatter `name`, when there was one.
 * @param directory - the directory entry name.
 * @returns the name to list under.
 */
function listingName(declared: string | undefined, directory: string): string {
	if (declared === undefined || declared.trim() === "") return directory;
	return validateSkillName(declared.trim()) === undefined ? declared.trim() : directory;
}

/**
 * The tier one listed row carries, judged by the write path's own vocabulary.
 *
 * An unknown or malformed declaration reads as `buddy` — the same fail-closed
 * default the providers apply on their read path. Passing an unrecognized value
 * through verbatim would put a tier on the panel that no promotion could have
 * written and that a human might act on.
 * @param declared - the raw `visibility` scalar, when the frontmatter had one.
 * @returns the tier, or `buddy`.
 */
function validatedTier(declared: string | undefined): string {
	const parsed = parseTier(declared);
	return parsed ?? FALLBACK_TIER;
}

/**
 * The digest messages one surface snapshot carries.
 *
 * The events are the real `SurfaceEvent`s `readSurface` answers with, and the
 * text lives on their `data`: a `user/message`'s data *is* the message, while an
 * `assistant/message`'s data wraps it as `message`. Reading `content` off the
 * envelope instead flattens every turn to the empty string — a digest banner
 * with no conversation under it, which is a blind review.
 * @param events - the surface events, oldest first.
 * @returns the digest messages the review's prompt is rendered from.
 */
function digestMessages(events: readonly SurfaceEvent[]): readonly DigestMessage[] {
	const messages: DigestMessage[] = [];
	for (const event of events) {
		if (event.type === "user/message") {
			messages.push({ role: "user", text: textOf(event.data.content) });
			continue;
		}
		if (event.type === "assistant/message") {
			// The tool-call blocks are the only source of the §7.1
			// `ASSISTANT[tools: …]` line, so they are read here or nowhere.
			const content = event.data.message.content;
			const toolNames = toolNamesOf(content);
			messages.push(toolNames.length === 0
				? { role: "assistant", text: textOf(content) }
				: { role: "assistant", text: textOf(content), toolNames });
			continue;
		}
		if (event.type === "tool/result") {
			// A tool result is only ever dropped by the digest, but it is kept in
			// the message list so the tail-ordering rule sees it.
			messages.push({ role: "tool", text: toolResultText(event.data.message.content) });
		}
	}
	return messages;
}

/**
 * The tool names one assistant message requested.
 * @param content - the message's content blocks.
 * @returns the invoked tool names, in call order.
 */
function toolNamesOf(content: readonly { readonly type: string; readonly name?: string }[]): string[] {
	const names: string[] = [];
	for (const block of content) {
		if (block.type === "tool-call" && typeof block.name === "string" && block.name !== "") names.push(block.name);
	}
	return names;
}

/**
 * Flatten one `tool/result` message's nested content to plain text.
 * @param content - the tool-result block(s).
 * @returns the text they carry.
 */
function toolResultText(content: readonly { readonly type: string; readonly content?: unknown }[]): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "tool-result") parts.push(textOf(block.content));
	}
	return parts.join("\n");
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
