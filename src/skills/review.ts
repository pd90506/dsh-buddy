/**
 * The review coordinator: when a conversation earns a review, which input path
 * that review takes, what it is allowed to spend, and what it cost.
 *
 * Three specs meet here. §6 owns the trigger — a post-commit `turn/end` that
 * completed, enough steps since the last review, never a delegated turn (which
 * is *also* what stops reviews nesting: a review's own child session ends a
 * turn too), and one review in flight per session at most, with a second
 * trigger silently **dropped** rather than queued. §7.4 owns the budgets — the
 * reference implementation stops a review at 16 model rounds or 600k cumulative
 * input tokens, and we enforce both by *observing the child session's own
 * events* rather than by asking it to police itself. §9.2 owns the accounting:
 * one `review_usage` row per review, attributed to the parent conversation, and
 * necessarily written in a `finally` because a review that burned tokens and
 * then threw must still be attributed.
 *
 * Three constraints shape the code more than the rules do:
 *
 * - **The child session is keyed by observation, not by assumption.** The host
 *   row opens the child session and feeds the coordinator its events, so
 *   `noteChildEvent` may arrive for a session this coordinator has not been
 *   told about yet (the id is only known once `spawn` returns). Events for an
 *   unknown child are attributed to the single review currently flying; a
 *   coordinator with several reviews running simply ignores them rather than
 *   guessing, and each of the budgets is enforced per child id.
 * - **Every event is untrusted.** This is a live session firehose: a malformed
 *   event must be ignored, never thrown on, or one bad payload could take out
 *   the host row's listener.
 * - **Nothing here knows about cordis.** The dependencies are plain callbacks
 *   handed to the constructor, so the class holds no Session, no service and no
 *   context — Task 13 publishes an instance of it as a service, and Task 14
 *   registers the wiring. `private` is used rather than `#` because a cordis
 *   service is dispatched through a `Reflect.apply` proxy and a `#` brand does
 *   not cross one.
 *
 * The two input paths are §7.1: the same-model path is a `fork`, which inherits
 * the conversation as its seed (and keeps the KV cache warm), so it needs no
 * transcript; the cheap-model path is a `spawn`, which has no seed and is
 * therefore handed {@link digestHistory}'s digest plus the prompt. Both get the
 * same tool whitelist, because §7.3's filter is what makes `write`/`edit`/`bash`
 * invisible to the review.
 * @module dsh-buddy/skills/review
 */
import { randomUUID } from "node:crypto";
import type { KvTable } from "@deepseek-ai/dsh-storage-domain";
import type { BuddyConfig } from "../config.ts";
import type { ReviewUsageRecord } from "../store/domain.ts";
import { digestHistory, type DigestMessage } from "./digest.ts";
import { REVIEW_TOOL_CLAUSE, SKILL_REVIEW_PROMPT } from "./prompt.ts";

/**
 * The tools a review sub-session may see (spec §7.3).
 *
 * DSH's `toolFilter` is a single visibility gate — an off-list tool is both
 * absent from the directory and refused at dispatch — so this list *is* the
 * review's capability boundary. It is a `readonly` tuple because it is handed
 * to the host row verbatim and no caller may widen it.
 */
export const REVIEW_TOOL_FILTER = ["skill", "skill_manage", "read", "grep", "glob"] as const;

/** The outcome stamped on a review that ran to its own end. */
const OUTCOME_COMPLETED = "completed";

/** The outcome stamped on a review whose `done` rejected. */
const OUTCOME_FAILED = "failed";

/**
 * One review's child session, as the coordinator's seam sees it.
 *
 * The host row creates the session; the coordinator only ever holds these two
 * values. `done` settles when the review's turn ends, and is deliberately
 * observed rather than assumed to resolve.
 */
export interface ReviewSpawnResult {
	/** The child session's id, used to interrupt it and to attribute its cost. */
	readonly childSessionId: string;
	/** Settles when the review finishes; may reject, which is still recorded. */
	readonly done: Promise<unknown>;
}

