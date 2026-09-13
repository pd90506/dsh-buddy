/**
 * A minimal Telegram Bot API client with token hygiene built in.
 *
 * The bot token is a path segment of every request URL (`/bot<token>/method`),
 * so anything that echoes a URL — a fetch rejection, a proxy log, a stack trace
 * — leaks the whole bot. Every error this module raises therefore carries only
 * the *method* name and Telegram's own description; the URL never leaves
 * {@link TelegramApi.request}. Callers must not log the token either, and the
 * settings tab only ever sees `configured / source / writable`.
 *
 * Only the methods this plugin uses are implemented, and only the update fields
 * it reads are typed: Telegram's schema is far larger than any one bridge needs,
 * and a narrower surface is a smaller thing to keep correct.
 * @module dsh-buddy/telegram/telegram/api
 */
import { setTimeout as delay } from "node:timers/promises";

/** Base URL for the cloud Bot API. */
export const API_BASE = "https://api.telegram.org";

/** Long-poll timeout handed to `getUpdates`, in seconds. */
export const POLL_TIMEOUT_SECONDS = 30;

/** Per-request ceiling for ordinary (non-polling) calls, in milliseconds. */
const REQUEST_TIMEOUT_MS = 30_000;

/** Overall ceiling for a long-poll call, in milliseconds. */
const POLL_REQUEST_TIMEOUT_MS = (POLL_TIMEOUT_SECONDS + 15) * 1000;

/**
 * Per-request ceiling for media uploads, in milliseconds.
 *
 * A photo or document body is orders of magnitude larger than a JSON payload, so
 * the JSON ceiling would abort a legitimately slow upload. It applies to the
 * three media calls; everything else keeps {@link REQUEST_TIMEOUT_MS}.
 */
const MEDIA_REQUEST_TIMEOUT_MS = 120_000;

/** UTF-16 units one re-sent piece of a too-long fallback may occupy. */
const PLAIN_RESPLIT_UNITS = 2000;

/** Item count Telegram accepts for one album, inclusive at both ends. */
export const MEDIA_GROUP_MIN_ITEMS = 2;
export const MEDIA_GROUP_MAX_ITEMS = 10;

/** Content type used for a document, whose real type Telegram sniffs itself. */
export const DOCUMENT_MEDIA_TYPE = "application/octet-stream";

/** A Telegram user or chat, limited to the fields this plugin reads. */
export interface TelegramChat {
	readonly id: number;
	readonly type: string;
	readonly title?: string;
	readonly username?: string;
	readonly first_name?: string;
}

/** A message, limited to the fields this plugin reads. */
export interface TelegramMessage {
	readonly message_id: number;
	readonly date: number;
	readonly chat: TelegramChat;
	readonly from?: TelegramChat & { readonly is_bot?: boolean };
	readonly message_thread_id?: number;
	readonly text?: string;
	readonly caption?: string;
	readonly document?: TelegramDocument;
	readonly photo?: readonly TelegramPhotoSize[];
}

/** A document attachment. */
export interface TelegramDocument {
	readonly file_id: string;
	readonly file_name?: string;
	readonly mime_type?: string;
	readonly file_size?: number;
}

/** One size variant of a photo attachment. */
export interface TelegramPhotoSize {
	readonly file_id: string;
	readonly width: number;
	readonly height: number;
	readonly file_size?: number;
}

/** A callback-query update (an inline-keyboard press). */
export interface TelegramCallbackQuery {
	readonly id: string;
	readonly from: TelegramChat & { readonly is_bot?: boolean };
	readonly message?: TelegramMessage;
	readonly data?: string;
}

/** An update envelope, limited to the kinds this plugin handles. */
export interface TelegramUpdate {
	readonly update_id: number;
	readonly message?: TelegramMessage;
	readonly callback_query?: TelegramCallbackQuery;
}

/** What `getMe` returns, limited to the fields this plugin reads. */
export interface TelegramBotInfo {
	readonly id: number;
	readonly is_bot: boolean;
	readonly first_name: string;
	readonly username?: string;
}

