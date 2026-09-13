/**
 * Approvals, answered from the phone.
 *
 * A Telegram session runs with policy `ask`, so a call that needs permission
 * raises `approval/request` and waits. This module registers a waterfall
 * listener, renders an inline keyboard into the owning chat, and resolves the
 * request with the harness's vocabulary — `allowed-once` or `rejected`. There is
 * no "always allow" outcome to offer: the harness has exactly one affirmative
 * result, and a wider grant is a *permission preset* change, which the Settings
 * tab owns.
 *
 * Three behaviours are copied from a mature bridge because they are the
 * difference between "works" and "works when it matters":
 *
 * - **Resolve before rendering.** A press that lands after the wait timed out
 *   must not repaint the message as "approved" — the tool was already refused.
 * - **Fail closed.** No answer within {@link DEFAULT_APPROVAL_TIMEOUT_MS} is a
 *   rejection, never an accidental approval.
 * - **Never block the callback.** Telegram spins a progress bar until
 *   `answerCallbackQuery`, so the acknowledgement is sent immediately and the
 *   message edit follows.
 *
 * Only sessions this plugin created are answerable here; anything else is passed
 * to the next listener (the browser, in a normal deployment) with `next()`.
 * @module dsh-telegram/approvals
 */
import { randomBytes } from "node:crypto";
import type { TelegramApi, TelegramInlineButton } from "./telegram/api.ts";
import { escapeHtml } from "./telegram/render.ts";

/** How long an unanswered approval stays open before it is refused. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 300_000;

/** One pending request, keyed by the opaque id carried in `callback_data`. */
interface Pending {
	readonly chatId: number;
	readonly threadId: number | undefined;
	readonly resolve: (outcome: "allowed-once" | "rejected") => void;
	readonly timer: ReturnType<typeof setTimeout>;
	messageId: number | undefined;
	settled: boolean;
}

/** Collaborators of {@link ApprovalBridge}. */
export interface ApprovalDeps {
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

/** The slice of an approval request this module reads. */
interface ApprovalRequestLike {
	readonly agent?: { readonly session?: { readonly id?: string } };
	readonly toolName?: string;
	readonly reason?: string;
}

/**
 * Renders approval prompts into Telegram and resolves them from button presses.
 */
export class ApprovalBridge {
	readonly #deps: ApprovalDeps;
	readonly #pending = new Map<string, Pending>();

	/**
	 * @param deps - transport, ownership routing, and a logger.
	 */
	constructor(deps: ApprovalDeps) {
		this.#deps = deps;
	}

	/**
	 * The `approval/request` waterfall listener.
	 *
	 * Returns `next()` for sessions this plugin does not own, so the browser (or
	 * whatever else answers in this deployment) keeps its say.
	 * @param request - the harness's approval request.
	 * @param next - the remaining waterfall.
	 * @returns the outcome the harness should apply.
	 */
	async handler(
		request: ApprovalRequestLike,
		next: () => Promise<"allowed-once" | "rejected" | "cancelled" | "unavailable">,
	): Promise<"allowed-once" | "rejected" | "cancelled" | "unavailable"> {
		const sessionId = request.agent?.session?.id;
		if (sessionId === undefined || !this.#deps.isOurs(sessionId)) return await next();
		const target = this.#deps.chatFor(sessionId);
		const api = this.#deps.api();
		if (target === undefined || api === undefined) return await next();

		const token = randomBytes(6).toString("hex");
		const timeoutMs = this.#deps.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
		const tool = request.toolName ?? "a tool";
		// Already valid Telegram HTML, with the untrusted parts escaped here. It is
		// deliberately not run through the Markdown renderer or the escape-only
		// helper: those would either re-interpret the tags or escape them, and the
		// prompt once arrived on the phone as the literal text `<b>需要你的许可</b>`.
		const text = [
			`<b>需要你的许可</b>`,
			`工具：<code>${escapeHtml(tool)}</code>`,
			...(request.reason === undefined ? [] : [`原因：${escapeHtml(request.reason)}`]),
			``,
			`${Math.round(timeoutMs / 1000)} 秒内不点按视为拒绝。`,
		].join("\n");

		const keyboard: TelegramInlineButton[][] = [
			[
				{ text: "允许一次", callback_data: `ap:y:${token}` },
				{ text: "拒绝", callback_data: `ap:n:${token}` },
			],
		];

		const outcome = new Promise<"allowed-once" | "rejected">((resolve) => {
			const timer = setTimeout(() => {
				this.#settle(token, "rejected", "timeout");
			}, timeoutMs);
			timer.unref?.();
			this.#pending.set(token, {
				chatId: target.chatId,
				threadId: target.threadId,
				resolve,
				timer,
				messageId: undefined,
				settled: false,
			});
		});

		try {
			const messageId = await api.sendMessage({
				chatId: target.chatId,
				text,
				threadId: target.threadId,
				keyboard,
			});
			const pending = this.#pending.get(token);
			if (pending !== undefined) pending.messageId = messageId;
		} catch (error) {
			this.#deps.log(`approval prompt failed: ${(error as Error).message}`);
			this.#settle(token, "rejected", "undeliverable");
		}

		return await outcome;
	}

	/**
	 * Handle a button press.
	 * @param data - `callback_data` from the update.
	 * @param queryId - the callback query id, for the acknowledgement.
	 * @returns true when the data belonged to this bridge.
	 */
	async handleCallback(data: string, queryId: string): Promise<boolean> {
		const parts = data.split(":");
		if (parts[0] !== "ap" || parts.length !== 3) return false;
		const [, choice, token] = parts as [string, string, string];
		const api = this.#deps.api();
		// Acknowledge first: the client shows a spinner until this lands.
		await api?.answerCallbackQuery(queryId).catch(() => undefined);
		this.#settle(token, choice === "y" ? "allowed-once" : "rejected", "answer");
		return true;
	}

	/** Refuse every pending request (plugin shutdown). */
	dispose(): void {
		for (const token of [...this.#pending.keys()]) this.#settle(token, "rejected", "disposed");
	}

	/** Resolve one pending request exactly once, then repaint its message. */
	#settle(token: string, outcome: "allowed-once" | "rejected", cause: string): void {
		const pending = this.#pending.get(token);
		if (pending === undefined || pending.settled) return;
		pending.settled = true;
		this.#pending.delete(token);
		clearTimeout(pending.timer);
		// Resolve BEFORE rendering: the tool must be unblocked even if the edit fails.
		pending.resolve(outcome);
		const api = this.#deps.api();
		if (api === undefined || pending.messageId === undefined) return;
		const label =
			outcome === "allowed-once"
				? "✅ 已允许（仅这一次）"
				: cause === "timeout"
					? "⌛ 已过期，按拒绝处理"
					: "❌ 已拒绝";
		void api
			.editMessageText({
				chatId: pending.chatId,
				messageId: pending.messageId,
				text: label,
				keyboard: [],
			})
			.catch((error: unknown) => {
				this.#deps.log(`approval repaint failed: ${(error as Error).message}`);
			});
	}
}

