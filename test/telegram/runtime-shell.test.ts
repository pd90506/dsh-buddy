/**
 * The runtime shell: startup order, the owner gate, the polling cursor, the
 * merge hand-off, and what happens to a message that arrives mid-turn.
 *
 * Acceptance criterion AC-4 asks specifically for a test that a non-owner is
 * dropped — silently, and without their text reaching a log. The startup order
 * matters for the same reason a fresh install is the likeliest thing to fail:
 * `getUpdates` answers 409 while a webhook is set, so `deleteWebhook` has to come
 * first. The cursor matters because Telegram replays up to 24 hours of backlog to
 * a client that comes back without one.
 */
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { after, test } from "node:test";
import { ApprovalBridge } from "../../src/telegram/approvals.ts";
import { ModelMenu } from "../../src/telegram/model.ts";
import { TelegramRuntime } from "../../src/telegram/runtime.ts";
import type { TurnPart } from "../../src/telegram/session.ts";
import type { TelegramConfig } from "../../src/telegram/config.ts";
import type { ChatRecord } from "../../src/telegram/store.ts";
import type { TelegramMessage, TelegramUpdate } from "../../src/telegram/telegram/api.ts";

const TOKEN = "110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";

/** A config with the given owner. */
function config(ownerUserId: string, overrides: Partial<TelegramConfig> = {}): TelegramConfig {
	return {
		enabled: true,
		ownerUserId,
		defaultCwd: "/tmp/dsh-telegram-runtime",
		permissionPreset: "workspace-write",
		renderMarkdown: true,
		mediaDelivery: "all",
		...overrides,
	};
}

/** A promise the test can resolve by hand. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve: () => void = () => undefined;
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

/** Everything the runtime touches, with call recording. */
interface Harness {
	readonly runtime: TelegramRuntime;
	/** Bot API methods the runtime called, in order. */
	readonly calls: string[];
	/** Bodies of `getUpdates` calls. */
	readonly bodies: Record<string, unknown>[];
	/** Bodies of `sendMessage` calls. */
	readonly sent: Record<string, unknown>[];
	/** Bodies of `editMessageText` calls. */
	readonly edits: Record<string, unknown>[];
	readonly ensured: string[];
	/** Session ids `/stop` asked to cancel, in order. */
	readonly cancelled: string[];
	/** The label each `ensure` call carried, for the session title. */
	readonly titles: (string | undefined)[];
	readonly turns: string[];
	readonly steered: string[];
	readonly forgotten: string[];
	readonly presets: string[];
	readonly policies: string[];
	readonly logs: string[];
	/** Multipart uploads: the Bot API method, its field names, and the photo size. */
	readonly uploads: { method: string; fields: string[]; bytes: number }[];
	readonly globalState: Record<string, unknown>;
	readonly records: Map<string, ChatRecord>;
	/** How many times the running turn was cancelled; read after acting. */
	cancellations(): number;
}

/**
 * Build a runtime over stubbed collaborators.
 * @param ownerUserId - the configured owner.
 * @param options - a gate that holds turns open, and an answer override.
 * @returns the runtime plus every recording the tests assert on.
 */