/** What the coordinator asks the host row to start. */
export interface ReviewSpawnInput {
	/**
	 * `"fork"` seeds the review with the parent's completed turns (same-model
	 * path); `"spawn"` starts with no seed, so the prompt carries the digest
	 * (cheap-model path). Spec §7.1.
	 */
	readonly provider: "fork" | "spawn";
	/** The review's prompt, already carrying the tool clause and any digest. */
	readonly prompt: string;
	/** The tool whitelist; always {@link REVIEW_TOOL_FILTER}. */
	readonly toolFilter: readonly string[];
}

/**
 * Everything the coordinator needs, and nothing live.
 *
 * A plain object of callbacks rather than a context: a test builds one from
 * counters, and the host row's implementation is where every cordis service
 * lives. `config` is a *function*, not a value, so a settings change lands on
 * the next call without the row having to rebuild the coordinator.
 */
export interface ReviewCoordinatorDeps {
	/** The current buddy settings; read per decision, never cached. */
	config(): BuddyConfig;
	/** Start the review sub-session and hand back its id and its settlement. */
	spawn(input: ReviewSpawnInput): ReviewSpawnResult;
	/** Stop a review that has run out of budget. Must not throw. */
	interrupt(childSessionId: string): void;
	/** The current time as ISO-8601, stamped onto the usage row. */
	now(): string;
	/** One diagnostic line. Must not throw. */
	log(line: string): void;
	/**
	 * The `review_usage` table (`ctx.buddyStore.reviewUsage`).
	 *
	 * Optional so the coordinator is constructible without a storage plane, but
	 * Task 13 always wires it. A write failure is logged, never thrown — the
	 * same discipline as `skills/usage.ts`, because telemetry must not break
	 * the turn that produced it.
	 */
	reviewUsage?: KvTable<string, ReviewUsageRecord> | undefined;
}

/** A review currently in flight, and the counters its child events move. */
interface ActiveReview {
	/** The conversation whose completed turn triggered this review. */
	readonly parentSessionId: string;
	/** What the review actually used, for the usage row. */
	readonly provider: "fork" | "spawn";
	/** The routed model id, or the empty string on the fork path. */
	readonly model: string;
	/** The id `spawn` returned, once it has returned. */
	childSessionId: string | undefined;
	/** Model rounds observed so far (`step/end`), not tool calls. */
	steps: number;
	/** Cumulative input tokens from every `assistant/message`. */
	inputTokens: number;
	/** Cumulative output tokens, recorded but not budgeted. */
	outputTokens: number;
	/** Cumulative cache reads — the evidence a same-model fork hit the cache. */
	cacheReadTokens: number;
	/** Cumulative cache writes, recorded but not budgeted. */
	cacheWriteTokens: number;
	/** Set once the budget has fired, so `interrupt` is called at most once. */
	interrupted: boolean;
}

/** Process-local sequence keeping two usage ids written in one millisecond apart. */
let usageSequence = 0;

/**
 * The review coordinator. One instance serves every conversation in the host
 * row; all state is keyed by session id.
 */
export class ReviewCoordinator {
	private readonly deps: ReviewCoordinatorDeps;
	/** Steps accumulated per parent session since its last review or reset. */
	private readonly steps = new Map<string, number>();
	/** Sessions with a review in flight, so a second trigger is dropped. */
	private readonly inFlight = new Set<string>();
	/** Reviews currently flying, keyed by parent session id. */
	private readonly active = new Map<string, ActiveReview>();
	/** Which child ids belong to a live review, for budget enforcement. */
	private readonly children = new Map<string, ActiveReview>();

	/**
	 * @param deps - the host row's seam: settings, spawn, interrupt, clock, log.
	 */
	constructor(deps: ReviewCoordinatorDeps) {
		this.deps = deps;
	}

	/**
	 * Count one model round of a conversation toward its next review (spec §6).
	 *
	 * Steps are model calls, not tool calls — the count that matters is how much
	 * work the conversation did, and `skill_manage` resets it separately. No-op
	 * while `skills.enabled` is false.
	 * @param sessionId - the conversation's session id.
	 */
	noteStep(sessionId: string): void {
		if (!this.deps.config().skills.enabled) return;
		this.steps.set(sessionId, (this.steps.get(sessionId) ?? 0) + 1);
	}

