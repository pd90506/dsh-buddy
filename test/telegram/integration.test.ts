/**
 * End-to-end over loopback: the runtime against a real HTTP server standing in
 * for `api.telegram.org`.
 *
 * Every other test stubs `fetch`, which proves the *call sequence* but not the
 * wire: not the URL the token is spliced into, not the JSON envelope, not the
 * long-poll loop's real timing. This one speaks HTTP to a socket, so a reply that
 * reaches the fake server has genuinely travelled the whole path — poll → merge →
 * turn → render → send.
 */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { after, test } from "node:test";
import { ApprovalBridge } from "../../src/telegram/approvals.ts";
import { ModelMenu } from "../../src/telegram/model.ts";
import { TelegramRuntime } from "../../src/telegram/runtime.ts";
import { TelegramApi } from "../../src/telegram/telegram/api.ts";
import type { TelegramConfig } from "../../src/telegram/config.ts";
import type { ChatRecord } from "../../src/telegram/store.ts";

const TOKEN = "110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";

/** One parsed part of a `multipart/form-data` body. */
interface MultipartPart {
	readonly name: string;
	readonly filename: string | undefined;
	readonly bytes: Uint8Array;
}

/** One recorded Bot API call. */
interface RecordedCall {
	readonly method: string;
	readonly path: string;
	readonly body: Record<string, unknown>;
	/** Multipart parts with their raw bytes; empty for a JSON call. */
	readonly parts: readonly MultipartPart[];
}

/**
 * Parse a `multipart/form-data` body into its parts.
 *
 * Hand-rolled on purpose: the fake server has to understand exactly the wire
 * format the client produced — the boundary from the header, the
 * `Content-Disposition` fields, and each file part's raw bytes — so a malformed
 * upload fails here instead of being normalized away by a platform parser.
 * @param body - the raw request body.
 * @param boundary - the boundary token taken from the `content-type` header.
 * @returns the parts in body order.
 */
function parseMultipart(body: Buffer, boundary: string): MultipartPart[] {
	const parts: MultipartPart[] = [];
	const marker = Buffer.from(`--${boundary}`);
	let cursor = body.indexOf(marker);
	while (cursor !== -1) {
		let start = cursor + marker.length;
		// A closing delimiter (`--<boundary>--`) ends the body.
		if (body[start] === 0x2d && body[start + 1] === 0x2d) break;
		if (body[start] === 0x0d && body[start + 1] === 0x0a) start += 2;
		const headerEnd = body.indexOf("\r\n\r\n", start);
		if (headerEnd === -1) break;
		const headers = body.subarray(start, headerEnd).toString("utf8");
		const contentStart = headerEnd + 4;
		const next = body.indexOf(marker, contentStart);
		if (next === -1) break;
		parts.push({
			name: /name="([^"]*)"/.exec(headers)?.[1] ?? "",
			filename: /filename="([^"]*)"/.exec(headers)?.[1],
			// Each part's bytes end with the CRLF that precedes the next delimiter.
			bytes: body.subarray(contentStart, next - 2),
		});
		cursor = next;
	}
	return parts;
}

/**
 * Decode one request body into the text fields a test asserts on.
 *
 * A JSON body is parsed as-is; a multipart body contributes its text fields
 * (files stay in {@link MultipartPart.bytes}) plus every part.
 * @param request - the inbound request, for its `content-type`.
 * @param raw - the raw body bytes.
 * @returns the text-field map and the multipart parts.
 */
function decodeBody(request: IncomingMessage, raw: Buffer): { body: Record<string, unknown>; parts: MultipartPart[] } {
	const contentType = String(request.headers["content-type"] ?? "");
	const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
	if (!contentType.startsWith("multipart/form-data") || boundary === null) {
		return { body: raw.length === 0 ? {} : (JSON.parse(raw.toString()) as Record<string, unknown>), parts: [] };
	}
	const parts = parseMultipart(raw, (boundary[1] ?? boundary[2] ?? "").trim());
	const fields = parts
		.filter((part) => part.filename === undefined)
		.map((part) => [part.name, Buffer.from(part.bytes).toString("utf8")] as const);
	return { body: Object.fromEntries(fields), parts };
}

/** A stand-in for the Telegram Bot API, reachable over loopback. */
class FakeTelegram {
	readonly calls: RecordedCall[] = [];
	/** Updates handed out by the next `getUpdates` call, then drained. */
	queue: unknown[] = [];
	readonly #server: Server;
	readonly #port: number;

	private constructor(server: Server, port: number) {
		this.#server = server;
		this.#port = port;
	}