function harness(
	ownerUserId: string,
	options: {
		gate?: Promise<void> | undefined;
		answer?: string | undefined;
		/** Turn parts to deliver, when a test needs media or several pieces. */
		parts?: readonly TurnPart[] | undefined;
		/** Settings overrides, e.g. turning media delivery off. */
		configOverrides?: Partial<TelegramConfig> | undefined;
		updates?: TelegramUpdate[] | undefined;
		/** Make session resolution fail, the way a missing `agents` service does. */
		ensureFails?: Error | undefined;
		/** Fail this many `getUpdates` calls before letting the loop recover. */
		pollFailures?: number | undefined;
		/** Answer this many `sendMessage` calls with 429 before letting them through. */
		floods?: number | undefined;
		/** Fail every media upload, to exercise the notice path. */
		mediaFails?: boolean | undefined;
		/** Fail this many `getMe` calls with a transport error before letting startup succeed. */
		getMeFailures?: number | undefined;
	} = {},
): Harness {
	const calls: string[] = [];
	const bodies: Record<string, unknown>[] = [];
	const sent: Record<string, unknown>[] = [];
	const edits: Record<string, unknown>[] = [];
	const ensured: string[] = [];
	const titles: (string | undefined)[] = [];
	const turns: string[] = [];
	const steered: string[] = [];
	const forgotten: string[] = [];
	const presets: string[] = [];
	const policies: string[] = [];
	const logs: string[] = [];
	const uploads: { method: string; fields: string[]; bytes: number }[] = [];
	const globalState: Record<string, unknown> = {};
	const records = new Map<string, ChatRecord>();
	const queued = [...(options.updates ?? [])];
	let cancellations = 0;
	const cancelled: string[] = [];

	let remainingPollFailures = options.pollFailures ?? 0;
	let remainingFloods = options.floods ?? 0;
	let remainingGetMeFailures = options.getMeFailures ?? 0;
	const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
		const method = String(url).split("/").pop() ?? "";
		calls.push(method);
		if (method === "getMe" && remainingGetMeFailures > 0) {
			remainingGetMeFailures -= 1;
			// Shaped like an undici connect timeout, so `api.ts` wraps it as
			// "getMe: transport failure (ETIMEDOUT)" — the exact real-world failure.
			const error = new Error("fetch failed");
			(error as { cause?: unknown }).cause = { code: "ETIMEDOUT" };
			throw error;
		}
		if (method === "sendMessage" && remainingFloods > 0) {
			remainingFloods -= 1;
			return new Response(
				JSON.stringify({ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 1 } }),
				{ status: 429 },
			);
		}
		if (typeof init?.body === "string") {
			const body = JSON.parse(init.body) as Record<string, unknown>;
			if (method === "getUpdates") bodies.push(body);
			if (method === "sendMessage") sent.push(body);
			if (method === "editMessageText") edits.push(body);
		}
		if (method === "getUpdates") {
			if (remainingPollFailures > 0) {
				remainingPollFailures -= 1;
				throw new Error("getUpdates: transport failure");
			}
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		if (typeof init?.body !== "string" && init?.body instanceof FormData) {
			// `keys()` is not in the Node FormData typings this project compiles
			// against; the runtime object has it.
			const form = init.body as unknown as { keys(): Iterable<string> };
			uploads.push({
				method,
				fields: [...form.keys()],
				bytes: init.body.get("photo") instanceof Blob ? (init.body.get("photo") as Blob).size : 0,
			});
			if (options.mediaFails === true) {
				// Recorded first: the test needs to see the attempts that failed.
				return new Response(
					JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: PHOTO_INVALID_DIMENSIONS" }),
					{ status: 400 },
				);
			}
			return new Response(
				JSON.stringify({
					ok: true,
					result:
						method === "sendMediaGroup"
							? [{ message_id: 21, date: 0, chat: { id: 42, type: "private" } }]
							: { message_id: 20, date: 0, chat: { id: 42, type: "private" } },
				}),
				{ status: 200 },
			);
		}
		if (method === "file.bin") {
			// The download URL is /file/bot<token>/<file_path>; its last segment is
			// the path `getFile` reported, which is how this stub recognises it.
			return new Response(new TextEncoder().encode("attachment bytes"), { status: 200 });
		}
		const result =
			method === "getMe"
				? { id: 1, is_bot: true, first_name: "bot", username: "test_bot" }
				: method === "sendMessage"
					? { message_id: 11, date: 0, chat: { id: 42, type: "private" } }
					: method === "getUpdates"
						? queued.splice(0, 1)
						: method === "getFile"
							? { file_id: "f1", file_path: "documents/file.bin" }
							: [];
		return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
	}) as unknown as typeof fetch;

	const store = {
		chats: {
			get: (key: string) => records.get(key),
			put: async (key: string, value: ChatRecord) => {
				records.set(key, value);
			},
			delete: async (key: string) => records.delete(key),
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
		ensure: async (chatId: string, title?: string) => {
			ensured.push(chatId);
			titles.push(title);
			if (options.ensureFails !== undefined) throw options.ensureFails;
			// ResolvedChat: the runtime wraps this with its own routing.
			return {
				sessionId: "session-runtime",
				agent: {
					session: { id: "session-runtime", header: { cwd: "/tmp/dsh-telegram-runtime" } },
					status: "idle",
				},
				created: true,
			};
		},
		runTurn: async (_chat: unknown, text: string) => {
			turns.push(text);
			if (options.gate !== undefined) await options.gate;
			if (options.parts !== undefined) return options.parts;
			return [{ kind: "text", text: options.answer ?? "the answer" }];
		},
		steer: (_chat: unknown, text: string) => {
			steered.push(text);
		},
		cancel: (chat: { sessionId?: string }) => {
			cancellations += 1;
			cancelled.push(String(chat?.sessionId));
		},
		forget: (sessionId: string) => {
			forgotten.push(sessionId);
		},
		setSelection: async () => undefined,
		dispose: () => undefined,
	};
	const runtime = new TelegramRuntime({
		get: (service: string) => {
			if (service === "permissionPresets") {
				return {
					set: (_session: unknown, name: string) => {
						presets.push(name);
					},
				};
			}
			if (service === "sessionController") {
				return {
					modelCatalog: async () => ({
						default: { provider: "p1", model: "m1" },
						routableProviders: ["p1"],
						groups: [{ id: "p1", name: "Provider One", models: [{ id: "m1", name: "Model One" }] }],
						failures: [],
					}),
				};
			}
			if (service === "approval") {
				return {
					setPolicy: (_agent: unknown, policy: string) => {
						policies.push(policy);
					},
				};
			}
			if (service === "attachments") {
				// The digest-verified bytes of a recorded image, without a store.
				return {
					readImage: async (ref: unknown) => ({ ref, data: new Uint8Array([1, 2, 3, 4]) }),
				};
			}
			return undefined;
		},
		store: store as never,
		manager: manager as never,
		approvals: new ApprovalBridge({
			api: () => undefined,
			isOurs: () => false,
			chatFor: () => undefined,
			log: (line) => logs.push(line),
		}),
		menu: new ModelMenu(),
		config: () => config(ownerUserId, options.configOverrides),
		log: (line) => logs.push(line),
		fetch: fetchImpl,
		timing: { mergeMs: 5, chunkMs: 0, typingMs: 5, pollBackoffMs: 5, floodMs: 0, startupBackoffMs: 0 },
	});
	return {
		runtime,
		calls,
		bodies,
		sent,
		edits,
		ensured,
		titles,
		turns,
		steered,
		forgotten,
		presets,
		policies,
		logs,
		uploads,
		globalState,
		records,
		cancelled,
		cancellations: () => cancellations,
	};
}