/** A file handle returned by `getFile`. */
export interface TelegramFile {
	readonly file_id: string;
	readonly file_path?: string;
	readonly file_size?: number;
}

/** One inline-keyboard button. `callback_data` must be 1–64 bytes. */
export interface TelegramInlineButton {
	readonly text: string;
	readonly callback_data: string;
}

/** Options accepted by every `sendMessage`-shaped call. */
export interface SendMessageOptions {
	readonly chatId: number;
	readonly text: string;
	/**
	 * Escaped-plain-text version of {@link text}, the safety net for a body
	 * Telegram refuses.
	 *
	 * Rendering agent output into entities can produce a body the parser rejects;
	 * when that happens this text — same content, only escaped — is sent instead,
	 * so a formatting mistake degrades to unformatted text rather than silence. It
	 * is also what a "message is too long" rejection is re-cut from.
	 */
	readonly plain?: string | undefined;
	readonly threadId?: number | undefined;
	readonly keyboard?: readonly (readonly TelegramInlineButton[])[] | undefined;
}

/** Options for {@link TelegramApi.sendPhoto}. */
export interface SendPhotoOptions {
	readonly chatId: number;
	/**
	 * The photo: bytes to upload, or an HTTP URL for Telegram to fetch.
	 *
	 * Only the upload path carries a media type — Telegram downloads a URL itself
	 * and does not want our guess at what is behind it.
	 */
	readonly photo: { readonly bytes: Uint8Array; readonly name: string; readonly mediaType: string } | { readonly url: string };
	/** Caption text, already valid Telegram HTML; at most 1024 visible characters. */
	readonly caption?: string | undefined;
	readonly threadId?: number | undefined;
}

/** Options for {@link TelegramApi.sendDocument}. */
export interface SendDocumentOptions {
	readonly chatId: number;
	readonly document: { readonly bytes: Uint8Array; readonly name: string };
	/** Caption text, already valid Telegram HTML; at most 1024 visible characters. */
	readonly caption?: string | undefined;
	readonly threadId?: number | undefined;
}

/** Options for {@link TelegramApi.sendMediaGroup}. */
export interface SendMediaGroupOptions {
	readonly chatId: number;
	/** Album members, in order; Telegram accepts 2–10 of them. */
	readonly items: readonly { readonly bytes: Uint8Array; readonly name: string; readonly mediaType: string }[];
	/** Caption for the album's first item, already valid Telegram HTML. */
	readonly caption?: string | undefined;
	readonly threadId?: number | undefined;
}

/** An error reported by the Bot API, or by the transport. */
export class TelegramApiError extends Error {
	/** HTTP status, when the failure came back as a response. */
	readonly status: number | undefined;
	/** Telegram's `error_code`, when present. */
	readonly code: number | undefined;
	/** `parameters.retry_after`, for flood-control responses. */
	readonly retryAfter: number | undefined;

	/**
	 * @param message - description safe to log (never contains the token).
	 * @param options - status/code/retryAfter, all optional.
	 */
	constructor(
		message: string,
		options: { status?: number | undefined; code?: number | undefined; retryAfter?: number | undefined } = {},
	) {
		super(message);
		this.name = "TelegramApiError";
		this.status = options.status;
		this.code = options.code;
		this.retryAfter = options.retryAfter;
	}

	/** Whether this failure is Telegram asking us to slow down. */
	get isFlood(): boolean {
		return this.code === 429 || this.status === 429;
	}

	/** Whether the token itself was rejected (revoked, or never valid). */
	get isUnauthorized(): boolean {
		return this.code === 401 || this.status === 401;
	}
}

/** Result of a successful `getUpdates` call. */
export interface GetUpdatesResult {
	readonly updates: readonly TelegramUpdate[];
	/** Whether the long poll returned because its timeout elapsed. */
	readonly timedOut: boolean;
}

