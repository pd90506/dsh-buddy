/**
 * The bot runtime: one long-poll loop, one queue per chat, one reply per turn.
 *
 * Shape of a message's life here:
 *
 * 1. **Owner check.** Anyone else is dropped in silence — the bot must not
 *    confirm its own existence to a stranger, and their text never reaches a log.
 * 2. **Merge window.** Telegram clients split long pastes into several messages;
 *    fragments arriving within a couple of seconds are joined into one turn.
 * 3. **Command or conversation.** Slash commands act immediately; everything else
 *    becomes a turn.
 * 4. **Steer or start.** A chat with a turn already running gets `steer()` (the
 *    user is refining what the agent is doing); an idle chat gets `followup()`
 *    and this call owns the reply.
 * 5. **Reply.** The turn's own assistant text is folded out of the session log,
 *    rendered as HTML, split to Telegram's 4096-unit ceiling, and sent with a
 *    gap of just over a second between chunks — one message per second per chat
 *    is the documented flood threshold.
 *
 * Polling state, and why it is persisted: Telegram keeps updates for about 24
 * hours, so a bridge that restarts without a cursor is handed a day of backlog
 * and would re-answer old messages. The cursor lives in the storage domain and is
 * written after each handled update.
 * @module dsh-telegram/runtime
 */
import { readFile, realpath, stat } from "node:fs/promises";
import type { TelegramConfig } from "./config.ts";
import { isMediaDeliveryMode, isPermissionPreset, resolveDefaultCwd } from "./config.ts";
import type { TelegramStatus } from "./gateway.ts";
import { ApprovalBridge } from "./approvals.ts";
import { attachmentOf, receiveInboundFile } from "./files.ts";
import { defaultEffortOf, loadCatalog, parseModelCallback, validateSelection, type ModelMenu } from "./model.ts";
import { SessionManager, type ResolvedChat, type SessionLike, type TurnPart } from "./session.ts";
import type { TelegramStore } from "./store.ts";
import { backoff, TelegramApi, TelegramApiError, type TelegramMessage, type TelegramUpdate } from "./telegram/api.ts";
import { planReply, type Outbound } from "./telegram/deliver.ts";
import type { AttachmentRefLike, MediaIo } from "./telegram/media.ts";
import { MessageMerger } from "./telegram/merge.ts";
import { TELEGRAM_TEXT_LIMIT, ordinalSuffix, plainToTelegramHtml, planPlain } from "./telegram/render.ts";

/** Gap between reply chunks; the documented per-chat ceiling is 1 message/s. */
export const CHUNK_SPACING_MS = 1100;

/** Typing re-arm interval; Telegram clears the indicator after ~5 seconds. */
export const TYPING_INTERVAL_MS = 4000;

/** Wait after an unexpected polling failure. */
const POLL_ERROR_BACKOFF_MS = 3000;

/** The commands published to Telegram's menu and answered here. */
export const COMMANDS: readonly { command: string; description: string }[] = [
	{ command: "help", description: "How to use this bot" },
	{ command: "new", description: "Start a new conversation (same directory)" },
	{ command: "model", description: "Change the model for this chat" },
	{ command: "stop", description: "Stop the current turn" },
];

/** Collaborators of {@link TelegramRuntime}. */
export interface RuntimeDeps {
	/** `ctx.get`, for the optional harness services used below. */
	readonly get: (name: string) => unknown;
	/** The opened storage domain. */
	readonly store: TelegramStore;
	/** Chat ↔ session ownership. */
	readonly manager: SessionManager;
	/** Approval prompts. */
	readonly approvals: ApprovalBridge;
	/** The `/model` menu's per-chat state. */
	readonly menu: ModelMenu;
	/** The live settings section. */
	readonly config: () => TelegramConfig;
	/** Diagnostic sink; never receives the token. */
	readonly log: (line: string) => void;
	/** Transport override for tests. */
	readonly fetch?: typeof fetch | undefined;
	/** API origin override for tests; defaults to the cloud Bot API. */
	readonly apiBase?: string | undefined;
	/** Timing overrides for tests. */
	readonly timing?:
		| {
				chunkMs?: number;
				typingMs?: number;
				mergeMs?: number;
				pollBackoffMs?: number;
				/** Replaces the flood-control wait, so a retry test need not sleep. */
				floodMs?: number;
		  }
		| undefined;
}

/** The `ctx.attachments` slice used to read an image the session recorded. */
interface AttachmentsLike {
	readImage(ref: unknown, signal?: AbortSignal): Promise<{ data: Uint8Array }>;
}

/** Chat routing recorded per session, so approvals can find their chat. */
interface ChatRoute {
	readonly chatId: number;
	readonly threadId: number | undefined;
}

/**
 * Owns the bot: its lifecycle, its loop, and everything a message touches.
 */