/** A private-chat message from one user, with an explicit update id. */
function message(fromId: number, text: string, updateId = 1, name?: string): TelegramUpdate {
	const chat = { id: fromId, type: "private", ...(name === undefined ? {} : { first_name: name }) };
	const payload: TelegramMessage = { message_id: updateId, date: 0, chat, from: { ...chat, is_bot: false }, text };
	return { update_id: updateId, message: payload };
}

/** Press one of the bot's inline buttons as the owner. */
async function press(h: ReturnType<typeof harness>, data: string, updateId: number): Promise<void> {
	await h.runtime.handleUpdate({
		update_id: updateId,
		callback_query: {
			id: `cb-${String(updateId)}`,
			from: { id: 42, type: "private", is_bot: false },
			message: { message_id: 5, date: 0, chat: { id: 42, type: "private" } },
			data,
		},
	});
}

after(async () => {
	await rm("/tmp/dsh-telegram-runtime", { recursive: true, force: true });
});

/** Let everything queued (merge window, turn, send) settle. */
async function settle(ms = 60): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

test("startup validates the token, clears any webhook, then publishes commands", async () => {
	const h = harness("42");
	await h.runtime.start(TOKEN);
	assert.deepEqual(h.calls.slice(0, 3), ["getMe", "deleteWebhook", "setMyCommands"]);
	assert.equal(h.runtime.status().state, "running");
	assert.equal(h.runtime.status().botUsername, "test_bot");
	await h.runtime.stop();
});