	/** Start listening on an ephemeral port. */
	static async start(): Promise<FakeTelegram> {
		let instance: FakeTelegram | undefined;
		const server = createServer((request, response) => {
			instance?.handle(request, response);
		});
		await new Promise<void>((resolve) => {
			server.listen(0, "127.0.0.1", resolve);
		});
		const address = server.address();
		const port = typeof address === "object" && address !== null ? address.port : 0;
		instance = new FakeTelegram(server, port);
		return instance;
	}

	/** Origin the runtime should be pointed at. */
	get origin(): string {
		return `http://127.0.0.1:${String(this.#port)}`;
	}

	/** Stop listening. */
	async stop(): Promise<void> {
		await new Promise<void>((resolve) => {
			this.#server.close(() => {
				resolve();
			});
		});
	}

	/** Calls to one method. */
	of(method: string): RecordedCall[] {
		return this.calls.filter((call) => call.method === method);
	}

	/**
	 * Handle one Bot API request.
	 * @param request - the inbound request.
	 * @param response - the response to fill in.
	 */
	handle(request: IncomingMessage, response: ServerResponse): void {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			const path = request.url ?? "";
			const raw = Buffer.concat(chunks);
			const match = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(path);
			if (match === null) {
				// A malformed path means the client built the URL wrong; failing it
				// loudly is the point of testing against a real socket.
				response.writeHead(404).end(JSON.stringify({ ok: false, error_code: 404, description: `bad path ${path}` }));
				return;
			}
			const [, token, method = ""] = match;
			this.calls.push({ method, path, ...decodeBody(request, raw) });
			if (token !== TOKEN) {
				response.writeHead(401).end(JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" }));
				return;
			}
			const reply = (result: unknown): void => {
				response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, result }));
			};
			if (method === "getUpdates") {
				const updates = this.queue;
				this.queue = [];
				// An empty poll waits, like the real long poll, so the loop cannot
				// spin at full speed while the test gets on with its work.
				if (updates.length === 0) setTimeout(() => reply([]), 20);
				else reply(updates);
				return;
			}
			if (method === "getMe") {
				reply({ id: 1, is_bot: true, first_name: "itest", username: "itest_bot" });
				return;
			}
			if (method === "sendMessage" || method === "sendPhoto" || method === "sendDocument") {
				reply({ message_id: 99, date: 0, chat: { id: 42, type: "private" } });
				return;
			}
			if (method === "sendMediaGroup") {
				reply([
					{ message_id: 97, date: 0, chat: { id: 42, type: "private" } },
					{ message_id: 98, date: 0, chat: { id: 42, type: "private" } },
				]);
				return;
			}
			reply(true);
		});
	}
}

/** Wait until a condition holds, or fail. */
async function waitFor(what: string, predicate: () => boolean, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`timed out waiting for ${what}`);
}

/** A config pointing at the loopback origin's owner. */
function config(): TelegramConfig {
	return {
		enabled: true,
		ownerUserId: "42",
		defaultCwd: "/tmp/dsh-telegram-integration",
		permissionPreset: "workspace-write",
		renderMarkdown: true,
		mediaDelivery: "all",
	};
}

const telegram = await FakeTelegram.start();

after(async () => {
	await telegram.stop();
});