export class TelegramRuntime {
	readonly #deps: RuntimeDeps;
	readonly #merger: MessageMerger<string>;
	/**
	 * Chat id → the turn currently running for it, agent included.
	 *
	 * `/stop` must cancel the agent that is actually working. Re-resolving the chat
	 * instead would create a brand-new session whenever the binding is gone — after
	 * `/new`, for instance — and then cancel that idle one while the real turn kept
	 * running.
	 */
	readonly #running = new Map<string, ResolvedChat>();
	readonly #routes = new Map<string, ChatRoute>();
	/** Chat id (string) → its own numeric id and topic, for merged delivery. */
	readonly #byChat = new Map<string, ChatRoute>();
	readonly #applied = new Map<string, string>();
	readonly #typing = new Map<string, ReturnType<typeof setInterval>>();
	/**
	 * Chat id (string) → the name its session is labelled with.
	 *
	 * Recorded when the update arrives, because the turn usually starts later: a
	 * plain text message carries no attachment, so it only reaches `#ensure` after
	 * the merge window, by which time the original message is gone. Without this
	 * every session was titled `Telegram: chat`.
	 */
	readonly #titles = new Map<string, string>();
	#api: TelegramApi | undefined;
	#abort: AbortController | undefined;
	#state: "off" | "starting" | "running" | "error" = "off";
	#detail: string | undefined;
	#botUsername: string | undefined;

