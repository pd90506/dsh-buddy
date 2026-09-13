/**
 * The credential hygiene rule, at the one place it can be enforced: the client.
 *
 * The bot token is a path segment of every request URL, so the failure mode this
 * suite guards against is an error path that hands the URL — and therefore the
 * token — to a log or to the Settings tab.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { TelegramApi, TelegramApiError } from "../../src/telegram/telegram/api.ts";

const TOKEN = "110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";

/** One request the stub saw, in the shape the client actually sent it. */
interface StubCall {
	readonly url: string;
	/** Parsed JSON body, for the calls that send one. */
	readonly body: unknown;
	/** The multipart body, for the calls that upload files instead. */
	readonly form: FormData | undefined;
	/** The `content-type` header the client set, if it set one. */
	readonly contentType: string | undefined;
}

/**
 * Build a fetch stub from a per-call responder, recording every request.
 *
 * `contentType` is exactly what the client passed in `init.headers`: a stub never
 * serializes a body, so an upload that leaves the header unset is visible here as
 * `undefined` — which is the assertion that the boundary stays fetch's business.
 */
function recordingFetch(
	respond: (call: StubCall, index: number) => Response,
): { fetch: typeof fetch; calls: StubCall[] } {
	const calls: StubCall[] = [];
	const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
		const call: StubCall = {
			url: String(url),
			body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
			form: init?.body instanceof FormData ? init.body : undefined,
			contentType: new Headers(init?.headers).get("content-type") ?? undefined,
		};
		calls.push(call);
		return respond(call, calls.length - 1);
	}) as unknown as typeof fetch;
	return { fetch: fetchImpl, calls };
}

/** A fetch stub returning one canned body for every call. */
function stubFetch(body: unknown, status = 200): { fetch: typeof fetch; calls: StubCall[] } {
	return recordingFetch(() => new Response(JSON.stringify(body), { status }));
}

/** A fetch stub answering with one canned envelope per call, in order. */
function stubSequence(steps: readonly unknown[]): { fetch: typeof fetch; calls: StubCall[] } {
	return recordingFetch((_call, index) => {
		const step = steps[index] ?? steps[steps.length - 1];
		return new Response(JSON.stringify(step), { status: 200 });
	});
}

/** The upload stored under one multipart field, when that field carried a file. */
function uploadedFile(form: FormData, name: string): File | undefined {
	const value = form.get(name);
	return value === null || typeof value === "string" ? undefined : value;
}

/** A `sendMessage` result envelope carrying one message id. */
function sentMessage(id: number): unknown {
	return { ok: true, result: { message_id: id, date: 0, chat: { id: 1, type: "private" } } };
}

/** A Telegram error envelope. */
function apiError(errorCode: number, description: string): unknown {
	return { ok: false, error_code: errorCode, description };
}

test("getMe unwraps the ok envelope", async () => {
	const { fetch } = stubFetch({ ok: true, result: { id: 1, is_bot: true, first_name: "bot", username: "my_bot" } });
	const api = new TelegramApi({ token: TOKEN, fetch });
	const me = await api.getMe();
	assert.equal(me.username, "my_bot");
});

test("an API error carries the method and description, never the token", async () => {
	const { fetch } = stubFetch({ ok: false, error_code: 400, description: "Bad Request: chat not found" });
	const api = new TelegramApi({ token: TOKEN, fetch });
	await assert.rejects(
		() => api.sendMessage({ chatId: 1, text: "hi" }),
		(error: unknown) => {
			assert.ok(error instanceof TelegramApiError);
			assert.equal(error.code, 400);
			assert.match(error.message, /sendMessage/);
			assert.match(error.message, /chat not found/);
			assert.ok(!error.message.includes(TOKEN), "the token must not appear in an error message");
			return true;
		},
	);
});

test("flood responses expose retry_after so the caller can honour it", async () => {
	const { fetch } = stubFetch(
		{ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 7 } },
		429,
	);
	const api = new TelegramApi({ token: TOKEN, fetch });
	await assert.rejects(
		() => api.getMe(),
		(error: unknown) => {
			assert.ok(error instanceof TelegramApiError);
			assert.equal(error.isFlood, true);
			assert.equal(error.retryAfter, 7);
			return true;
		},
	);
});

