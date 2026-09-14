/**
 * Questions, answered from the phone.
 *
 * A Telegram Buddy session runs the `ask_user_question` tool and the plan
 * review that `exit_plan_mode` raises; both pause on the `user-questions/request`
 * waterfall until a UI provider returns a human answer. The browser answers it
 * with a card — a surface Telegram has no equivalent for — so without this
 * bridge the tool call blocks, the agent never goes idle, and the chat freezes
 * with nothing on screen to explain it. This module registers a waterfall
 * answerer for sessions this plugin owns and renders each question as an inline
 * keyboard, resolving the waterfall from a button press or a typed reply.
 *
 * It is the sibling of {@link ApprovalBridge} and copies the same three
 * safety behaviours — resolve/reject before repainting, never block the
 * callback, refuse when undeliverable — with one deliberate difference:
 *
 * - **Fail loud, not closed.** An approval has a safe default (deny); a
 *   question does not. An unanswered question therefore *rejects* rather than
 *   inventing an answer, and the turn surfaces the error instead of proceeding
 *   on a choice the user never made.
 *
 * Answers use the seam's own vocabulary: `selected` carries the chosen option
 * *labels* (not indexes), and a typed reply becomes `custom` free text with no
 * selection — which, for a plan review, is exactly "keep planning, and here is
 * my feedback". Only sessions this plugin created are answered here; anything
 * else falls through to the next answerer (the browser) with `next()`.
 * @module dsh-buddy/telegram/questions
 */
import { randomBytes } from "node:crypto";
import type { TelegramApi, TelegramInlineButton } from "./telegram/api.ts";
import { escapeHtml } from "./telegram/render.ts";

/** How long an unanswered question stays open before it fails loud. */
export const DEFAULT_QUESTION_TIMEOUT_MS = 900_000;

/** One option offered for a question. */
interface QuestionOptionLike {
	readonly label: string;
	readonly description?: string;
}

/** The slice of one question this module reads. */
interface QuestionItemLike {
	readonly id: string;
	readonly question: string;
	readonly header?: string;
	readonly detail?: string;
	readonly options?: readonly QuestionOptionLike[];
	readonly multiSelect?: boolean;
}

/** The slice of a user-questions request this module reads. */
interface QuestionRequestLike {
	readonly questions: readonly QuestionItemLike[];
	readonly agent?: { readonly session?: { readonly id?: string } };
	readonly signal?: AbortSignal;
}

/** One answered question, in the seam's encoding. */
interface QuestionAnswerItem {
	readonly id: string;
	readonly selected: string[];
	readonly custom?: string;
}

/** The answer the waterfall resolves to. */
interface QuestionAnswer {
	readonly answers: QuestionAnswerItem[];
}

/** Collaborators of {@link QuestionBridge}. */
export interface QuestionDeps {
	/** Transport for sending prompts. */
	readonly api: () => TelegramApi | undefined;
	/** Whether a session belongs to this plugin (and so to a chat we may ask). */
	readonly isOurs: (sessionId: string) => boolean;
	/** The chat that owns a session, for routing the prompt. */
	readonly chatFor: (sessionId: string) => { chatId: number; threadId?: number | undefined } | undefined;
	/** Diagnostic sink. */
	readonly log: (line: string) => void;
	/** Overridable for tests. */
	readonly timeoutMs?: number | undefined;
}

/** One question awaiting an answer, keyed by the token in its `callback_data`. */
interface Pending {
	readonly chatId: number;
	readonly threadId: number | undefined;
	readonly question: QuestionItemLike;
	readonly resolve: (answer: QuestionAnswerItem) => void;
	readonly reject: (error: Error) => void;
	readonly timer: ReturnType<typeof setTimeout>;
	readonly signal: AbortSignal | undefined;
	readonly onAbort: (() => void) | undefined;
	/** Toggled option indexes, for a multi-select question. */
	readonly selected: Set<number>;
	messageId: number | undefined;
	settled: boolean;
}

/**
 * Renders questions into Telegram and resolves them from presses and replies.
 */
export class QuestionBridge {
	readonly #deps: QuestionDeps;
	readonly #pending = new Map<string, Pending>();
	/** Chat id → the token of the question currently awaiting a reply there. */
	readonly #byChat = new Map<number, string>();

	/**
	 * @param deps - transport, ownership routing, and a logger.
	 */
	constructor(deps: QuestionDeps) {
		this.#deps = deps;
	}