/** Collaborators of {@link TelegramApi}. */
export interface TelegramApiOptions {
	/** The bot token from the credentials plane. */
	readonly token: string;
	/** Transport, injectable for tests. */
	readonly fetch?: typeof fetch | undefined;
	/** Sink for non-fatal diagnostics; must never receive the token. */
	readonly log?: ((line: string) => void) | undefined;
	/**
	 * API origin, defaulting to the cloud Bot API.
	 *
	 * Overridable so an integration test can point the client at a local server
	 * and exercise the real transport — request shape, envelope handling, and the
	 * file-download URL — instead of a fetch stub that proves none of it.
	 */
	readonly baseUrl?: string | undefined;
}

/**
 * Thin, token-safe wrapper over the Bot API.
 *
 * One instance is bound to one token; rebuilding it is how a token change takes
 * effect, so there is no setter for the credential.
 */
export class TelegramApi {
	readonly #token: string;
	readonly #fetch: typeof fetch;
	readonly #log: (line: string) => void;
	readonly #baseUrl: string;

	/**
	 * @param options - token plus optional transport and logger.
	 */
	constructor(options: TelegramApiOptions) {
		this.#token = options.token;
		this.#fetch = options.fetch ?? globalThis.fetch;
		this.#log = options.log ?? ((): void => {});
		this.#baseUrl = (options.baseUrl ?? API_BASE).replace(/\/$/, "");
	}

	/**
	 * Perform one Bot API call.
	 *
	 * Unwraps Telegram's `{ok, result | error_code, description}` envelope and
	 * converts failures into {@link TelegramApiError} so callers can branch on
	 * `isFlood` / `isUnauthorized` instead of parsing English.
	 * @param method - Bot API method name.
	 * @param payload - JSON body; never contains the token.
	 * @param signal - caller cancellation.
	 * @returns the unwrapped `result`.
	 */
	async request<T>(method: string, payload: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
		const isPoll = method === "getUpdates";
		return await this.#json<T>(method, payload, isPoll ? POLL_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS, signal);
	}

	/**
	 * Perform one multipart Bot API call.
	 *
	 * No `content-type` is set here, deliberately: only `fetch` knows the boundary
	 * it generated, and a hand-written header would describe a body Telegram cannot
	 * split back into fields. Everything else — the URL, the cancellation, the
	 * envelope unwrapping, the error mapping — is shared with {@link request}.
	 * @param method - Bot API method name.
	 * @param form - the multipart body; never contains the token.
	 * @param signal - caller cancellation.
	 * @returns the unwrapped `result`.
	 */
	async requestMultipart<T>(method: string, form: FormData, signal?: AbortSignal): Promise<T> {
		return await this.#perform<T>(method, form, undefined, MEDIA_REQUEST_TIMEOUT_MS, signal);
	}

	/**
	 * Perform one JSON Bot API call at an explicit ceiling.
	 * @param method - Bot API method name.
	 * @param payload - JSON body; never contains the token.
	 * @param timeoutMs - per-request ceiling.
	 * @param signal - caller cancellation.
	 * @returns the unwrapped `result`.
	 */
	async #json<T>(
		method: string,
		payload: Record<string, unknown>,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<T> {
		return await this.#perform<T>(method, JSON.stringify(payload), { "content-type": "application/json" }, timeoutMs, signal);
	}