test("a transient getMe transport failure is retried, and startup still reaches running", async () => {
	// The bot's home has no route to Telegram over IPv6, so the first getMe can
	// time out (ETIMEDOUT) even when the network is fine a moment later. A single
	// blip must not leave the module stuck in Error: getMe is retried.
	const h = harness("42", { getMeFailures: 2 });
	await h.runtime.start(TOKEN);
	assert.equal(h.runtime.status().state, "running", "startup recovers after transient getMe failures");
	assert.equal(h.calls.filter((call) => call === "getMe").length, 3, "getMe was retried twice before succeeding");
	assert.deepEqual(h.calls.filter((call) => call === "deleteWebhook" || call === "setMyCommands"), [
		"deleteWebhook",
		"setMyCommands",
	]);
	await h.runtime.stop();
});

test("a persistently failing getMe still ends in a reported error, not a hang", async () => {
	const h = harness("42", { getMeFailures: 99 });
	await h.runtime.start(TOKEN);
	assert.equal(h.runtime.status().state, "error", "after the retries are exhausted it reports error");
	assert.match(h.runtime.status().detail ?? "", /ETIMEDOUT/);
	await h.runtime.stop();
});

test("a rejected token surfaces as an error status instead of throwing", async () => {
	const failing = (async () =>
		new Response(JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" }), {
			status: 401,
		})) as unknown as typeof fetch;
	const runtime = new TelegramRuntime({
		get: () => undefined,
		store: { chats: { get: () => undefined }, global: { get: () => ({}), set: async () => undefined } } as never,
		manager: { ensure: async () => ({}) } as never,
		approvals: new ApprovalBridge({
			api: () => undefined,
			isOurs: () => false,
			chatFor: () => undefined,
			log: () => undefined,
		}),
		menu: new ModelMenu(),
		config: () => config("42"),
		log: () => undefined,
		fetch: failing,
	});
	await runtime.start(TOKEN);
	assert.equal(runtime.status().state, "error");
	assert.match(runtime.status().detail ?? "", /token/i);

	// Turning the switch off after a failure must not leave the failure on screen:
	// the tab renders `detail` for every state except `running`.
	await runtime.stop();
	assert.equal(runtime.status().state, "off");
	assert.equal(runtime.status().detail, undefined);
});

test("an ordinary message hands the chat's name to ensure, not a placeholder (AC-6)", async () => {
	// A plain text message carries no attachment, so its turn starts after the merge
	// window with no message left to read a name from; the derived name falls back to
	// the `chat` placeholder for exactly that reason. The runtime still hands this
	// name to `manager.ensure`, even though the session's own title is now left to
	// the harness's auto-titling.
	const h = harness("42");
	await h.runtime.start(TOKEN);
	await h.runtime.handleUpdate(message(42, "hello?", 1, "Panda"));
	await settle(30);
	// Stopped before asserting: a failed assertion must not leave the poll loop
	// running, or the test file hangs instead of reporting the failure.
	await h.runtime.stop();

	assert.deepEqual(h.turns, ["hello?"], "the turn still runs");
	assert.deepEqual(h.titles, ["Panda"], "the runtime passes the chat's name to ensure, not a placeholder");
});