	/**
	 * Reset a conversation's counter because the model curated a skill itself.
	 *
	 * A `skill_manage` call is the nudge being satisfied by the foreground
	 * agent, so the next review is another interval away — and this clears the
	 * counter whether or not the review itself ran.
	 *
	 * The reset is deliberately **unconditional**, unlike {@link noteStep}: a
	 * curation that happened is a fact about the conversation regardless of the
	 * setting's value at the instant it happened, so it must still zero a
	 * counter that {@link noteStep} accumulated while the feature was on. Not
	 * counting and not clearing are different decisions.
	 * @param sessionId - the conversation whose tool call this was.
	 */
	noteSkillManageCalled(sessionId: string): void {
		this.steps.set(sessionId, 0);
	}

	/**
	 * The post-commit end of a turn: decide, and possibly start, a review.
	 *
	 * The chain is ordered and the order is the spec's (spec §6): a delegated
	 * turn returns before anything else is read (this is what makes a review
	 * unable to review a review), a turn that did not complete returns, an
	 * interval that has not elapsed returns, and a session with a review already
	 * flying is **dropped** — never queued, never deferred to the next turn.
	 *
	 * The trigger is claimed synchronously, before the first `await`, so two
	 * `turn/end` boundaries dispatched back to back cannot both see an idle
	 * session and start two reviews.
	 * @param input - the ended turn: its session, its reason, the transport facts
	 *   the host row knows, the route the conversation actually ran on, and its
	 *   transcript (`surface`, read only on the cheap-model path).
	 */
	async onTurnEnd(input: {
		sessionId: string;
		reason: { kind: string };
		origin?: string | undefined;
		delegationDepth?: number | undefined;
		/**
		 * The provider/model the triggering conversation actually ran on — the
		 * *parent route* §7.1 compares the configured review model against. The
		 * host row reads it off the session, so a route pinned by chat `/model`
		 * or by the global default is what the fork decision sees.
		 *
		 * **Omit it and the decision degrades** to measuring against
		 * `config().model`, which is only the route of a conversation that never
		 * overrode it. With the shipped all-empty default that makes every
		 * non-empty `reviewModel` look different and spawn on the aux model with
		 * a digest; and on a session `buddy.model` happens to match, a genuinely
		 * different review model can compare equal and fork onto the parent
		 * instead. Task 13 must pass this.
		 */
		route?: { provider: string; model: string } | undefined;
		surface?: readonly DigestMessage[] | undefined;
	}): Promise<void> {
		const { sessionId } = input;
		if (input.origin === "subagent" || (input.delegationDepth ?? 0) > 0) return;
		if (input.reason.kind !== "completed") return;

		const settings = this.deps.config().skills;
		if ((this.steps.get(sessionId) ?? 0) < settings.creationNudgeInterval) return;
		if (this.inFlight.has(sessionId)) return;

		// The claim happens here, synchronously: everything above and below this
		// line has no `await` between the check and the insert, so a second call
		// for the same session cannot pass the check.
		this.inFlight.add(sessionId);
		this.steps.set(sessionId, 0);
		try {
			await this.start(sessionId, settings, input);
		} finally {
			this.inFlight.delete(sessionId);
		}
	}