test("a revoked token is reported as unauthorized", async () => {
	const { fetch } = stubFetch({ ok: false, error_code: 401, description: "Unauthorized" }, 401);
	const api = new TelegramApi({ token: TOKEN, fetch });
	await assert.rejects(
		() => api.getMe(),
		(error: unknown) => {
			assert.ok(error instanceof TelegramApiError);
			assert.equal(error.isUnauthorized, true);
			return true;
		},
	);
});

test("a transport failure is summarized without the request URL", async () => {
	const failing = (async () => {
		throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
	}) as unknown as typeof fetch;
	const api = new TelegramApi({ token: TOKEN, fetch: failing });
	await assert.rejects(
		() => api.getMe(),
		(error: unknown) => {
			assert.ok(error instanceof TelegramApiError);
			assert.match(error.message, /getMe/);
			assert.match(error.message, /ECONNREFUSED/);
			assert.ok(!error.message.includes(TOKEN));
			assert.ok(!error.message.includes("api.telegram.org"));
			return true;
		},
	);
});

test("getUpdates states allowed_updates and the cursor explicitly", async () => {
	const { fetch, calls } = stubFetch({ ok: true, result: [] });
	const api = new TelegramApi({ token: TOKEN, fetch });
	const result = await api.getUpdates({ offset: 42 });
	assert.equal(result.timedOut, true);
	const body = calls[0]?.body as Record<string, unknown>;
	assert.deepEqual(body["allowed_updates"], ["message", "callback_query"]);
	assert.equal(body["offset"], 42);
	assert.equal(body["timeout"], 30);
});

test("sendMessage disables link previews and threads into a topic", async () => {
	const { fetch, calls } = stubFetch({ ok: true, result: { message_id: 5, date: 0, chat: { id: 1, type: "private" } } });
	const api = new TelegramApi({ token: TOKEN, fetch });
	const messageId = await api.sendMessage({ chatId: 1, text: "hi", threadId: 9 });
	assert.equal(messageId, 5);
	const body = calls[0]?.body as Record<string, unknown>;
	assert.equal(body["parse_mode"], "HTML");
	assert.deepEqual(body["link_preview_options"], { is_disabled: true });
	assert.equal(body["message_thread_id"], 9);
});

test("a no-op edit is treated as success", async () => {
	const { fetch } = stubFetch({
		ok: false,
		error_code: 400,
		description: "Bad Request: message is not modified: specified new message content and reply markup are exactly the same",
	});
	const api = new TelegramApi({ token: TOKEN, fetch });
	await api.editMessageText({ chatId: 1, messageId: 2, text: "unchanged" });
});

test("sendPhoto uploads bytes as multipart without forcing a content type", async () => {
	const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
	const { fetch, calls } = stubFetch(sentMessage(31));
	const api = new TelegramApi({ token: TOKEN, fetch });

	const messageId = await api.sendPhoto({
		chatId: 42,
		photo: { bytes, name: "chart.png", mediaType: "image/png" },
		threadId: 7,
	});

	assert.equal(messageId, 31);
	const call = calls[0];
	assert.equal(call?.body, undefined, "bytes must not travel as JSON");
	assert.equal(call?.contentType, undefined, "fetch owns the multipart boundary");
	const form = call?.form;
	assert.ok(form instanceof FormData, "the body must be a FormData");
	assert.equal(form.get("chat_id"), "42");
	assert.equal(form.get("message_thread_id"), "7");
	const photo = uploadedFile(form, "photo");
	assert.equal(photo?.name, "chart.png");
	assert.equal(photo?.size, bytes.byteLength);
	assert.deepEqual([...new Uint8Array(await (photo as File).arrayBuffer())], [...bytes]);
});

test("sendPhoto sends a caption with HTML parsing only when there is one", async () => {
	const withCaption = stubFetch(sentMessage(32));
	await new TelegramApi({ token: TOKEN, fetch: withCaption.fetch }).sendPhoto({
		chatId: 1,
		photo: { bytes: new Uint8Array([1]), name: "a.png", mediaType: "image/png" },
		caption: "一条<b>图注</b>",
	});
	const captioned = withCaption.calls[0]?.form;
	assert.equal(captioned?.get("caption"), "一条<b>图注</b>");
	assert.equal(captioned?.get("parse_mode"), "HTML");

	const bare = stubFetch(sentMessage(33));
	await new TelegramApi({ token: TOKEN, fetch: bare.fetch }).sendPhoto({
		chatId: 1,
		photo: { bytes: new Uint8Array([1]), name: "a.png", mediaType: "image/png" },
	});
	const uncaptioned = bare.calls[0]?.form;
	assert.equal(uncaptioned?.get("caption"), null, "an absent caption must not be sent as an empty string");
	assert.equal(uncaptioned?.get("parse_mode"), null);
});