	/**
	 * Send one body and unwrap Telegram's envelope.
	 *
	 * The single place the token meets a URL, and therefore the single place that
	 * must never let the URL escape: a transport failure is summarized by its cause
	 * name, and an API failure carries only the method and Telegram's description.
	 * @param method - Bot API method name.
	 * @param body - JSON string or multipart form; never contains the token.
	 * @param headers - headers for this request, or undefined to let fetch decide.
	 * @param timeoutMs - per-request ceiling.
	 * @param signal - caller cancellation.
	 * @returns the unwrapped `result`.
	 */
	async #perform<T>(
		method: string,
		body: BodyInit,
		headers: Record<string, string> | undefined,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<T> {
		const timeout = AbortSignal.timeout(timeoutMs);
		const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
		let response: Response;
		try {
			response = await this.#fetch(`${this.#baseUrl}/bot${this.#token}/${method}`, {
				method: "POST",
				...(headers === undefined ? {} : { headers }),
				body,
				signal: combined,
			});
		} catch (error) {
			// The thrown value embeds the URL, so it is summarized rather than
			// forwarded: `fetch failed` plus a cause *name* is enough to act on.
			const cause = (error as { cause?: { code?: string; name?: string } }).cause;
			const detail = cause?.code ?? cause?.name ?? (error as Error).name;
			throw new TelegramApiError(`${method}: transport failure (${String(detail)})`);
		}
		let envelopeBody: unknown;
		try {
			envelopeBody = await response.json();
		} catch {
			throw new TelegramApiError(`${method}: HTTP ${String(response.status)} with a non-JSON body`, {
				status: response.status,
			});
		}
		const envelope = envelopeBody as {
			ok?: boolean;
			result?: unknown;
			error_code?: number;
			description?: string;
			parameters?: { retry_after?: number };
		};
		if (envelope.ok === true) return envelope.result as T;
		throw new TelegramApiError(`${method}: ${envelope.description ?? `HTTP ${String(response.status)}`}`, {
			status: response.status,
			code: envelope.error_code,
			retryAfter: envelope.parameters?.retry_after,
		});
	}

	/**
	 * Validate the token and learn who we are.
	 * @param signal - caller cancellation.
	 * @returns the bot's own identity.
	 */
	async getMe(signal?: AbortSignal): Promise<TelegramBotInfo> {
		return this.request<TelegramBotInfo>("getMe", {}, signal);
	}

	/**
	 * Clear any webhook left on this token.
	 *
	 * `getUpdates` answers 409 while a webhook is set, so this is the first call
	 * of every polling startup — a stale webhook from an earlier experiment is
	 * the most likely reason a fresh install would otherwise never receive
	 * anything.
	 * @param signal - caller cancellation.
	 */
	async deleteWebhook(signal?: AbortSignal): Promise<void> {
		await this.request<boolean>("deleteWebhook", { drop_pending_updates: false }, signal);
	}

	/**
	 * Publish the command menu Telegram renders above the keyboard.
	 * @param commands - `{command, description}` pairs; 1–32 lowercase chars each.
	 * @param signal - caller cancellation.
	 */
	async setMyCommands(
		commands: readonly { command: string; description: string }[],
		signal?: AbortSignal,
	): Promise<void> {
		await this.request<boolean>("setMyCommands", { commands }, signal);
	}

	/**
	 * Long-poll for updates.
	 * @param options - the cursor and cancellation.
	 * @returns updates plus whether the call simply timed out.
	 */
	async getUpdates(options: {
		offset?: number | undefined;
		timeoutSeconds?: number | undefined;
		signal?: AbortSignal | undefined;
	}): Promise<GetUpdatesResult> {
		const updates = await this.request<TelegramUpdate[]>(
			"getUpdates",
			{
				...(options.offset === undefined ? {} : { offset: options.offset }),
				timeout: options.timeoutSeconds ?? POLL_TIMEOUT_SECONDS,
				limit: 100,
				// Stated explicitly: an omitted field means "keep the previous
				// setting" server-side, which is not a thing we can reason about.
				allowed_updates: ["message", "callback_query"],
			},
			options.signal,
		);
		return { updates, timedOut: updates.length === 0 };
	}

	/**
	 * Send a text message.
	 *
	 * Two failures have a defined recovery, and only when the caller supplied
	 * {@link SendMessageOptions.plain}: a body whose entities cannot be parsed is
	 * re-sent as escaped plain text, and a body Telegram calls too long is re-cut
	 * into {@link PLAIN_RESPLIT_UNITS}-unit pieces. Both recoveries happen once —
	 * a second failure propagates, because retrying a rejected body forever would
	 * be worse than reporting it. Every other failure propagates unchanged.
	 * @param options - target chat, text, and optional fallback/keyboard/threading.
	 * @param signal - caller cancellation.
	 * @returns the id of the first message sent.
	 */
	async sendMessage(options: SendMessageOptions, signal?: AbortSignal): Promise<number> {
		try {
			return await this.#sendText(options, options.text, signal);
		} catch (error) {
			if (!(error instanceof TelegramApiError)) throw error;
			const plain = options.plain;
			if (plain === undefined || plain === "") throw error;
			if (isEntityParseFailure(error)) return await this.#sendText(options, plain, signal);
			if (isMessageTooLong(error)) {
				// The fallback is cut in UTF-16 code units, which is the unit both
				// `String#length` and Telegram count in.
				const [head = "", ...rest] = splitUnits(plain, PLAIN_RESPLIT_UNITS);
				const firstId = await this.#sendText(options, head, signal);
				for (const piece of rest) await this.#sendText(options, piece, signal);
				return firstId;
			}
			throw error;
		}
	}

	/**
	 * Send one HTML-parsed text message and return its id.
	 * @param options - the caller's message options, for its routing fields.
	 * @param text - the body to send.
	 * @param signal - caller cancellation.
	 * @returns the sent message's id.
	 */
	async #sendText(options: SendMessageOptions, text: string, signal?: AbortSignal): Promise<number> {
		const message = await this.request<TelegramMessage>(
			"sendMessage",
			{
				chat_id: options.chatId,
				text,
				parse_mode: "HTML",
				link_preview_options: { is_disabled: true },
				...(options.threadId === undefined ? {} : { message_thread_id: options.threadId }),
				...(options.keyboard === undefined ? {} : { reply_markup: { inline_keyboard: options.keyboard } }),
			},
			signal,
		);
		return message.message_id;
	}

	/**
	 * Send one photo, either uploaded from bytes or fetched from a URL.
	 *
	 * The upload path is limited by Telegram to 10 MB, and to 10000 pixels of
	 * width plus height at a ratio no wider than 20:1; those limits belong to the
	 * caller's sizing decision, not here.
	 * @param options - target chat, the photo, and optional caption/threading.
	 * @param signal - caller cancellation.
	 * @returns the sent message's id.
	 */
	async sendPhoto(options: SendPhotoOptions, signal?: AbortSignal): Promise<number> {
		if ("url" in options.photo) {
			const message = await this.#json<TelegramMessage>(
				"sendPhoto",
				{
					chat_id: options.chatId,
					photo: options.photo.url,
					...(options.caption === undefined ? {} : { caption: options.caption, parse_mode: "HTML" }),
					...(options.threadId === undefined ? {} : { message_thread_id: options.threadId }),
				},
				MEDIA_REQUEST_TIMEOUT_MS,
				signal,
			);
			return message.message_id;
		}
		const form = withCaption(mediaForm(options.chatId, options.threadId), options.caption);
		form.set("photo", uploadBlob(options.photo.bytes, options.photo.mediaType), options.photo.name);
		const message = await this.requestMultipart<TelegramMessage>("sendPhoto", form, signal);
		return message.message_id;
	}

	/**
	 * Send one file as a document.
	 *
	 * Documents carry no image restrictions — any type is accepted up to 50 MB —
	 * so this is also where an image too large or too oddly shaped for a photo
	 * ends up.
	 * @param options - target chat, the file, and optional caption/threading.
	 * @param signal - caller cancellation.
	 * @returns the sent message's id.
	 */
	async sendDocument(options: SendDocumentOptions, signal?: AbortSignal): Promise<number> {
		const form = withCaption(mediaForm(options.chatId, options.threadId), options.caption);
		form.set("document", uploadBlob(options.document.bytes, DOCUMENT_MEDIA_TYPE), options.document.name);
		const message = await this.requestMultipart<TelegramMessage>("sendDocument", form, signal);
		return message.message_id;
	}

	/**
	 * Send 2–10 photos as one album.
	 *
	 * The album is a single multipart request: `media` names each member as
	 * `attach://p<index>`, and the file parts carry those exact names. Telegram
	 * rejects any other item count, so an out-of-range call is refused here rather
	 * than spent on a round trip.
	 * @param options - target chat, the album members, and an optional caption.
	 * @param signal - caller cancellation.
	 * @returns the sent messages' ids, in album order.
	 * @throws Error when the item count is outside 2–10.
	 */
	async sendMediaGroup(options: SendMediaGroupOptions, signal?: AbortSignal): Promise<number[]> {
		const count = options.items.length;
		if (count < MEDIA_GROUP_MIN_ITEMS || count > MEDIA_GROUP_MAX_ITEMS) {
			throw new Error(
				`sendMediaGroup: Telegram requires ${String(MEDIA_GROUP_MIN_ITEMS)}-${String(MEDIA_GROUP_MAX_ITEMS)} items, got ${String(count)}`,
			);
		}
		const form = mediaForm(options.chatId, options.threadId);
		const media = options.items.map((_item, index) => ({
			type: "photo",
			media: `attach://p${String(index)}`,
			// Only the first item carries the caption: that is the one Telegram shows
			// under the album, so repeating it would be noise the reader cannot see.
			...(index === 0 && options.caption !== undefined ? { caption: options.caption, parse_mode: "HTML" } : {}),
		}));
		form.set("media", JSON.stringify(media));
		options.items.forEach((item, index) => {
			form.set(`p${String(index)}`, uploadBlob(item.bytes, item.mediaType), item.name);
		});
		const messages = await this.requestMultipart<TelegramMessage[]>("sendMediaGroup", form, signal);
		return messages.map((message) => message.message_id);
	}

	/**
	 * Replace the text (and keyboard) of a message this bot sent.
	 *
	 * Telegram rejects a no-op edit with 400 "message is not modified"; that is
	 * treated as success because the desired state is already on screen.
	 * @param options - target message plus the replacement text.
	 * @param signal - caller cancellation.
	 */
	async editMessageText(
		options: { chatId: number; messageId: number; text: string; keyboard?: readonly (readonly TelegramInlineButton[])[] | undefined },
		signal?: AbortSignal,
	): Promise<void> {
		try {
			await this.request<unknown>(
				"editMessageText",
				{
					chat_id: options.chatId,
					message_id: options.messageId,
					text: options.text,
					parse_mode: "HTML",
					link_preview_options: { is_disabled: true },
					...(options.keyboard === undefined ? {} : { reply_markup: { inline_keyboard: options.keyboard } }),
				},
				signal,
			);
		} catch (error) {
			if (error instanceof TelegramApiError && error.message.includes("message is not modified")) return;
			throw error;
		}
	}


	/**
	 * Acknowledge a button press.
	 *
	 * Telegram spins a progress bar in the client until this is called, so it
	 * must never wait on agent work; `text` shows as a toast.
	 * @param id - the callback query id.
	 * @param text - optional toast (0–200 chars).
	 * @param signal - caller cancellation.
	 */
	async answerCallbackQuery(id: string, text?: string, signal?: AbortSignal): Promise<void> {
		await this.request<boolean>(
			"answerCallbackQuery",
			{ callback_query_id: id, ...(text === undefined ? {} : { text }) },
			signal,
		);
	}

	/**
	 * Show "typing…" in a chat. Telegram clears it after ~5 seconds, so a long
	 * turn re-arms it on a heartbeat.
	 * @param chatId - target chat.
	 * @param threadId - topic to place the indicator in, when applicable.
	 * @param signal - caller cancellation.
	 */
	async sendTyping(chatId: number, threadId?: number, signal?: AbortSignal): Promise<void> {
		await this.request<boolean>(
			"sendChatAction",
			{ chat_id: chatId, action: "typing", ...(threadId === undefined ? {} : { message_thread_id: threadId }) },
			signal,
		);
	}

	/**
	 * Describe a file so it can be downloaded.
	 * @param fileId - the attachment's `file_id`.
	 * @param signal - caller cancellation.
	 */
	async getFile(fileId: string, signal?: AbortSignal): Promise<TelegramFile> {
		return this.request<TelegramFile>("getFile", { file_id: fileId }, signal);
	}

	/**
	 * Download a file's bytes.
	 *
	 * The download URL embeds the token, so it is built here and never surfaced;
	 * failures are summarized like every other transport error.
	 * @param filePath - `file_path` from {@link getFile}.
	 * @param signal - caller cancellation.
	 * @returns the file contents.
	 */
	async downloadFile(filePath: string, signal?: AbortSignal): Promise<Uint8Array> {
		const timeout = AbortSignal.timeout(60_000);
		const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
		try {
			const response = await this.#fetch(`${this.#baseUrl}/file/bot${this.#token}/${filePath}`, {
				signal: combined,
			});
			if (!response.ok) {
				throw new TelegramApiError(`file download: HTTP ${String(response.status)}`, { status: response.status });
			}
			return new Uint8Array(await response.arrayBuffer());
		} catch (error) {
			if (error instanceof TelegramApiError) throw error;
			this.#log(`file download failed: ${(error as Error).name}`);
			throw new TelegramApiError("file download: transport failure");
		}
	}
}