test("a session that cannot be resolved explains itself instead of going silent", async () => {
	// The merge timer fires delivery without awaiting it, so anything thrown while
	// resolving the session used to become an unhandled rejection: no reply, no
	// explanation, and — since Node exits on unhandled rejections — a real risk to
	// the whole harness.
	const h = harness("42", { ensureFails: new Error("telegram: the agents service is unavailable") });
	await h.runtime.start(TOKEN);
	await h.runtime.handleUpdate(message(42, "hello?"));
	await settle(30);
	await h.runtime.stop();

	const bodies = h.sent.map((body) => String(body["text"] ?? ""));
	assert.ok(
		bodies.some((text) => text.includes("the agents service is unavailable")),
		`the user must be told why nothing happened; sent: ${JSON.stringify(bodies)}`,
	);
	assert.ok(
		h.logs.some((line) => line.includes("turn never started")),
		"and the failure must reach the log",
	);
});

test("a poller that recovers stops reporting the failure it recovered from", async () => {
	// `storages/telegram.json` is how a human or an agent checks on the bot without
	// asking anyone. It kept saying `error` after the loop had already recovered —
	// which is what a diagnostic must never do.
	const h = harness("42", { pollFailures: 1 });
	await h.runtime.start(TOKEN);
	await settle(60);
	await h.runtime.stop();

	assert.equal(h.runtime.status().state, "off", "stop() is the last word on the live state");
	assert.equal(
		h.globalState["status"],
		"off",
		`the persisted status must not keep describing the recovered failure; got ${JSON.stringify(h.globalState)}`,
	);
	assert.equal(
		h.globalState["statusDetail"],
		"",
		`nor may it keep the recovered failure's text; got ${JSON.stringify(h.globalState)}`,
	);
});

test("a message from a stranger is dropped without a trace (AC-4)", async () => {
	const h = harness("42");
	await h.runtime.start(TOKEN);
	await h.runtime.handleUpdate(message(999, "let me in, secret plans"));
	await settle(30);

	assert.deepEqual(h.ensured, [], "a non-owner must never reach a session");
	assert.ok(
		!h.logs.some((line) => line.includes("secret plans")),
		"the message text must not be logged",
	);
	await h.runtime.stop();
});

test("an unconfigured owner id leaves the bot deaf to everyone", async () => {
	const h = harness("");
	await h.runtime.start(TOKEN);
	await h.runtime.handleUpdate(message(42, "hello?"));
	await settle(30);
	assert.deepEqual(h.ensured, []);
	await h.runtime.stop();
});

test("an owner's message reaches a turn, and the answer comes back", async () => {
	const h = harness("42");
	await h.runtime.start(TOKEN);
	await h.runtime.handleUpdate(message(42, "run the tests"));
	await settle();
	assert.deepEqual(h.ensured, ["42"]);
	assert.deepEqual(h.turns, ["run the tests"]);
	assert.equal(h.sent.length, 1, "exactly one reply per turn");
	assert.equal(h.sent[0]?.["text"], "the answer");
	assert.equal(h.sent[0]?.["parse_mode"], "HTML");
	assert.deepEqual(h.sent[0]?.["link_preview_options"], { is_disabled: true });
	// R13: the session runs under the configured level, asking rather than assuming.
	assert.deepEqual(h.presets, ["workspace-write"]);
	assert.deepEqual(h.policies, ["ask"]);
	await h.runtime.stop();
});

test("the cursor advances past every handled update and survives a restart (R2, AC-3)", async () => {
	const first = harness("42", { updates: [message(42, "first", 5)] });
	await first.runtime.start(TOKEN);
	await settle(80);
	const advanced = first.globalState["updateOffset"];
	const nextPoll = first.bodies[1]?.["offset"];
	await first.runtime.stop();
	assert.equal(advanced, 6, "the cursor must move past the handled update");
	assert.equal(nextPoll, 6, "the very next poll must confirm through it, so it cannot be replayed");

	// A fresh runtime over the same storage resumes from the stored cursor.
	const second = harness("42");
	Object.assign(second.globalState, first.globalState);
	await second.runtime.start(TOKEN);
	await settle(20);
	const resumedOffset = second.bodies[0]?.["offset"];
	await second.runtime.stop();
	assert.equal(resumedOffset, 6, "a restart must not replay what was already handled");
});

