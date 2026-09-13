/**
 * The approval bridge: the one path where a phone tap authorises a tool call.
 *
 * Three behaviours are safety properties, not niceties, and each has a test:
 * an unanswered prompt must fail **closed**; a press that lands after the wait
 * expired must not repaint the message as approved; and the callback must be
 * acknowledged immediately so the client's spinner clears regardless of what the
 * agent is doing.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ApprovalBridge, DEFAULT_APPROVAL_TIMEOUT_MS } from "../../src/telegram/approvals.ts";
import type { TelegramApi } from "../../src/telegram/telegram/api.ts";

/** A transport stub recording what the bridge sends. */
function apiStub(): {
	api: TelegramApi;
	sends: { text: string; keyboard?: unknown }[];
	edits: { messageId: number; text: string; keyboard?: unknown }[];
	answers: string[];
} {
	const sends: { text: string; keyboard?: unknown }[] = [];
	const edits: { messageId: number; text: string; keyboard?: unknown }[] = [];
	const answers: string[] = [];
	const api = {
		sendMessage: async (options: { text: string; keyboard?: unknown }) => {
			sends.push(options);
			return 42;
		},
		editMessageText: async (options: { messageId: number; text: string; keyboard?: unknown }) => {
			edits.push(options);
		},
		answerCallbackQuery: async (id: string) => {
			answers.push(id);
		},
	} as unknown as TelegramApi;
	return { api, sends, edits, answers };
}