	/**
	 * The `user-questions/request` waterfall answerer.
	 *
	 * Returns `next()` for sessions this plugin does not own, so the browser (or
	 * whatever else answers in this deployment) keeps its say. Questions are asked
	 * one at a time so the phone shows a single prompt at a moment.
	 * @param request - the harness's user-questions request.
	 * @param next - the remaining waterfall.
	 * @returns the answer the harness should hand back to the tool.
	 */
	async handler(request: QuestionRequestLike, next: () => Promise<QuestionAnswer>): Promise<QuestionAnswer> {
		const sessionId = request.agent?.session?.id;
		if (sessionId === undefined || !this.#deps.isOurs(sessionId)) return await next();
		const target = this.#deps.chatFor(sessionId);
		const api = this.#deps.api();
		if (target === undefined || api === undefined) return await next();

		const answers: QuestionAnswerItem[] = [];
		for (const question of request.questions) {
			answers.push(await this.#askOne(question, target, request.signal));
		}
		return { answers };
	}

	/** Show one question and resolve with its answer, or reject if it fails loud. */
	#askOne(
		question: QuestionItemLike,
		target: { chatId: number; threadId?: number | undefined },
		signal: AbortSignal | undefined,
	): Promise<QuestionAnswerItem> {
		return new Promise<QuestionAnswerItem>((resolve, reject) => {
			if (signal?.aborted) {
				reject(new Error("the question was cancelled before it could be answered"));
				return;
			}
			const token = randomBytes(6).toString("hex");
			const timeoutMs = this.#deps.timeoutMs ?? DEFAULT_QUESTION_TIMEOUT_MS;
			const timer = setTimeout(() => {
				this.#reject(token, new Error(`the question timed out after ${Math.round(timeoutMs / 1000)} seconds`));
			}, timeoutMs);
			timer.unref?.();
			const onAbort =
				signal === undefined ? undefined : () => this.#reject(token, new Error("the question was cancelled before it could be answered"));
			if (signal !== undefined && onAbort !== undefined) signal.addEventListener("abort", onAbort, { once: true });
			const pending: Pending = {
				chatId: target.chatId,
				threadId: target.threadId,
				question,
				resolve,
				reject,
				timer,
				signal,
				onAbort,
				selected: new Set<number>(),
				messageId: undefined,
				settled: false,
			};
			this.#pending.set(token, pending);
			this.#byChat.set(target.chatId, token);

			// The detail (a plan review's whole plan) routinely exceeds Telegram's
			// per-message ceiling, so it is its own message with a plain fallback the
			// transport re-splits when too long; the keyboard rides a short prompt
			// that never repeats it.
			void (async () => {
				const api = this.#deps.api();
				if (api === undefined) {
					this.#reject(token, new Error("the question could not be delivered: no transport"));
					return;
				}
				try {
					if (question.detail !== undefined && question.detail !== "") {
						const body = escapeHtml(question.detail);
						await api.sendMessage({ chatId: target.chatId, text: body, plain: body, threadId: target.threadId });
					}
					const messageId = await api.sendMessage({
						chatId: target.chatId,
						text: renderText(question),
						plain: renderPlain(question),
						threadId: target.threadId,
						keyboard: renderKeyboard(question, token, pending.selected),
					});
					const live = this.#pending.get(token);
					if (live !== undefined) live.messageId = messageId;
				} catch (error) {
					this.#deps.log(`question prompt failed: ${(error as Error).message}`);
					this.#reject(token, new Error(`the question could not be delivered: ${(error as Error).message}`));
				}
			})();
		});
	}

	/**
	 * Handle a button press.
	 * @param data - `callback_data` from the update.
	 * @param queryId - the callback query id, for the acknowledgement.
	 * @returns true when the data belonged to this bridge.
	 */
	async handleCallback(data: string, queryId: string): Promise<boolean> {
		const parts = data.split(":");
		if (parts[0] !== "qn" || parts.length < 3) return false;
		const token = parts[1] ?? "";
		const api = this.#deps.api();
		// Acknowledge first: the client shows a spinner until this lands.
		await api?.answerCallbackQuery(queryId).catch(() => undefined);
		const pending = this.#pending.get(token);
		// A press for a question already settled (a late tap, or a reload) is still
		// ours to swallow — it must not fall through to another feature's parser.
		if (pending === undefined) return true;
		const kind = parts[2];
		if (kind === "o") {
			const index = Number(parts[3]);
			const label = pending.question.options?.[index]?.label;
			if (label !== undefined) this.#resolve(token, [label], undefined);
			return true;
		}
		if (kind === "t") {
			const index = Number(parts[3]);
			if (pending.selected.has(index)) pending.selected.delete(index);
			else pending.selected.add(index);
			this.#repaintKeyboard(token, pending);
			return true;
		}
		if (kind === "c") {
			this.#resolve(token, labelsOf(pending), undefined);
			return true;
		}
		return true;
	}

	/**
	 * Answer the question currently awaiting a reply in a chat with typed text.
	 *
	 * A typed reply is a `custom` answer with no option selected — the escape
	 * hatch when the user would rather write than tap, and the natural "keep
	 * planning with feedback" for a plan review.
	 * @param chatId - the chat the message arrived in.
	 * @param text - the message text, already trimmed by the caller.
	 * @returns true when the reply was consumed as an answer.
	 */
	handleText(chatId: number, text: string): boolean {
		const token = this.#byChat.get(chatId);
		if (token === undefined) return false;
		const pending = this.#pending.get(token);
		if (pending === undefined) {
			this.#byChat.delete(chatId);
			return false;
		}
		if (text === "") return false;
		this.#resolve(token, [], text);
		return true;
	}

	/** Refuse every pending question (plugin shutdown). */
	dispose(): void {
		for (const token of [...this.#pending.keys()]) this.#reject(token, new Error("the question bridge was disposed"));
	}

	/** Resolve one pending question exactly once, then repaint its message. */
	#resolve(token: string, selected: string[], custom: string | undefined): void {
		const pending = this.#finish(token);
		if (pending === undefined) return;
		pending.resolve(custom === undefined ? { id: pending.question.id, selected } : { id: pending.question.id, selected, custom });
		const label = custom !== undefined ? `✍️ ${custom}` : selected.length === 0 ? "✅ Answered" : `✅ ${selected.join(", ")}`;
		this.#repaintText(pending, label);
	}

	/** Reject one pending question exactly once, then repaint its message. */
	#reject(token: string, error: Error): void {
		const pending = this.#finish(token);
		if (pending === undefined) return;
		pending.reject(error);
		this.#repaintText(pending, "⌛ This question was closed unanswered");
	}

	/** Settle bookkeeping shared by resolve and reject; returns the live pending. */
	#finish(token: string): Pending | undefined {
		const pending = this.#pending.get(token);
		if (pending === undefined || pending.settled) return undefined;
		pending.settled = true;
		this.#pending.delete(token);
		if (this.#byChat.get(pending.chatId) === token) this.#byChat.delete(pending.chatId);
		clearTimeout(pending.timer);
		if (pending.signal !== undefined && pending.onAbort !== undefined) pending.signal.removeEventListener("abort", pending.onAbort);
		return pending;
	}

	/** Repaint a multi-select prompt so the ticks reflect the current selection. */
	#repaintKeyboard(token: string, pending: Pending): void {
		const api = this.#deps.api();
		if (api === undefined || pending.messageId === undefined) return;
		void api
			.editMessageText({
				chatId: pending.chatId,
				messageId: pending.messageId,
				text: renderText(pending.question),
				keyboard: renderKeyboard(pending.question, token, pending.selected),
			})
			.catch((error: unknown) => {
				this.#deps.log(`question repaint failed: ${(error as Error).message}`);
			});
	}