test("sendPhoto passes a URL through as JSON for Telegram to fetch", async () => {
	const { fetch, calls } = stubFetch(sentMessage(34));
	const api = new TelegramApi({ token: TOKEN, fetch });
	const messageId = await api.sendPhoto({
		chatId: 42,
		photo: { url: "https://example.com/chart.png" },
		caption: "<b>图</b>",
	});

	assert.equal(messageId, 34);
	const call = calls[0];
	assert.equal(call?.form, undefined);
	assert.equal(call?.contentType, "application/json");
	const body = call?.body as Record<string, unknown>;
	assert.equal(body["photo"], "https://example.com/chart.png");
	assert.equal(body["caption"], "<b>图</b>");
	assert.equal(body["parse_mode"], "HTML");
});

test("sendDocument uploads any file under the document field", async () => {
	const bytes = new Uint8Array([37, 80, 68, 70]);
	const { fetch, calls } = stubFetch(sentMessage(35));
	const api = new TelegramApi({ token: TOKEN, fetch });
	const messageId = await api.sendDocument({
		chatId: 42,
		document: { bytes, name: "report.pdf" },
		caption: "报告",
	});

	assert.equal(messageId, 35);
	const form = calls[0]?.form;
	assert.ok(form instanceof FormData);
	assert.equal(form.get("chat_id"), "42");
	assert.equal(form.get("caption"), "报告");
	assert.equal(form.get("parse_mode"), "HTML");
	const document = uploadedFile(form, "document");
	assert.equal(document?.name, "report.pdf");
	assert.equal(document?.size, bytes.byteLength);
});

test("sendMediaGroup posts one album with attach:// references and the caption on the first item", async () => {
	const first = new Uint8Array([1, 2, 3]);
	const second = new Uint8Array([4, 5]);
	const { fetch, calls } = stubFetch({
		ok: true,
		result: [
			{ message_id: 41, date: 0, chat: { id: 1, type: "private" } },
			{ message_id: 42, date: 0, chat: { id: 1, type: "private" } },
		],
	});
	const api = new TelegramApi({ token: TOKEN, fetch });

	const ids = await api.sendMediaGroup({
		chatId: 42,
		items: [
			{ bytes: first, name: "a.png", mediaType: "image/png" },
			{ bytes: second, name: "b.png", mediaType: "image/png" },
		],
		caption: "两张图",
	});

	assert.deepEqual(ids, [41, 42]);
	const form = calls[0]?.form;
	assert.ok(form instanceof FormData, "an album is one multipart request");
	assert.deepEqual(JSON.parse(String(form.get("media"))), [
		{ type: "photo", media: "attach://p0", caption: "两张图", parse_mode: "HTML" },
		{ type: "photo", media: "attach://p1" },
	]);
	assert.equal(uploadedFile(form, "p0")?.name, "a.png");
	assert.equal(uploadedFile(form, "p1")?.name, "b.png");
	assert.equal(uploadedFile(form, "p0")?.size, first.byteLength);
	assert.equal(uploadedFile(form, "p1")?.size, second.byteLength);
});

test("sendMediaGroup refuses an item count Telegram would reject", async () => {
	const { fetch, calls } = stubFetch({ ok: true, result: [] });
	const api = new TelegramApi({ token: TOKEN, fetch });
	const item = { bytes: new Uint8Array([1]), name: "a.png", mediaType: "image/png" };

	await assert.rejects(
		() => api.sendMediaGroup({ chatId: 1, items: [item] }),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.ok(!(error instanceof TelegramApiError), "a local constraint is not an API failure");
			assert.match(error.message, /2-10/);
			return true;
		},
	);
	await assert.rejects(
		() => api.sendMediaGroup({ chatId: 1, items: Array.from({ length: 11 }, () => item) }),
		(error: unknown) => {
			assert.match((error as Error).message, /2-10/);
			return true;
		},
	);
	assert.equal(calls.length, 0, "an out-of-range album must never reach the API");
});