	/**
	 * @param deps - context access, storage, session manager, and a logger.
	 */
	constructor(deps: RuntimeDeps) {
		this.#deps = deps;
		this.#merger = new MessageMerger<string>(
			(chatId, fragments) => {
				void this.#deliverMerged(chatId, fragments);
			},
			deps.timing?.mergeMs,
		);
	}

	/** Current runtime status, as the Settings tab renders it. */
	status(): Omit<TelegramStatus, "token"> {
		return {
			state: this.#state,
			detail: this.#detail,
			botUsername: this.#botUsername,
			sessions: this.#routes.size,
		};
	}

	/** Whether a session is one this runtime created. */
	isOurs = (sessionId: string): boolean => this.#routes.has(sessionId);

	/** The chat a session belongs to, for approval routing. */
	chatFor = (sessionId: string): { chatId: number; threadId?: number | undefined } | undefined => {
		const route = this.#routes.get(sessionId);
		if (route === undefined) return undefined;
		return route.threadId === undefined ? { chatId: route.chatId } : { chatId: route.chatId, threadId: route.threadId };
	};

	/** The bound client, for the approval bridge. */
	api = (): TelegramApi | undefined => this.#api;

	/**
	 * Start polling.
	 *
	 * Resolves once the token has been validated and the loop has been launched;
	 * a bad token resolves as an `error` status rather than throwing, because the
	 * Settings tab is the place that reports it.
	 * @param token - the bot token from the credentials plane.
	 */
	async start(token: string): Promise<void> {
		await this.stop();
		this.#state = "starting";
		this.#detail = undefined;
		const api = new TelegramApi({
			token,
			...(this.#deps.fetch === undefined ? {} : { fetch: this.#deps.fetch }),
			...(this.#deps.apiBase === undefined ? {} : { baseUrl: this.#deps.apiBase }),
			log: this.#deps.log,
		});
		try {
			const me = await api.getMe();
			this.#botUsername = me.username;
			// A webhook left on this token makes getUpdates answer 409, so it is
			// cleared before the first poll rather than diagnosed later.
			await api.deleteWebhook();
			await api.setMyCommands(COMMANDS);
		} catch (error) {
			this.#state = "error";
			// R3: a rejected token is reported as exactly that in the settings tab,
			// rather than as Telegram's raw `Unauthorized` (or worse, a transport
			// string that happens to embed the request URL).
			this.#detail =
				error instanceof TelegramApiError && error.isUnauthorized
					? "The token is invalid or has been revoked"
					: (error as Error).message;
			await this.#recordStatus();
			this.#deps.log(`telegram: startup failed: ${this.#detail}`);
			return;
		}
		this.#api = api;
		this.#state = "running";
		await this.#recordStatus();
		this.#abort = new AbortController();
		void this.#pollLoop(api, this.#abort.signal);
	}

	/** Stop polling and drop every pending prompt. */
	async stop(): Promise<void> {
		this.#abort?.abort();
		this.#abort = undefined;
		this.#merger.dispose();
		for (const chatId of [...this.#typing.keys()]) this.#stopTyping(chatId);
		this.#api = undefined;
		// A deliberate stop clears the last failure. The tab renders `detail` for
		// every state except `running`, so leaving "token 无效或已被吊销" behind after
		// the switch was turned off reports a problem nothing is acting on any more.
		// `start()` sets `starting` immediately after calling this, so a restart is
		// unaffected; the poll loop's own failures never route through here.
		this.#state = "off";
		this.#detail = undefined;
		// Recorded too: a persisted `running` after a deliberate stop is the same lie
		// in the other direction.
		await this.#recordStatus();
	}

	/** Release everything this runtime owns (plugin shutdown). */
	dispose(): void {
		// Nothing awaits teardown, so it must not reject into cordis's disposal path.
		void this.stop().catch((error: unknown) => {
			this.#deps.log(`stop failed: ${(error as Error).message}`);
		});
	}

	/**
	 * The long-poll loop.
	 *
	 * Each iteration advances the durable cursor past every handled update; a
	 * flood response is honoured via `retry_after` rather than a fixed sleep, and
	 * a rejected token stops the loop instead of hammering the API.
	 * @param api - the bound client.
	 * @param signal - shutdown signal.
	 */
	async #pollLoop(api: TelegramApi, signal: AbortSignal): Promise<void> {
		while (!signal.aborted) {
			try {
				const offset = this.#deps.store.global.get().updateOffset;
				const { updates } = await api.getUpdates({
					...(offset === undefined ? {} : { offset }),
					signal,
				});
				for (const update of updates) {
					if (signal.aborted) break;
					try {
						await this.handleUpdate(update);
					} catch (error) {
						this.#deps.log(`update ${String(update.update_id)} failed: ${(error as Error).message}`);
					}
					await this.#advanceCursor(update.update_id + 1);
				}
				if (this.#state === "error") {
					// Recovered. Re-record, or the persisted status keeps describing a
					// failure the loop already got past — a diagnostic that lies is worse
					// than no diagnostic.
					this.#state = "running";
					this.#detail = undefined;
					await this.#recordStatus();
				}
			} catch (error) {
				if (signal.aborted) return;
				if (error instanceof TelegramApiError && error.isFlood) {
					await backoff(error.retryAfter ?? 5, signal).catch(() => undefined);
					continue;
				}
				if (error instanceof TelegramApiError && error.isUnauthorized) {
					this.#state = "error";
					this.#detail = "The token is invalid or has been revoked";
					await this.#recordStatus();
					this.#deps.log("telegram: polling stopped: token rejected");
					return;
				}
				this.#deps.log(`poll failed: ${(error as Error).message}`);
				this.#state = "error";
				this.#detail = (error as Error).message;
				await this.#recordStatus();
				await new Promise((resolve) => setTimeout(resolve, this.#deps.timing?.pollBackoffMs ?? POLL_ERROR_BACKOFF_MS));
			}
		}
	}

	/**
	 * Handle one update: an inbound message, or a button press.
	 * @param update - the update envelope.
	 */
	async handleUpdate(update: TelegramUpdate): Promise<void> {
		if (update.callback_query !== undefined) {
			await this.#handleCallback(update.callback_query);
			return;
		}
		const message = update.message;
		if (message === undefined) return;
		if (message.from?.is_bot === true) return;
		if (!this.#isOwner(message)) {
			// Deliberately silent and content-free: a stranger learns nothing.
			this.#deps.log("telegram: dropped a message from a non-owner");
			return;
		}
		const chatId = message.chat.id;
		// Remember the name before anything can defer the turn: the merged delivery
		// path has no message left to read it from.
		this.#titles.set(String(chatId), chatTitle(message));
		const text = (message.text ?? message.caption ?? "").trim();
		const command = text.startsWith("/") ? parseCommand(text) : undefined;
		if (command !== undefined) {
			await this.#handleCommand(chatId, message, command.name, command.args);
			return;
		}
		const composed = await this.#composeInbound(message, text);
		if (composed === undefined) return;
		// Fragments are keyed by chat so a paste becomes one turn.
		this.#merger.push(String(chatId), composed);
	}

	/** Whether the sender is the configured owner. */
	#isOwner(message: TelegramMessage): boolean {
		return this.#isOwnerId(message.from?.id);
	}

	/**
	 * The single owner gate.
	 *
	 * Messages and button presses both come through here: the rule is one rule, and
	 * the two paths must not drift apart. An empty owner id means nobody, so an
	 * unconfigured bot is silent rather than open.
	 * @param userId - the sender's Telegram user id, when the update carried one.
	 * @returns whether this user may drive the bot.
	 */
	#isOwnerId(userId: number | undefined): boolean {
		const owner = this.#deps.config().ownerUserId.trim();
		return owner !== "" && userId !== undefined && String(userId) === owner;
	}

	/**
	 * Turn a message into the text handed to the agent.
	 *
	 * An attachment with no caption still has to become something the agent can
	 * act on, so the downloaded path is injected as the message body.
	 * @param message - the incoming message.
	 * @param text - its text or caption, already trimmed.
	 * @returns the composed text, or undefined when the message is unusable.
	 */
	async #composeInbound(message: TelegramMessage, text: string): Promise<string | undefined> {
		const api = this.#api;
		if (api === undefined) return undefined;
		if (attachmentOf(message) === undefined) return text === "" ? undefined : text;
		const chatId = String(message.chat.id);
		const resolved = await this.#ensure(chatId, message);
		const cwd = resolved.cwd;
		const stored = await receiveInboundFile(api, message, cwd, this.#deps.log);
		if (stored === undefined) return text === "" ? undefined : text;
		if ("kind" in stored) {
			await this.#send(chatId, message.message_thread_id, stored.message);
			return undefined;
		}
		const note = `[The user sent a file, saved to ${stored.path}]`;
		return text === "" ? note : `${text}\n\n${note}`;
	}

	/** Deliver a merged burst of fragments as one turn. */
	async #deliverMerged(chatId: string, fragments: readonly string[]): Promise<void> {
		const text = fragments.join("\n\n").trim();
		if (text === "") return;
		const route = this.#byChat.get(chatId);
		try {
			await this.#runTurn(chatId, route?.chatId ?? Number(chatId), route?.threadId, text);
		} catch (error) {
			// The merge timer fires this without awaiting, so a throw here would become
			// an unhandled rejection and the user would simply get silence. `#runTurn`
			// already reports anything the turn itself fails on; this covers the part
			// before it — resolving the session, which can fail on its own.
			const detail = (error as Error).message;
			this.#deps.log(`turn never started: ${detail}`);
			await this.#send(chatId, route?.threadId, `This turn never started: ${detail}`).catch(() => undefined);
		}
	}

	/** Run (or steer) one turn for a chat, and deliver its reply. */
	async #runTurn(chatId: string, numericChatId: number, threadId: number | undefined, text: string): Promise<void> {
		const resolved = await this.#ensure(chatId, undefined, numericChatId, threadId);
		if (this.#running.has(chatId)) {
			// The user is refining an answer in progress; steer rather than queue.
			this.#deps.manager.steer(resolved.chat, text);
			return;
		}
		this.#running.set(chatId, resolved.chat);
		this.#startTyping(chatId, resolved.chat);
		try {
			const parts = await this.#deps.manager.runTurn(resolved.chat, text);
			if (parts.length === 0) {
				await this.#send(chatId, resolved.threadId, "(This turn produced no text output)");
			} else {
				await this.#deliver(chatId, resolved.threadId, parts, resolved.cwd);
			}
		} catch (error) {
			this.#deps.log(`turn failed: ${(error as Error).message}`);
			await this.#send(chatId, resolved.threadId, `This turn failed: ${(error as Error).message}`);
		} finally {
			this.#running.delete(chatId);
			this.#stopTyping(chatId);
		}
	}

	/** Resolve the chat's session, apply policy, and remember its route. */
	async #ensure(
		chatId: string,
		message: TelegramMessage | undefined,
		numericChatId?: number,
		threadId?: number | undefined,
	): Promise<{ chat: ResolvedChat; threadId: number | undefined; cwd: string }> {
		const config = this.#deps.config();
		const title = message === undefined ? (this.#titles.get(chatId) ?? UNNAMED_CHAT) : chatTitle(message);
		const chat = await this.#deps.manager.ensure(chatId, title, resolveDefaultCwd(config));
		// The session's own directory wins: it is immutable once created, so a later
		// settings change must not move where its files (and its media) live.
		const cwd = chat.agent.session.header?.cwd ?? resolveDefaultCwd(config);
		const route = this.chatFor(String(chat.sessionId));
		const effectiveThread = threadId ?? route?.threadId;
		const chatRoute: ChatRoute = {
			chatId: numericChatId ?? route?.chatId ?? message?.chat.id ?? 0,
			threadId: effectiveThread,
		};
		this.#routes.set(String(chat.sessionId), chatRoute);
		this.#byChat.set(chatId, chatRoute);
		await this.#applyPolicy(chat, config);
		return { chat, threadId: effectiveThread, cwd };
	}

	/** Apply the configured permission level and approval policy to a session. */
	async #applyPolicy(chat: ResolvedChat, config: TelegramConfig): Promise<void> {
		const key = String(chat.sessionId);
		// The approval policy is always `ask` (a `never` policy would make the
		// buttons unreachable), so only the preset can differ between calls.
		if (this.#applied.get(key) === config.permissionPreset) return;
		const preset = isPermissionPreset(config.permissionPreset) ? config.permissionPreset : "workspace-write";
		try {
			const presets = this.#deps.get("permissionPresets") as
				| { set(session: unknown, name: string): void }
				| undefined;
			presets?.set(chat.agent.session as unknown as SessionLike, preset);
		} catch (error) {
			this.#deps.log(`permission preset failed: ${(error as Error).message}`);
		}
		try {
			// `never` would make the approval plane never fire at all, which is
			// the opposite of what the Telegram buttons are for.
			const approval = this.#deps.get("approval") as { setPolicy(agent: unknown, policy: string): void } | undefined;
			approval?.setPolicy(chat.agent, "ask");
		} catch (error) {
			this.#deps.log(`approval policy failed: ${(error as Error).message}`);
		}
		this.#applied.set(key, config.permissionPreset);
	}

	/** Send plugin-authored text, split to Telegram's ceiling and never reformatted (R31). */
	async #send(chatId: string, threadId: number | undefined, text: string): Promise<void> {
		const chunks = planPlain(text, TELEGRAM_TEXT_LIMIT);
		const total = chunks.length;
		for (const [index, chunk] of chunks.entries()) {
			// One message per second per chat is the documented ceiling, and a long
			// help screen arrives as several messages.
			if (index > 0) await new Promise((resolve) => setTimeout(resolve, this.#deps.timing?.chunkMs ?? CHUNK_SPACING_MS));
			const suffix = ordinalSuffix(index + 1, total);
			await this.#sendOne(chatId, threadId, { kind: "text", html: chunk.html + suffix, plain: chunk.plain + suffix });
		}
	}

	/**
	 * Deliver one turn: text, images and files in the order the agent wrote them.
	 *
	 * The planner decides everything about *what* is sent and how it is grouped;
	 * this method owns the wire: pacing, the retry after a flood response, and the
	 * degradation paths (a photo Telegram refuses is retried as a document, a
	 * refused body is retried as plain text).
	 * @param chatId - the chat id as a string.
	 * @param threadId - the topic, when the chat has one.
	 * @param parts - the turn's parts, in reading order.
	 * @param cwd - the session's working directory, which bounds every file read.
	 */
	async #deliver(chatId: string, threadId: number | undefined, parts: readonly TurnPart[], cwd: string): Promise<void> {
		const api = this.#api;
		if (api === undefined) return;
		const config = this.#deps.config();
		let outbound: readonly Outbound[];
		try {
			outbound = await planReply(parts, {
				io: this.#mediaIo(cwd),
				mediaDelivery: isMediaDeliveryMode(config.mediaDelivery) ? config.mediaDelivery : "all",
				renderMarkdown: config.renderMarkdown,
			});
		} catch (error) {
			// Planning is pure apart from reading bytes; if it still fails, the prose
			// must not be lost with it.
			const detail = (error as Error).message;
			this.#deps.log(`delivery planning failed: ${detail}`);
			await this.#send(chatId, threadId, parts.flatMap((part) => (part.kind === "text" ? [part.text] : [])).join("\n\n"));
			return;
		}
		const spacing = this.#deps.timing?.chunkMs ?? CHUNK_SPACING_MS;
		for (const [index, item] of outbound.entries()) {
			if (index > 0) await new Promise((resolve) => setTimeout(resolve, spacing));
			const failure = await this.#sendOne(chatId, threadId, item);
			// A file that never left the machine must say so: silence reads as "the
			// agent forgot to attach it".
			if (failure !== undefined && item.kind !== "text") {
				await this.#send(chatId, threadId, `[Not sent: ${outboundLabel(item)} (${failure})]`);
			}
		}
	}

	/**
	 * Send one planned item, retrying once after a flood response.
	 * @param chatId - the chat id as a string.
	 * @param threadId - the topic, when the chat has one.
	 * @param item - the item to send.
	 * @returns a short reason when the item never arrived, else undefined.
	 */
	async #sendOne(chatId: string, threadId: number | undefined, item: Outbound): Promise<string | undefined> {
		const api = this.#api;
		if (api === undefined) return undefined;
		try {
			await this.#dispatch(chatId, threadId, item);
			return undefined;
		} catch (error) {
			if (error instanceof TelegramApiError && error.isFlood) {
				// Back off and retry the same item: returning here would silently drop
				// the rest of the reply, which is how a long answer ends mid-sentence.
				await this.#floodWait(error.retryAfter);
				try {
					await this.#dispatch(chatId, threadId, item);
					return undefined;
				} catch (retryError) {
					this.#deps.log(`send failed after backoff: ${(retryError as Error).message}`);
					return reasonOf(retryError);
				}
			}
			if (item.kind === "photo") {
				// Telegram refuses a photo for reasons only it can judge (dimensions,
				// ratio, format). A document carrying the same bytes always works.
				try {
					await this.#dispatch(chatId, threadId, {
						kind: "document",
						bytes: item.bytes,
						name: item.name,
						...(item.caption === undefined ? {} : { caption: item.caption }),
					});
					return undefined;
				} catch (documentError) {
					this.#deps.log(`document fallback failed: ${(documentError as Error).message}`);
					return reasonOf(documentError);
				}
			}
			this.#deps.log(`send failed: ${(error as Error).message}`);
			return reasonOf(error);
		}
	}

	/**
	 * Wait out a flood-control response.
	 *
	 * Telegram's `retry_after` is authoritative when it is present; the override
	 * exists so a test can prove the retry happens without sleeping for it.
	 * @param retryAfter - seconds Telegram asked for, when it said.
	 */
	async #floodWait(retryAfter: number | undefined): Promise<void> {
		const override = this.#deps.timing?.floodMs;
		if (override !== undefined) {
			await new Promise((resolve) => setTimeout(resolve, override));
			return;
		}
		await backoff(retryAfter ?? 5).catch(() => undefined);
	}

	/** One planned item, as the Bot API call it maps to. */
	async #dispatch(chatId: string, threadId: number | undefined, item: Outbound): Promise<void> {
		const api = this.#api;
		if (api === undefined) return;
		const target = Number(chatId);
		switch (item.kind) {
			case "text":
				await api.sendMessage({
					chatId: target,
					text: item.html,
					plain: item.plain,
					...(threadId === undefined ? {} : { threadId }),
				});
				return;
			case "photo":
				await api.sendPhoto({
					chatId: target,
					photo: { bytes: item.bytes, name: item.name, mediaType: item.mediaType },
					...(item.caption === undefined ? {} : { caption: item.caption }),
					...(threadId === undefined ? {} : { threadId }),
				});
				return;
			case "photo-url":
				await api.sendPhoto({
					chatId: target,
					photo: { url: item.url },
					...(item.caption === undefined ? {} : { caption: item.caption }),
					...(threadId === undefined ? {} : { threadId }),
				});
				return;
			case "document":
				await api.sendDocument({
					chatId: target,
					document: { bytes: item.bytes, name: item.name },
					...(item.caption === undefined ? {} : { caption: item.caption }),
					...(threadId === undefined ? {} : { threadId }),
				});
				return;
			case "album":
				await api.sendMediaGroup({
					chatId: target,
					items: item.items.map((photo) => ({ bytes: photo.bytes, name: photo.name, mediaType: photo.mediaType })),
					...(threadId === undefined ? {} : { threadId }),
				});
		}
	}

	/**
	 * The filesystem and attachment seam the media planner reads through.
	 *
	 * Every read is bounded by the session's working directory on the planner's
	 * side; this only answers the questions it asks. `readImage` goes through the
	 * attachment store so the bytes are the digest-verified ones the session log
	 * recorded, not whatever now sits at some path.
	 * @param cwd - the session's working directory.
	 * @returns the injected accessors.
	 */
	#mediaIo(cwd: string): MediaIo {
		return {
			cwd,
			resolveRealPath: async (path: string) => {
				try {
					return await realpath(path);
				} catch {
					return undefined;
				}
			},
			isFile: async (path: string) => {
				try {
					return (await stat(path)).isFile();
				} catch {
					return false;
				}
			},
			statSize: async (path: string) => {
				try {
					return (await stat(path)).size;
				} catch {
					return undefined;
				}
			},
			readFile: async (path: string) => new Uint8Array(await readFile(path)),
			readAttachment: async (ref: AttachmentRefLike, signal?: AbortSignal) => {
				const attachments = this.#deps.get("attachments") as AttachmentsLike | undefined;
				if (attachments === undefined) {
					throw Object.assign(new Error("the attachments service is unavailable"), { name: "NoAttachments" });
				}
				// Called as a method, never destructured: cordis hands services out as
				// traceable proxies and a detached method loses its receiver.
				const stored = await attachments.readImage(ref, signal);
				return stored.data;
			},
		};
	}

	/** Keep the typing indicator alive for the duration of a turn. */
	#startTyping(chatId: string, chat: ResolvedChat): void {
		const api = this.#api;
		if (api === undefined) return;
		const route = this.chatFor(String(chat.sessionId));
		const interval = setInterval(() => {
			void api.sendTyping(Number(chatId), route?.threadId).catch(() => undefined);
		}, this.#deps.timing?.typingMs ?? TYPING_INTERVAL_MS);
		interval.unref?.();
		this.#typing.set(chatId, interval);
		void api.sendTyping(Number(chatId), route?.threadId).catch(() => undefined);
	}

	/** Stop the typing heartbeat for a chat. */
	#stopTyping(chatId: string): void {
		const interval = this.#typing.get(chatId);
		if (interval === undefined) return;
		clearInterval(interval);
		this.#typing.delete(chatId);
	}

	/** Handle `/command` input. */
	async #handleCommand(chatId: number, message: TelegramMessage, name: string, args: string): Promise<void> {
		const key = String(chatId);
		const threadId = message.message_thread_id;
		switch (name) {
			case "start":
			case "help": {
				const record = this.#deps.store.chats.get(key);
				await this.#send(key, threadId, helpText(this.#deps.config(), this.status().state, record?.model));
				return;
			}
			case "new": {
				const record = this.#deps.store.chats.get(key);
				if (record !== undefined) {
					this.#deps.manager.forget(record.sessionId);
					await this.#deps.store.chats.delete(key);
				}
				this.#deps.menu.close(key);
				await this.#send(key, threadId, "OK. Your next message starts a new conversation (same directory).");
				return;
			}
			case "stop": {
				// Keyed on the live turn rather than on the stored binding: a turn can
				// still be running after `/new` cleared the binding, and answering
				// "nothing is running" then would be a lie.
				const running = this.#running.get(key);
				if (running === undefined) {
					await this.#send(key, threadId, "Nothing is running right now.");
					return;
				}
				this.#deps.manager.cancel(running);
				await this.#send(key, threadId, "Stop requested.");
				return;
			}
			case "model": {
				await this.#openModelMenu(key, threadId, args);
				return;
			}
			default: {
				await this.#send(key, threadId, `Unknown command: /${name}. Send /help for usage.`);
			}
		}
	}

	/** Load the catalog and show the provider step. */
	async #openModelMenu(chatId: string, threadId: number | undefined, args: string): Promise<void> {
		const catalog = await loadCatalog(this.#deps.get);
		const api = this.#api;
		if (catalog === undefined) {
			await this.#send(chatId, threadId, "This profile has no model catalog service, so the model cannot be changed.");
			return;
		}
		this.#deps.menu.open(chatId, catalog);
		const record = this.#deps.store.chats.get(chatId);
		const current = record?.model;
		if (args.trim() !== "") {
			await this.#send(chatId, threadId, "/model <name> is not supported yet. Pick with the buttons.");
		}
		if (api === undefined) return;
		const rows = this.#deps.menu.providerKeyboard(chatId, record?.provider);
		if (rows.length === 0) {
			await this.#send(chatId, threadId, "No models are available.");
			return;
		}
		await api.sendMessage({
			chatId: Number(chatId),
			text: plainToTelegramHtml(current === undefined ? "Pick a provider:" : `Current model: ${current}\nPick a provider:`),
			threadId,
			keyboard: rows,
		});
	}

	/** Handle an inline-keyboard press. */
	async #handleCallback(query: NonNullable<TelegramUpdate["callback_query"]>): Promise<void> {
		const data = query.data;
		const message = query.message;
		if (data === undefined || message === undefined) return;
		if (query.from.is_bot === true) return;
		if (!this.#isOwnerId(query.from.id)) {
			// Same silence as text: a stranger in a shared chat must not be able
			// to drive this bot, and learns nothing by trying.
			await this.#api?.answerCallbackQuery(query.id).catch(() => undefined);
			return;
		}
		if (await this.#deps.approvals.handleCallback(data, query.id)) return;
		const action = parseModelCallback(data);
		if (action === undefined) return;
		const api = this.#api;
		if (api === undefined) return;
		await api.answerCallbackQuery(query.id).catch(() => undefined);
		const chatId = String(message.chat.id);
		const record = this.#deps.store.chats.get(chatId);
		const currentModel = record?.model;
		if (action.kind === "provider") {
			const providerIndex = action.providerIndex;
			await api
				.editMessageText({
					chatId: message.chat.id,
					messageId: message.message_id,
					text: plainToTelegramHtml("Pick a model:"),
					keyboard: this.#deps.menu.modelKeyboard(chatId, providerIndex, currentModel),
				})
				.catch((error: unknown) => {
					this.#deps.log(`model menu edit failed: ${(error as Error).message}`);
				});
			return;
		}
		if (action.kind === "model") {
			const providerIndex = action.providerIndex;
			const modelIndex = action.modelIndex;
			const model = this.#deps.menu.modelAt(chatId, providerIndex, modelIndex);
			const provider = this.#deps.menu.providerAt(chatId, providerIndex);
			if (model === undefined || provider === undefined) return;
			const effort = defaultEffortOf(model);
			const selection = {
				provider: provider.id,
				model: model.id,
				...(effort === undefined ? {} : { reasoningEffort: effort }),
			};
			const verdict = await validateSelection(this.#deps.get, selection);
			if (!verdict.ok) {
				await api
					.editMessageText({
						chatId: message.chat.id,
						messageId: message.message_id,
						text: plainToTelegramHtml(`This model cannot be used: ${verdict.message}`),
						keyboard: [],
					})
					.catch(() => undefined);
				return;
			}
			// A selection is chat-local and stored on the chat's record, so with no
			// record there is nowhere to put it. `setSelection` used to swallow it
			// silently while the tab-style confirmation below still claimed success.
			if (this.#deps.store.chats.get(chatId) === undefined) {
				this.#deps.menu.close(chatId);
				await api
					.editMessageText({
						chatId: message.chat.id,
						messageId: message.message_id,
						text: plainToTelegramHtml("This chat has no conversation yet. Send a message first, then pick a model."),
						keyboard: [],
					})
					.catch(() => undefined);
				return;
			}
			const live = await this.#liveFor(chatId);
			await this.#deps.manager.setSelection(chatId, live, selection);
			this.#deps.menu.close(chatId);
			await api
				.editMessageText({
					chatId: message.chat.id,
					messageId: message.message_id,
					text: plainToTelegramHtml(`Switched to ${provider.name} / ${model.name} (this chat only)`),
					keyboard: [],
				})
				.catch(() => undefined);
			return;
		}
		if (action.kind === "back") {
			await api
				.editMessageText({
					chatId: message.chat.id,
					messageId: message.message_id,
					text: plainToTelegramHtml("Pick a provider:"),
					keyboard: this.#deps.menu.providerKeyboard(chatId, record?.provider),
				})
				.catch(() => undefined);
		}
	}

	/** The live agent for a chat, if one is attached. */
	async #liveFor(chatId: string): Promise<ResolvedChat | undefined> {
		const record = this.#deps.store.chats.get(chatId);
		if (record === undefined) return undefined;
		const agents = this.#deps.get("agents") as { get(id: string): unknown } | undefined;
		if (agents === undefined) return undefined;
		const sessionId = record.sessionId;
		if (!this.#routes.has(sessionId)) return undefined;
		const live = agents.get(sessionId) as { session: SessionLike } | undefined;
		if (live === undefined) return undefined;
		return { sessionId: sessionId as never, agent: live as never, created: false };
	}

	/** Move the durable polling cursor. */
	async #advanceCursor(next: number): Promise<void> {
		try {
			const current = this.#deps.store.global.get();
			await this.#deps.store.global.set({ ...current, updateOffset: next });
		} catch (error) {
			this.#deps.log(`cursor write failed: ${(error as Error).message}`);
		}
	}

	/** Persist the runtime status for the Settings tab. */
	async #recordStatus(): Promise<void> {
		try {
			const current = this.#deps.store.global.get();
			await this.#deps.store.global.set({
				...current,
				status: this.#state,
				// Written even when empty: the store merges, so an omitted key keeps its
				// previous value and the file went on describing a failure the loop had
				// already recovered from.
				statusDetail: this.#detail ?? "",
				...(this.#botUsername === undefined ? {} : { botUsername: this.#botUsername }),
			});
		} catch (error) {
			this.#deps.log(`status write failed: ${(error as Error).message}`);
		}
	}
}