/**
 * Build the form fields every media call shares.
 * @param chatId - target chat.
 * @param threadId - topic to post into, when applicable.
 * @returns a form carrying `chat_id` and, when given, `message_thread_id`.
 */
function mediaForm(chatId: number, threadId: number | undefined): FormData {
	const form = new FormData();
	form.set("chat_id", String(chatId));
	if (threadId !== undefined) form.set("message_thread_id", String(threadId));
	return form;
}

/**
 * Attach a caption, which Telegram parses as HTML, when one is given.
 *
 * An absent caption sets neither field: an empty `caption` is a caption, and
 * `parse_mode` without text to parse is noise on every upload.
 * @param form - the form to extend.
 * @param caption - the caption, or undefined.
 * @returns the same form, for chaining.
 */
function withCaption(form: FormData, caption: string | undefined): FormData {
	if (caption !== undefined) {
		form.set("caption", caption);
		form.set("parse_mode", "HTML");
	}
	return form;
}

/**
 * Wrap upload bytes as a file part.
 * @param bytes - the file's exact contents.
 * @param mediaType - the declared content type.
 * @returns the blob to append under the method's file field.
 */
function uploadBlob(bytes: Uint8Array, mediaType: string): Blob {
	// A `Uint8Array` is always a view over ordinary memory here, but its declared
	// buffer type is the wider `ArrayBufferLike`; the assertion stops the DOM lib's
	// narrower `BlobPart` from forcing a copy of a file that can be megabytes.
	return new Blob([bytes as BlobPart], { type: mediaType });
}