test("a message travels the whole path and its reply reaches the Bot API", async () => {
	const turns: string[] = [];
	const globalState: Record<string, unknown> = {};
	const records = new Map<string, ChatRecord>();
	const origins = new Map<string, { chatId: string; createdAt: string }>();
	const store = {
		chats: {
			get: (key: string) => records.get(key),
			put: async (key: string, value: ChatRecord) => {
				records.set(key, value);
			},
			delete: async (key: string) => records.delete(key),
		},
		origins: {
			get: (key: string) => origins.get(key),
			put: async (key: string, value: { chatId: string; createdAt: string }) => {
				origins.set(key, value);
			},
			entries: () => origins.entries(),
		},
		global: {
			get: () => globalState,
			set: async (value: Record<string, unknown>) => {
				Object.assign(globalState, value);
			},
		},
		close: async () => undefined,
	};
	const manager = {
		ensure: async () => ({
			sessionId: "session-integration",
			agent: {
				session: { id: "session-integration", header: { cwd: "/tmp/dsh-telegram-runtime" } },
				status: "idle",
			},
			created: true,
		}),
		runTurn: async (
			_chat: unknown,
			text: string,
			onParts: (parts: readonly { kind: "text"; text: string }[]) => Promise<void>,
		) => {
			turns.push(text);
			await onParts([{ kind: "text" as const, text: "构建通过，3 个测试失败的都是旧的。" }]);
		},
		steer: () => undefined,
		cancel: () => undefined,
		forget: () => undefined,
		setSelection: async () => undefined,
		dispose: () => undefined,
	};
	const runtime = new TelegramRuntime({
		get: () => undefined,
		store: store as never,
		manager: manager as never,
		approvals: new ApprovalBridge({
			api: () => undefined,
			isOurs: () => false,
			chatFor: () => undefined,
			log: () => undefined,
		}),
		menu: new ModelMenu(),
		config,
		log: () => undefined,
		apiBase: telegram.origin,
	});

	await runtime.start(TOKEN);
	assert.equal(runtime.status().state, "running");
	assert.equal(runtime.status().botUsername, "itest_bot");
	assert.deepEqual(
		telegram.calls.slice(0, 3).map((call) => call.method),
		["getMe", "deleteWebhook", "setMyCommands"],
	);

	const chat = { id: 42, type: "private" };
	telegram.queue.push({
		update_id: 7,
		message: { message_id: 1, date: 0, chat, from: { ...chat, is_bot: false }, text: "跑一下测试" },
	});

	await waitFor("the reply to be sent", () => telegram.of("sendMessage").length > 0);
	const sent = telegram.of("sendMessage")[0];
	assert.equal(sent?.body["chat_id"], 42);
	assert.equal(sent?.body["text"], "构建通过，3 个测试失败的都是旧的。");
	assert.equal(sent?.body["parse_mode"], "HTML");
	assert.deepEqual(sent?.body["link_preview_options"], { is_disabled: true });
	assert.match(sent?.path ?? "", new RegExp(`^/bot${TOKEN}/sendMessage$`), "the token belongs in the path");
	assert.deepEqual(turns, ["跑一下测试"]);

	// The typing indicator and the durable cursor are part of the same run.
	assert.ok(telegram.of("sendChatAction").length > 0, "typing must be shown while the turn runs");
	await waitFor("the cursor to advance", () => globalState["updateOffset"] === 8);
	assert.equal(globalState["status"], "running");

	await runtime.stop();
	assert.equal(runtime.status().state, "off");
});

test("a photo upload travels the wire as multipart and arrives byte for byte", async () => {
	// The client, not the runtime: what is under test here is the wire format the
	// upload produces — boundary, field names, filenames, and the bytes themselves.
	const api = new TelegramApi({ token: TOKEN, baseUrl: telegram.origin });
	const bytes = new Uint8Array(4096).map((_, index) => (index * 7) % 251);

	const messageId = await api.sendPhoto({
		chatId: 42,
		photo: { bytes, name: "chart.png", mediaType: "image/png" },
		caption: "图表",
		threadId: 5,
	});

	assert.equal(messageId, 99);
	const call = telegram.of("sendPhoto")[0];
	assert.match(call?.path ?? "", new RegExp(`^/bot${TOKEN}/sendPhoto$`), "the token belongs in the path");
	assert.equal(call?.body["chat_id"], "42");
	assert.equal(call?.body["caption"], "图表");
	assert.equal(call?.body["parse_mode"], "HTML");
	assert.equal(call?.body["message_thread_id"], "5");
	const photo = call?.parts.find((part) => part.name === "photo");
	assert.equal(photo?.filename, "chart.png", "the upload must carry the file's name");
	assert.equal(photo?.bytes.byteLength, bytes.byteLength, "the upload must arrive whole");
	assert.deepEqual([...new Uint8Array(photo?.bytes ?? [])], [...bytes]);
});

test("an album upload carries both files and their attach:// references", async () => {
	const api = new TelegramApi({ token: TOKEN, baseUrl: telegram.origin });
	const first = new TextEncoder().encode("first-image");
	const second = new TextEncoder().encode("second-image");

	const ids = await api.sendMediaGroup({
		chatId: 42,
		items: [
			{ bytes: first, name: "a.png", mediaType: "image/png" },
			{ bytes: second, name: "b.png", mediaType: "image/png" },
		],
	});

	assert.deepEqual(ids, [97, 98]);
	const call = telegram.of("sendMediaGroup")[0];
	assert.deepEqual(JSON.parse(String(call?.body["media"])), [
		{ type: "photo", media: "attach://p0" },
		{ type: "photo", media: "attach://p1" },
	]);
	assert.deepEqual([...(call?.parts.find((part) => part.name === "p0")?.bytes ?? [])], [...first]);
	assert.deepEqual([...(call?.parts.find((part) => part.name === "p1")?.bytes ?? [])], [...second]);
});