/**
 * What to show the reader when an item could not be sent.
 *
 * `TelegramApiError` messages carry the method and Telegram's own description and
 * never the request URL, so they are safe to surface — but they are also the raw
 * English of the API, so they are bounded to keep the notice a notice.
 * @param error - the failure.
 * @returns a short readable reason.
 */
function reasonOf(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.length > 120 ? `${message.slice(0, 119)}…` : message;
}

/** A label for an outbound item that failed on the wire. */
function outboundLabel(item: Outbound): string {
	switch (item.kind) {
		case "photo":
		case "document":
			return item.name;
		case "photo-url":
			return item.url;
		case "album":
			return `${String(item.items.length)} image(s)`;
		default:
			return "text";
	}
}

/** Parse `/name@bot args` into its parts. */
export function parseCommand(text: string): { name: string; args: string } | undefined {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return undefined;
	const [head, ...rest] = trimmed.slice(1).split(/\s+/);
	if (head === undefined || head === "") return undefined;
	const name = (head.split("@")[0] ?? "").toLowerCase();
	if (name === "") return undefined;
	return { name, args: rest.join(" ") };
}

/** The working directory for new sessions in a run. */

/** A human label for a chat, used as the session title. */
/** Label for a chat whose name the bot has not seen yet. */
const UNNAMED_CHAT = "chat";