test("a message arriving mid-turn steers the running turn instead of starting another (R9, AC-8)", async () => {
	const gate = deferred();
	const h = harness("42", { gate: gate.promise });
	await h.runtime.start(TOKEN);

	await h.runtime.handleUpdate(message(42, "start the long job"));
	await settle(30);
	assert.deepEqual(h.turns, ["start the long job"], "the first message starts the turn");
	assert.ok(h.calls.includes("sendChatAction"), "typing must be shown while the turn runs (R12)");

	await h.runtime.handleUpdate(message(42, "actually, also do this", 2));
	await settle(30);
	assert.deepEqual(h.steered, ["actually, also do this"], "the second message joins the running turn");
	assert.equal(h.turns.length, 1, "no second turn may start");

	gate.resolve();
	await settle(60);
	assert.equal(h.sent.length, 1, "one reply for one turn");
	await h.runtime.stop();
});

test("/stop cancels the running turn and answers in the chat (R18)", async () => {
	const gate = deferred();
	const h = harness("42", { gate: gate.promise });
	await h.runtime.start(TOKEN);
	await h.runtime.handleUpdate(message(42, "go"));
	await settle(30);

	await h.runtime.handleUpdate(message(42, "/stop", 2));
	assert.equal(h.cancellations(), 1);
	assert.ok(
		h.sent.some((body) => String(body["text"]).includes("Stop requested")),
		"the user must be told",
	);
	gate.resolve();
	await settle(60);
	await h.runtime.stop();
});

test("/help reports the directory, the model and the state (R16)", async () => {
	const h = harness("42");
	await h.runtime.start(TOKEN);
	await h.runtime.handleUpdate(message(42, "/help"));
	await settle(20);
	const help = String(h.sent[0]?.["text"] ?? "");
	assert.match(help, /Working directory/);
	assert.match(help, /Model/);
	assert.match(help, /Status/);
	assert.match(help, /running/, "the state must be the live one, not a placeholder");
	await h.runtime.stop();
});

test("/new drops the binding so the next message starts a fresh session (R17)", async () => {
	const h = harness("42");
	h.records.set("42", { sessionId: "session-old", updatedAt: "2026-09-10T00:00:00.000Z" });
	await h.runtime.start(TOKEN);
	await h.runtime.handleUpdate(message(42, "/new"));
	await settle(20);
	assert.deepEqual(h.forgotten, ["session-old"]);
	assert.equal(h.records.has("42"), false, "the binding must be cleared");
	assert.ok(h.sent.some((body) => String(body["text"]).includes("new conversation")));
	await h.runtime.stop();
});

test("/stop cancels the turn that is running, not a session the command invented", async () => {
	// `/stop` used to re-resolve the chat, and with the binding gone — `/new` clears
	// it — that created a brand-new session and cancelled that idle agent while the
	// real turn kept working.
	const h = harness("42", { gate: new Promise<void>(() => undefined) });
	await h.runtime.start(TOKEN);
	h.records.set("42", { sessionId: "session-old", updatedAt: "2026-09-10T00:00:00.000Z" });
	await h.runtime.handleUpdate(message(42, "long job", 1));
	await settle(30);
	await h.runtime.handleUpdate(message(42, "/new", 2));
	await settle(20);
	const resolvedForNew = h.ensured.length;

	await h.runtime.handleUpdate(message(42, "/stop", 3));
	await settle(20);

	assert.deepEqual(h.cancelled, ["session-runtime"], "the running agent must be the one cancelled");
	assert.equal(h.ensured.length, resolvedForNew, "/stop must not resolve — and so create — a session");
	assert.ok(
		h.sent.some((body) => String(body["text"]).includes("Stop requested")),
		`the user must be told; sent: ${JSON.stringify(h.sent)}`,
	);
	await h.runtime.stop();
});