test("a multipart failure surfaces the method and description, never the token", async () => {
	const { fetch } = stubFetch(apiError(400, "Bad Request: PHOTO_INVALID_DIMENSIONS"));
	const api = new TelegramApi({ token: TOKEN, fetch });
	await assert.rejects(
		() => api.sendPhoto({ chatId: 1, photo: { bytes: new Uint8Array([1]), name: "a.png", mediaType: "image/png" } }),
		(error: unknown) => {
			assert.ok(error instanceof TelegramApiError);
			assert.match(error.message, /sendPhoto/);
			assert.match(error.message, /PHOTO_INVALID_DIMENSIONS/);
			assert.ok(!error.message.includes(TOKEN), "the token must not appear in an error message");
			assert.ok(!error.message.includes("api.telegram.org"));
			return true;
		},
	);
});

test("sendMessage resends the escaped fallback once when entities cannot be parsed", async () => {
	const { fetch, calls } = stubSequence([
		apiError(400, "Bad Request: can't parse entities: Unsupported start tag \"b\" at byte offset 0"),
		sentMessage(51),
	]);
	const api = new TelegramApi({ token: TOKEN, fetch });

	const messageId = await api.sendMessage({
		chatId: 7,
		text: "<b>broken",
		plain: "&lt;b&gt;broken",
		threadId: 3,
		keyboard: [[{ text: "ok", callback_data: "c" }]],
	});

	assert.equal(messageId, 51);
	assert.equal(calls.length, 2);
	const retry = calls[1]?.body as Record<string, unknown>;
	assert.equal(retry["text"], "&lt;b&gt;broken");
	assert.equal(retry["parse_mode"], "HTML");
	assert.equal(retry["message_thread_id"], 3, "the retry must land in the same topic");
	assert.deepEqual(retry["reply_markup"], { inline_keyboard: [[{ text: "ok", callback_data: "c" }]] });
});

test("a failing fallback propagates instead of looping", async () => {
	const { fetch, calls } = stubFetch(apiError(400, "Bad Request: can't parse entities: unexpected end"));
	const api = new TelegramApi({ token: TOKEN, fetch });
	await assert.rejects(
		() => api.sendMessage({ chatId: 1, text: "<b>", plain: "&lt;b&gt;" }),
		(error: unknown) => {
			assert.ok(error instanceof TelegramApiError);
			return true;
		},
	);
	assert.equal(calls.length, 2, "the fallback is attempted exactly once");
});

test("sendMessage splits an over-long fallback into 2000-unit pieces and returns the first id", async () => {
	const { fetch, calls } = stubSequence([
		apiError(400, "Bad Request: message is too long"),
		sentMessage(61),
		sentMessage(62),
	]);
	const api = new TelegramApi({ token: TOKEN, fetch });
	const plain = "x".repeat(4000);

	const messageId = await api.sendMessage({ chatId: 1, text: "<b>long</b>", plain });

	assert.equal(messageId, 61);
	assert.equal(calls.length, 3);
	const pieces = calls.slice(1).map((call) => String((call.body as Record<string, unknown>)["text"]));
	assert.deepEqual(
		pieces.map((piece) => piece.length),
		[2000, 2000],
	);
	assert.equal(pieces.join(""), plain, "no character may be lost at the cut");
});

test("sendMessage leaves every other failure alone", async () => {
	const { fetch, calls } = stubFetch(apiError(400, "Bad Request: chat not found"));
	const api = new TelegramApi({ token: TOKEN, fetch });
	await assert.rejects(
		() => api.sendMessage({ chatId: 1, text: "hi", plain: "hi" }),
		(error: unknown) => {
			assert.ok(error instanceof TelegramApiError);
			assert.match(error.message, /chat not found/);
			return true;
		},
	);
	assert.equal(calls.length, 1, "an unrelated failure must not trigger the fallback");

	const bare = stubFetch(apiError(400, "Bad Request: can't parse entities: nope"));
	await assert.rejects(
		() => new TelegramApi({ token: TOKEN, fetch: bare.fetch }).sendMessage({ chatId: 1, text: "<b>" }),
		(error: unknown) => {
			assert.ok(error instanceof TelegramApiError);
			return true;
		},
	);
	assert.equal(bare.calls.length, 1, "without a fallback there is nothing to resend");
});