/** Let the prompt be delivered before the test drives a press. */
async function tick(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

/** The opaque token carried by the prompt's first button. */
function tokenOf(send: { keyboard?: unknown }): string {
	const rows = send.keyboard as { callback_data: string }[][];
	return (rows[0]?.[0]?.callback_data ?? "").split(":")[2] ?? "";
}

test("the documented default timeout is five minutes", () => {
	assert.equal(DEFAULT_APPROVAL_TIMEOUT_MS, 300_000);
});

test("a request from a session this plugin does not own falls through to the next answerer", async () => {
	const { api } = apiStub();
	const bridge = new ApprovalBridge({
		api: () => api,
		isOurs: () => false,
		chatFor: () => ({ chatId: 1 }),
		log: () => undefined,
	});
	const outcome = await bridge.handler({ agent: { session: { id: "session-other" } }, toolName: "bash" }, async () => "unavailable");
	assert.equal(outcome, "unavailable");
});

test("tapping allow resolves allowed-once and repaints the prompt", async () => {
	const { api, sends, edits, answers } = apiStub();
	const bridge = new ApprovalBridge({
		api: () => api,
		isOurs: () => true,
		chatFor: () => ({ chatId: 7 }),
		log: () => undefined,
	});
	const pending = bridge.handler({ agent: { session: { id: "session-1" } }, toolName: "bash", reason: "writes files" }, async () => "unavailable");
	await tick();
	assert.equal(sends.length, 1);
	assert.match(sends[0]?.text ?? "", /bash/);
	// The body is composed as Telegram HTML and has to reach the wire as markup.
	// Running it through the agent-text renderer escaped it a second time, so the
	// phone showed the literal text `<b>需要你的许可</b>`.
	assert.match(sends[0]?.text ?? "", /<b>需要你的许可<\/b>/);
	assert.match(sends[0]?.text ?? "", /<code>bash<\/code>/);
	assert.ok(!(sends[0]?.text ?? "").includes("&lt;b&gt;"), "the prompt's own markup must not be escaped");

	const token = tokenOf(sends[0] ?? {});

	await bridge.handleCallback(`ap:y:${token}`, "cb-1");
	assert.equal(await pending, "allowed-once");
	assert.deepEqual(answers, ["cb-1"], "the callback must be acknowledged immediately");
	assert.equal(edits.length, 1);
	assert.match(edits[0]?.text ?? "", /已允许/);
});

test("tapping deny resolves rejected", async () => {
	const { api, sends, edits } = apiStub();
	const bridge = new ApprovalBridge({ api: () => api, isOurs: () => true, chatFor: () => ({ chatId: 7 }), log: () => undefined });
	const pending = bridge.handler({ agent: { session: { id: "session-1" } }, toolName: "bash" }, async () => "unavailable");
	await tick();
	await bridge.handleCallback(`ap:n:${tokenOf(sends[0] ?? {})}`, "cb-2");
	assert.equal(await pending, "rejected");
	assert.match(edits[0]?.text ?? "", /已拒绝/);
});

test("an unanswered prompt fails closed at the timeout", async () => {
	const { api, edits } = apiStub();
	const bridge = new ApprovalBridge({
		api: () => api,
		isOurs: () => true,
		chatFor: () => ({ chatId: 7 }),
		log: () => undefined,
		timeoutMs: 20,
	});
	const outcome = await bridge.handler({ agent: { session: { id: "session-1" } }, toolName: "bash" }, async () => "unavailable");
	assert.equal(outcome, "rejected", "no answer must never mean approval");
	assert.match(edits[0]?.text ?? "", /过期/);
});

test("a press arriving after the timeout cannot claim approval", async () => {
	const { api, sends, edits } = apiStub();
	const bridge = new ApprovalBridge({
		api: () => api,
		isOurs: () => true,
		chatFor: () => ({ chatId: 7 }),
		log: () => undefined,
		timeoutMs: 20,
	});
	const outcome = await bridge.handler({ agent: { session: { id: "session-1" } }, toolName: "bash" }, async () => "unavailable");
	assert.equal(outcome, "rejected");
	const editsAfterTimeout = edits.length;

	await bridge.handleCallback(`ap:y:${tokenOf(sends[0] ?? {})}`, "cb-late");
	assert.equal(edits.length, editsAfterTimeout, "a late press must not repaint the prompt as approved");
});

test("a prompt that cannot be delivered resolves as rejected rather than hanging", async () => {
	const failing = {
		sendMessage: async () => {
			throw new Error("chat not found");
		},
		editMessageText: async () => undefined,
		answerCallbackQuery: async () => undefined,
	} as unknown as TelegramApi;
	const bridge = new ApprovalBridge({
		api: () => failing,
		isOurs: () => true,
		chatFor: () => ({ chatId: 7 }),
		log: () => undefined,
		timeoutMs: 5000,
	});
	const outcome = await bridge.handler({ agent: { session: { id: "session-1" } }, toolName: "bash" }, async () => "unavailable");
	assert.equal(outcome, "rejected");
});

test("shutdown refuses every pending prompt", async () => {
	const { api } = apiStub();
	const bridge = new ApprovalBridge({ api: () => api, isOurs: () => true, chatFor: () => ({ chatId: 7 }), log: () => undefined });
	const pending = bridge.handler({ agent: { session: { id: "session-1" } }, toolName: "bash" }, async () => "unavailable");
	await tick();
	bridge.dispose();
	assert.equal(await pending, "rejected");
});

test("callback data from another feature is not claimed", async () => {
	const { api } = apiStub();
	const bridge = new ApprovalBridge({ api: () => api, isOurs: () => true, chatFor: () => ({ chatId: 7 }), log: () => undefined });
	assert.equal(await bridge.handleCallback("md:p:0", "cb-3"), false);
	assert.equal(await bridge.handleCallback("nonsense", "cb-4"), false);
});

test("the prompt's markup survives, and an untrusted tool name still cannot inject any", async () => {
	// Two rules that pull in opposite directions, so both are asserted together:
	// the prompt's own tags must reach Telegram as markup, and the tool name — which
	// comes from the model — must not.
	const { api, sends } = apiStub();
	const bridge = new ApprovalBridge({
		api: () => api,
		isOurs: () => true,
		chatFor: () => ({ chatId: 7 }),
		log: () => undefined,
	});
	const pending = bridge.handler(
		{ agent: { session: { id: "session-1" } }, toolName: "<script>alert(1)</script>", reason: "a & b" },
		async () => "unavailable",
	);
	await tick();

	const text = sends[0]?.text ?? "";
	assert.match(text, /<b>需要你的许可<\/b>/, "the prompt's own markup must reach the wire");
	assert.match(text, /<code>&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/code>/, "the tool name must be escaped inside it");
	assert.match(text, /原因：a &amp; b/, "so must the reason");
	assert.ok(!text.includes("<script>"), "an untrusted tool name must not become markup");

	await bridge.handleCallback(`ap:n:${tokenOf(sends[0] ?? {})}`, "cb-hostile");
	assert.equal(await pending, "rejected");
});