	/**
	 * Observe one event of a review's child session and enforce its budgets.
	 *
	 * Two observations matter (spec §7.4): a `step/end` is one model round
	 * toward `maxReviewSteps`, and an `assistant/message`'s `usage.inputTokens`
	 * accumulates toward `maxInputTokens`. Output and cache token counts are
	 * recorded too — `cacheReadTokens` especially, because "the same-model fork
	 * really did hit the cache" has to be a verifiable fact rather than a
	 * promise.
	 *
	 * Anything malformed is ignored: this method runs on a live event stream and
	 * must never throw into the host row's listener. Exceeding a budget calls
	 * `interrupt` once and keeps counting, because the child may still deliver
	 * events while it winds down and the row is what it cost either way.
	 * @param childSessionId - the child session the event belongs to.
	 * @param event - the raw event; only its `type` and `usage` are read.
	 */
	noteChildEvent(childSessionId: string, event: unknown): void {
		try {
			const review = this.resolveReview(childSessionId);
			if (review === undefined) return;
			const record = event as { type?: unknown; usage?: unknown } | undefined;
			if (record === undefined || record === null) return;

			if (record.type === "step/end") {
				review.steps += 1;
				if (review.steps >= this.deps.config().skills.maxReviewSteps) this.stop(childSessionId, review);
				return;
			}
			if (record.type === "assistant/message") {
				const usage = record.usage as
					| {
							inputTokens?: unknown;
							outputTokens?: unknown;
							cacheReadTokens?: unknown;
							cacheWriteTokens?: unknown;
					  }
					| undefined;
				review.inputTokens += count(usage?.inputTokens);
				review.outputTokens += count(usage?.outputTokens);
				review.cacheReadTokens += count(usage?.cacheReadTokens);
				review.cacheWriteTokens += count(usage?.cacheWriteTokens);
				if (review.inputTokens >= this.deps.config().skills.maxInputTokens) this.stop(childSessionId, review);
			}
		} catch (error) {
			this.logQuietly(`Background review: ignoring a malformed child event (${messageOf(error)})`);
		}
	}

	/**
	 * Claim the trigger, start the sub-session, and attribute what it cost.
	 *
	 * The usage row is written in the `finally`, after `done` settles either
	 * way, because a review that spent tokens and then failed — or was
	 * interrupted by a budget — must still be attributed (spec §9.2).
	 * @param parentSessionId - the conversation whose turn triggered this.
	 * @param settings - the settings snapshot the decision was made against.
	 * @param turn - the ended turn, for its route and its transcript.
	 */
	private async start(
		parentSessionId: string,
		settings: BuddyConfig["skills"],
		turn: {
			readonly route?: { provider: string; model: string } | undefined;
			readonly surface?: readonly DigestMessage[] | undefined;
		},
	): Promise<void> {
		// The parent route §7.1 compares against: what the conversation really
		// ran on when the host row knows it, and only otherwise Buddy's default
		// model (the degraded fallback `onTurnEnd`'s `route` documents).
		const parent = turn.route ?? this.deps.config().model;
		const routed = settings.reviewProvider !== "" && settings.reviewModel !== "";
		const differsFromParent =
			settings.reviewProvider !== parent.provider || settings.reviewModel !== parent.model;
		const provider: "fork" | "spawn" = routed && differsFromParent ? "spawn" : "fork";
		const model = provider === "spawn" ? settings.reviewModel : parent.model;
		const body = `${SKILL_REVIEW_PROMPT}${REVIEW_TOOL_CLAUSE}`;
		const prompt =
			provider === "spawn" ? `${renderDigest(digestHistory(turn.surface ?? []))}\n\n${body}` : body;

		const review: ActiveReview = {
			parentSessionId,
			provider,
			model,
			childSessionId: undefined,
			steps: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			interrupted: false,
		};
		this.active.set(parentSessionId, review);

		let outcome = OUTCOME_COMPLETED;
		try {
			const child = this.deps.spawn({ provider, prompt, toolFilter: REVIEW_TOOL_FILTER });
			review.childSessionId = child.childSessionId;
			this.children.set(child.childSessionId, review);
			await child.done;
		} catch (error) {
			outcome = OUTCOME_FAILED;
			this.logQuietly(`Background review failed: ${messageOf(error)}`);
		} finally {
			if (review.childSessionId !== undefined) this.children.delete(review.childSessionId);
			this.active.delete(parentSessionId);
			await this.record(review, outcome);
		}
	}