test("picking a model before the chat has a session says so instead of pretending", async () => {
	// A selection is chat-local and lives on the chat's record. With no record the
	// write was a silent no-op while the menu still repainted as `已切到 …`.
	const h = harness("42");
	await h.runtime.start(TOKEN);
	await h.runtime.handleUpdate(message(42, "/model", 1));
	await settle(20);
	await press(h, "md:p:0", 2);
	await settle(20);
	await press(h, "md:m:0:0", 3);
	await settle(20);
	// Stopped before asserting: a failed assertion must not leave the poll loop
	// running, or the file hangs instead of reporting the failure.
	await h.runtime.stop();

	const texts = h.edits.map((body) => String(body["text"]));
	assert.ok(
		texts.some((text) => text.includes("no conversation yet")),
		`the refusal must be explicit; edits: ${JSON.stringify(texts)}`,
	);
	assert.ok(!texts.some((text) => text.includes("Switched to")), "and it must not claim success");
});

test("a button press from a stranger is acknowledged but never acted on", async () => {
	const h = harness("42");
	await h.runtime.start(TOKEN);
	h.calls.length = 0;
	await h.runtime.handleUpdate({
		update_id: 2,
		callback_query: {
			id: "cb-1",
			from: { id: 999, type: "private", is_bot: false },
			message: { message_id: 5, date: 0, chat: { id: 999, type: "private" } },
			data: "md:p:0",
		},
	});
	assert.ok(h.calls.includes("answerCallbackQuery"), "the spinner must be cleared even for a stranger");
	assert.ok(!h.calls.includes("sendMessage"), "a stranger's press must not send anything");
	assert.deepEqual(h.ensured, [], "a stranger's press must not touch a session");
	await h.runtime.stop();
});

test("three fragments of one paste become a single turn (R5, AC-5)", async () => {
	const h = harness("42");
	await h.runtime.start(TOKEN);
	await h.runtime.handleUpdate(message(42, "line one", 1));
	await h.runtime.handleUpdate(message(42, "line two", 2));
	await h.runtime.handleUpdate(message(42, "line three", 3));
	await settle(80);
	assert.equal(h.turns.length, 1, "a split paste must not become three turns");
	assert.equal(h.turns[0], "line one\n\nline two\n\nline three");
	await h.runtime.stop();
});

test("an attachment is fetched, stored, and handed to the agent as a path (R20, AC-12)", async () => {
	const h = harness("42");
	await h.runtime.start(TOKEN);
	const chat = { id: 42, type: "private" };
	await h.runtime.handleUpdate({
		update_id: 9,
		message: {
			message_id: 9,
			date: 0,
			chat,
			from: { ...chat, is_bot: false },
			caption: "看这个",
			document: { file_id: "f1", file_name: "report.pdf", file_size: 12 },
		},
	});
	await settle(120);
	assert.equal(h.turns.length, 1, "the attachment and its caption are one turn");
	const text = h.turns[0] ?? "";
	assert.match(text, /看这个/, "the caption is kept");
	assert.match(
		text,
		/\/tmp\/dsh-telegram-runtime\/downloads\/[^\s]+-report\.pdf/,
		"the agent must receive the absolute path it can open",
	);
	await h.runtime.stop();
});

test("a turn that generated an image sends the text, then the image (R26, AC-18)", async () => {
	const parts: TurnPart[] = [
		{ kind: "text", text: "画好了：" },
		{
			kind: "media",
			via: "tool",
			source: {
				kind: "attachment",
				attachment: { attachmentId: "sha256:aa", mediaType: "image/png", bytes: 4, width: 2, height: 2, name: "chart.png" },
			},
			caption: "chart.png",
		},
		{ kind: "text", text: "还需要改吗？" },
	];
	const h = harness("42", { parts });
	await h.runtime.start(TOKEN);
	await h.runtime.handleUpdate(message(42, "画张图"));
	await settle();

	// Text first, then the upload — the order the agent wrote them in.
	assert.equal(h.calls.includes("sendPhoto"), true);
	assert.equal(h.uploads.length, 1);
	assert.equal(h.uploads[0]?.method, "sendPhoto");
	assert.deepEqual(h.uploads[0]?.fields.includes("photo"), true);
	assert.equal(h.uploads[0]?.bytes, 4);
	const firstUpload = h.calls.indexOf("sendPhoto");
	assert.equal(h.calls.slice(0, firstUpload).includes("sendMessage"), true);
	await h.runtime.stop();
});