/**
 * Cut text into pieces of at most `units` UTF-16 code units.
 *
 * UTF-16 is deliberate: it is the unit `String#length` uses and the unit Telegram
 * counts a message in, so a piece's `length` is its delivered length.
 * @param text - the text to cut.
 * @param units - the per-piece ceiling, in UTF-16 code units.
 * @returns the pieces, in order.
 */
function splitUnits(text: string, units: number): string[] {
	const pieces: string[] = [];
	for (let index = 0; index < text.length; index += units) pieces.push(text.slice(index, index + units));
	return pieces;
}

/**
 * Whether Telegram refused a body because its entities could not be parsed.
 *
 * The description is the only signal the Bot API offers, and the alternative to
 * branching on it is losing a reply to one malformed tag.
 * @param error - a failure raised by this client.
 * @returns whether the escaped fallback should be sent instead.
 */
function isEntityParseFailure(error: TelegramApiError): boolean {
	return error.code === 400 && /can't parse entities/i.test(error.message);
}

/**
 * Whether Telegram refused a body as too long.
 *
 * Official documentation never says what an over-long body produces ([OBS]: the
 * 400 comes from practice), so this string is the only handle there is.
 * @param error - a failure raised by this client.
 * @returns whether the fallback should be re-cut and re-sent.
 */
function isMessageTooLong(error: TelegramApiError): boolean {
	return error.code === 400 && /message is too long/i.test(error.message);
}

/**
 * Sleep for a flood-control backoff.
 * @param seconds - `retry_after` from the API, in seconds.
 * @param signal - caller cancellation.
 */
export async function backoff(seconds: number, signal?: AbortSignal): Promise<void> {
	await delay(Math.max(1, Math.ceil(seconds)) * 1000, undefined, signal === undefined ? {} : { signal });
}