	/**
	 * Write the one usage row for a finished review.
	 *
	 * Telemetry is not a gate (the sibling `skills/usage.ts` discipline): a
	 * failed table write is logged and swallowed, so a storage problem can never
	 * turn a completed review into an unhandled rejection.
	 * @param review - the review's accumulated counters.
	 * @param outcome - how it ended.
	 */
	private async record(review: ActiveReview, outcome: string): Promise<void> {
		this.logQuietly(
			`Background review complete: calls=${review.steps} in=${review.inputTokens} out=${review.outputTokens} ` +
				`cache_read=${review.cacheReadTokens} result=${outcome}`,
		);
		const table = this.deps.reviewUsage;
		if (table === undefined) return;
		const ts = this.deps.now();
		const childSessionId = review.childSessionId ?? "";
		try {
			const row: ReviewUsageRecord = {
				id: nextUsageId(ts),
				ts,
				parentSessionId: review.parentSessionId,
				childSessionId,
				provider: review.provider,
				model: review.model,
				steps: review.steps,
				inputTokens: review.inputTokens,
				outputTokens: review.outputTokens,
				cacheReadTokens: review.cacheReadTokens,
				cacheWriteTokens: review.cacheWriteTokens,
				outcome,
			};
			await table.put(row.id, row);
		} catch (error) {
			this.logQuietly(`review_usage: recording the review failed (${messageOf(error)}) — review unaffected`);
		}
	}

	/**
	 * Find the in-flight review a child event belongs to.
	 *
	 * Usually the child id is known, because `spawn` already returned it. The
	 * fallback exists for the window before that: the host row can deliver an
	 * event for a session whose id the coordinator has not been handed yet, and
	 * with exactly one review flying there is no ambiguity about whose it is.
	 * With several flying, an unknown id is dropped rather than guessed at.
	 * @param childSessionId - the event's session id.
	 * @returns the review to charge the event to, or `undefined` to ignore it.
	 */
	private resolveReview(childSessionId: string): ActiveReview | undefined {
		const known = this.children.get(childSessionId);
		if (known !== undefined) return known;
		if (this.active.size === 1) return this.active.values().next().value;
		return undefined;
	}

	/**
	 * Enforce a budget by stopping the child session once.
	 * @param childSessionId - the child to interrupt.
	 * @param review - its review, whose `interrupted` flag makes this idempotent.
	 */
	private stop(childSessionId: string, review: ActiveReview): void {
		if (review.interrupted) return;
		review.interrupted = true;
		try {
			const pending = this.deps.interrupt(childSessionId);
			// A seam typed `void` may still be async underneath; a rejection there
			// must not escape as an unhandled one.
			void Promise.resolve(pending).catch((error: unknown) => {
				this.logQuietly(`Background review: interrupt failed (${messageOf(error)})`);
			});
		} catch (error) {
			this.logQuietly(`Background review: interrupt failed (${messageOf(error)})`);
		}
	}

	/**
	 * Emit a diagnostic line without letting the sink break the caller.
	 * @param line - the message.
	 */
	private logQuietly(line: string): void {
		try {
			this.deps.log(line);
		} catch {
			// A failing log sink is not worth an exception on the turn path.
		}
	}
}

/**
 * Render the cheap-model digest as the review prompt's context block.
 *
 * The digest's own synthetic header already explains what the block is, so this
 * only labels each turn by role and joins them — the review reads it as a
 * transcript, not as data.
 * @param messages - the digest, oldest first (see {@link digestHistory}).
 * @returns the context block; an empty history still gets the header line.
 */
function renderDigest(messages: readonly DigestMessage[]): string {
	const lines = messages.map((message) => `${labelOf(message.role)}: ${message.text}`);
	return `Earlier conversation digest:\n${lines.join("\n")}`;
}

/**
 * @param role - a digest turn's role.
 * @returns the label the digest uses for it.
 */
function labelOf(role: DigestMessage["role"]): string {
	if (role === "user") return "USER";
	if (role === "assistant") return "ASSISTANT";
	return "TOOL";
}

/**
 * Coerce a possibly absent or malformed token count to a non-negative integer.
 * @param value - the reported count.
 * @returns the count, or `0` when it is not a usable number.
 */
function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/**
 * Build a usage-row id that sorts with its own timestamp.
 *
 * The same shape the mutation ledger uses: the wall clock cannot order two rows
 * written in one millisecond, so a process-local sequence supplies the order and
 * a random suffix only keeps ids unique across processes.
 * @param ts - the row's ISO-8601 timestamp.
 * @returns the row id.
 */
function nextUsageId(ts: string): string {
	usageSequence += 1;
	return `${ts}-${usageSequence.toString().padStart(9, "0")}-${randomUUID().slice(0, 8)}`;
}

/**
 * @param error - an unknown throwable.
 * @returns its message, or the value rendered.
 */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