	/** Replace a settled prompt with its outcome and drop the stale keyboard. */
	#repaintText(pending: Pending, label: string): void {
		const api = this.#deps.api();
		if (api === undefined || pending.messageId === undefined) return;
		void api
			.editMessageText({ chatId: pending.chatId, messageId: pending.messageId, text: escapeHtml(label), keyboard: [] })
			.catch((error: unknown) => {
				this.#deps.log(`question repaint failed: ${(error as Error).message}`);
			});
	}
}

/** The chosen option labels of a multi-select question, in option order. */
function labelsOf(pending: Pending): string[] {
	const options = pending.question.options ?? [];
	const labels: string[] = [];
	for (let index = 0; index < options.length; index++) {
		const option = options[index];
		if (option !== undefined && pending.selected.has(index)) labels.push(option.label);
	}
	return labels;
}

/** The instruction line under a question, matched to how it is answered. */
function hintFor(question: QuestionItemLike): string {
	if ((question.options ?? []).length === 0) return "Reply with your answer.";
	if (question.multiSelect === true) return "Tap to select, then Confirm — or type a reply instead.";
	return "Tap an option, or type a reply instead.";
}

/**
 * The prompt body. The header and question come from the model, so they are
 * HTML-escaped; the surrounding tags and the hint are our own markup. The detail
 * is not here — it is sent as its own message so an over-length plan can split.
 */
function renderText(question: QuestionItemLike): string {
	const lines: string[] = [];
	if (question.header !== undefined && question.header !== "") lines.push(`<b>${escapeHtml(question.header)}</b>`);
	lines.push(escapeHtml(question.question));
	lines.push("", `<i>${hintFor(question)}</i>`);
	return lines.join("\n");
}

/**
 * The tag-free fallback for {@link renderText}, so the transport can re-split
 * the prompt from it when the entity-parsed body is rejected or too long.
 */
function renderPlain(question: QuestionItemLike): string {
	const lines: string[] = [];
	if (question.header !== undefined && question.header !== "") lines.push(escapeHtml(question.header));
	lines.push(escapeHtml(question.question));
	lines.push("", escapeHtml(hintFor(question)));
	return lines.join("\n");
}

/**
 * The inline keyboard for a question: one button per option (a leading ✓ when
 * selected in multi-select), plus a Confirm row for multi-select. A question
 * with no options has no keyboard — it is answered by a typed reply.
 */
function renderKeyboard(
	question: QuestionItemLike,
	token: string,
	selected: ReadonlySet<number>,
): readonly (readonly TelegramInlineButton[])[] | undefined {
	const options = question.options ?? [];
	if (options.length === 0) return undefined;
	const multi = question.multiSelect === true;
	const rows: TelegramInlineButton[][] = options.map((option, index) => [
		{
			text: multi && selected.has(index) ? `✓ ${option.label}` : option.label,
			callback_data: multi ? `qn:${token}:t:${index}` : `qn:${token}:o:${index}`,
		},
	]);
	if (multi) rows.push([{ text: "Confirm", callback_data: `qn:${token}:c` }]);
	return rows;
}