function chatTitle(message: TelegramMessage | undefined): string {
	if (message === undefined) return UNNAMED_CHAT;
	const chat = message.chat;
	return chat.title ?? chat.username ?? chat.first_name ?? String(chat.id);
}

/**
 * The `/help` body: usage, plus the summary the plan asks for — working
 * directory, the model this chat is on, and whether the bot is actually running.
 * A help screen that cannot answer "is it even on?" sends the user to the desktop
 * for something the phone could have told them.
 * @param config - the live settings section.
 * @param state - current poller state.
 * @param model - the chat's model, when it has picked one.
 * @returns the message body.
 */
function helpText(
	config: TelegramConfig,
	state: "off" | "starting" | "running" | "error",
	model: string | undefined,
): string {
	const stateLabel = { off: "off", starting: "starting…", running: "running", error: "error" }[state];
	return [
		"I'm Buddy, running inside DeepSeek Harness on this machine. Message me and I'll work here.",
		"",
		"Commands:",
		"/new — start a new conversation (same working directory)",
		"/model — change the model for this chat (desktop default unaffected)",
		"/stop — stop the current turn",
		"/help — this message",
		"",
		`Working directory: ${config.defaultCwd}`,
		`Model: ${model ?? "(follows default)"}`,
		`Status: ${stateLabel}`,
		`Permission level: ${config.permissionPreset}`,
		"",
		"Files you send me are saved under downloads/ in the working directory.",
	].join("\n");
}