test("mediaDelivery off keeps the turn text-only (R30, AC-21)", async () => {
	const parts: TurnPart[] = [
		{ kind: "text", text: "看这里" },
		{
			kind: "media",
			via: "tool",
			source: { kind: "attachment", attachment: { attachmentId: "sha256:bb", mediaType: "image/png", bytes: 4 } },
		},
	];
	const h = harness("42", { parts, configOverrides: { mediaDelivery: "off" } });
	await h.runtime.start(TOKEN);
	await h.runtime.handleUpdate(message(42, "看图"));
	await settle();

	assert.equal(h.calls.includes("sendPhoto"), false);
	assert.equal(h.uploads.length, 0);
	assert.equal(h.sent.length, 1);
	assert.equal(h.sent[0]?.["text"], "看这里");
	await h.runtime.stop();
});

test("a media refusal reaches the phone as one line instead of vanishing (R29)", async () => {
	const parts: TurnPart[] = [
		{ kind: "text", text: "这是报告" },
		{ kind: "media", via: "presented", source: { kind: "path", path: "../../escape.png" } },
	];
	const h = harness("42", { parts });
	await h.runtime.start(TOKEN);
	await h.runtime.handleUpdate(message(42, "发我报告"));
	await settle();

	assert.equal(h.uploads.length, 0);
	const notices = h.sent.map((body) => String(body["text"])).filter((text) => text.includes("Not sent"));
	assert.equal(notices.length, 1);
	assert.match(notices[0] ?? "", /escape\.png/);
	await h.runtime.stop();
});

test("a flood response retries the same message and keeps the rest of the reply (R28, AC-23)", async () => {
	const parts: TurnPart[] = [
		{ kind: "text", text: "第一段" },
		{ kind: "text", text: "第二段" },
	];
	const h = harness("42", { parts, floods: 1 });
	await h.runtime.start(TOKEN);
	await h.runtime.handleUpdate(message(42, "讲两段"));
	await settle();

	// Both messages arrive: the flooded one is retried rather than dropped. Two
	// separate assistant messages go out as two un-numbered messages — the (i/n)
	// counter is only for one message Telegram's length limit forced apart.
	assert.equal(h.sent.length, 2);
	assert.deepEqual(
		h.sent.map((body) => body["text"]),
		["第一段", "第二段"],
	);
	await h.runtime.stop();
});

test("a media upload that fails on the wire says so instead of going quiet (R29, AC-18)", async () => {
	const parts: TurnPart[] = [
		{ kind: "text", text: "图在这里" },
		{
			kind: "media",
			via: "tool",
			source: {
				kind: "attachment",
				attachment: { attachmentId: "sha256:cc", mediaType: "image/png", bytes: 4, width: 2, height: 2, name: "chart.png" },
			},
		},
	];
	const h = harness("42", { parts, mediaFails: true });
	await h.runtime.start(TOKEN);
	await h.runtime.handleUpdate(message(42, "给我图"));
	await settle();

	// The photo, its document fallback, and the notice all belong to one reply: the
	// reader ends up with text plus one line naming what did not arrive.
	assert.equal(h.uploads.length >= 2, true, "the document fallback must be attempted");
	const notices = h.sent.map((body) => String(body["text"])).filter((text) => text.includes("Not sent"));
	assert.equal(notices.length, 1);
	assert.match(notices[0] ?? "", /chart\.png/);
	assert.match(notices[0] ?? "", /PHOTO_INVALID_DIMENSIONS/);
	await h.runtime.stop();
});
