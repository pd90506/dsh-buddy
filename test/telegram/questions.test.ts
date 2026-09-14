/**
 * The question bridge: the path where a phone answers `ask_user_question` and
 * the plan-review that `exit_plan_mode` raises — both ride the same
 * `user-questions/request` seam that, unanswered, freezes a Telegram turn.
 *
 * The safety properties mirror the approval bridge, but the outcome is
 * different: a question has no safe default answer, so an unanswered one fails
 * **loud** (the pending promise rejects and the turn surfaces the error) rather
 * than failing closed. A press or a typed reply must reach the waterfall; a
 * request for a session this plugin does not own must fall through untouched.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { QuestionBridge, DEFAULT_QUESTION_TIMEOUT_MS } from "../../src/telegram/questions.ts";
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
	let nextMessageId = 100;
	const api = {
		sendMessage: async (options: { text: string; keyboard?: unknown }) => {
			sends.push(options);
			return nextMessageId++;
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

/** Let a prompt be delivered before the test drives an answer. */
async function tick(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

/** The opaque token carried by a prompt's first button. */
function tokenOf(send: { keyboard?: unknown }): string {
	const rows = send.keyboard as { callback_data: string }[][];
	for (const row of rows) for (const button of row) return button.callback_data.split(":")[1] ?? "";
	return "";
}

/** A bridge that owns every session, for the common case. */
function ownedBridge(api: TelegramApi, timeoutMs?: number): QuestionBridge {
	return new QuestionBridge({
		api: () => api,
		isOurs: () => true,
		chatFor: () => ({ chatId: 7 }),
		log: () => undefined,
		...(timeoutMs === undefined ? {} : { timeoutMs }),
	});
}

test("the documented default timeout is fifteen minutes", () => {
	assert.equal(DEFAULT_QUESTION_TIMEOUT_MS, 900_000);
});

test("a request from a session this plugin does not own falls through to the next answerer", async () => {
	const { api } = apiStub();
	const bridge = new QuestionBridge({
		api: () => api,
		isOurs: () => false,
		chatFor: () => ({ chatId: 1 }),
		log: () => undefined,
	});
	const sentinel = { answers: [{ id: "q1", selected: ["from-browser"] }] };
	const outcome = await bridge.handler(
		{ questions: [{ id: "q1", question: "pick" }], agent: { session: { id: "other" } } },
		async () => sentinel,
	);
	assert.equal(outcome, sentinel);
});

test("a single-select question renders one button per option and resolves with the chosen label", async () => {
	const { api, sends } = apiStub();
	const bridge = ownedBridge(api);
	const pending = bridge.handler(
		{
			questions: [{ id: "q1", question: "Which mode?", options: [{ label: "Fast" }, { label: "Careful" }] }],
			agent: { session: { id: "s1" } },
		},
		async () => ({ answers: [] }),
	);
	await tick();
	assert.equal(sends.length, 1);
	const rows = sends[0]?.keyboard as { text: string }[][];
	const labels = rows.flat().map((b) => b.text);
	assert.deepEqual(labels, ["Fast", "Careful"]);

	await bridge.handleCallback(`qn:${tokenOf(sends[0] ?? {})}:o:1`, "cb-1");
	assert.deepEqual(await pending, { answers: [{ id: "q1", selected: ["Careful"] }] });
});

test("a press is acknowledged immediately so the client spinner clears", async () => {
	const { api, sends, answers } = apiStub();
	const bridge = ownedBridge(api);
	const pending = bridge.handler(
		{ questions: [{ id: "q1", question: "?", options: [{ label: "Yes" }] }], agent: { session: { id: "s1" } } },
		async () => ({ answers: [] }),
	);
	await tick();
	await bridge.handleCallback(`qn:${tokenOf(sends[0] ?? {})}:o:0`, "cb-ack");
	assert.deepEqual(answers, ["cb-ack"]);
	await pending;
});

test("a multi-select question toggles options and confirms with every chosen label", async () => {
	const { api, sends } = apiStub();
	const bridge = ownedBridge(api);
	const pending = bridge.handler(
		{
			questions: [
				{ id: "q1", question: "Pick many", multiSelect: true, options: [{ label: "A" }, { label: "B" }, { label: "C" }] },
			],
			agent: { session: { id: "s1" } },
		},
		async () => ({ answers: [] }),
	);
	await tick();
	const token = tokenOf(sends[0] ?? {});
	await bridge.handleCallback(`qn:${token}:t:0`, "cb-a");
	await bridge.handleCallback(`qn:${token}:t:2`, "cb-c");
	await bridge.handleCallback(`qn:${token}:c`, "cb-done");
	assert.deepEqual(await pending, { answers: [{ id: "q1", selected: ["A", "C"] }] });
});

test("a typed reply answers a no-option question as custom text", async () => {
	const { api } = apiStub();
	const bridge = ownedBridge(api);
	const pending = bridge.handler(
		{ questions: [{ id: "q1", question: "What is the base URL?" }], agent: { session: { id: "s1" } } },
		async () => ({ answers: [] }),
	);
	await tick();
	assert.equal(bridge.handleText(7, "https://example.test"), true);
	assert.deepEqual(await pending, { answers: [{ id: "q1", selected: [], custom: "https://example.test" }] });
});

test("a typed reply overrides an option question as custom text", async () => {
	// The escape hatch: typing instead of tapping is a custom answer. For a plan
	// review this is exactly "keep planning, and here is my feedback".
	const { api } = apiStub();
	const bridge = ownedBridge(api);
	const pending = bridge.handler(
		{
			questions: [{ id: "plan-review", question: "Approve?", options: [{ label: "Approve" }, { label: "Keep planning" }] }],
			agent: { session: { id: "s1" } },
		},
		async () => ({ answers: [] }),
	);
	await tick();
	assert.equal(bridge.handleText(7, "narrow the scope first"), true);
	assert.deepEqual(await pending, { answers: [{ id: "plan-review", selected: [], custom: "narrow the scope first" }] });
});

test("a text reply for a chat with no pending question is not consumed", () => {
	const { api } = apiStub();
	const bridge = ownedBridge(api);
	assert.equal(bridge.handleText(7, "just chatting"), false);
});

test("multiple questions are asked in sequence and every answer is returned", async () => {
	const { api, sends } = apiStub();
	const bridge = ownedBridge(api);
	const pending = bridge.handler(
		{
			questions: [
				{ id: "q1", question: "First?", options: [{ label: "One" }] },
				{ id: "q2", question: "Second?", options: [{ label: "Two" }] },
			],
			agent: { session: { id: "s1" } },
		},
		async () => ({ answers: [] }),
	);
	await tick();
	assert.equal(sends.length, 1, "only the first question is shown until it is answered");
	await bridge.handleCallback(`qn:${tokenOf(sends[0] ?? {})}:o:0`, "cb-1");
	await tick();
	assert.equal(sends.length, 2, "answering the first reveals the second");
	await bridge.handleCallback(`qn:${tokenOf(sends[1] ?? {})}:o:0`, "cb-2");
	assert.deepEqual(await pending, {
		answers: [
			{ id: "q1", selected: ["One"] },
			{ id: "q2", selected: ["Two"] },
		],
	});
});

test("an unanswered question fails loud at the timeout", async () => {
	const { api } = apiStub();
	const bridge = ownedBridge(api, 20);
	await assert.rejects(
		bridge.handler({ questions: [{ id: "q1", question: "?" }], agent: { session: { id: "s1" } } }, async () => ({ answers: [] })),
		/timed out/i,
	);
});

test("an aborted signal rejects the pending question", async () => {
	const { api } = apiStub();
	const bridge = ownedBridge(api);
	const controller = new AbortController();
	const pending = bridge.handler(
		{ questions: [{ id: "q1", question: "?" }], agent: { session: { id: "s1" } }, signal: controller.signal },
		async () => ({ answers: [] }),
	);
	await tick();
	controller.abort();
	await assert.rejects(pending);
});

test("a prompt that cannot be delivered rejects rather than hanging", async () => {
	const failing = {
		sendMessage: async () => {
			throw new Error("chat not found");
		},
		editMessageText: async () => undefined,
		answerCallbackQuery: async () => undefined,
	} as unknown as TelegramApi;
	const bridge = ownedBridge(failing, 5000);
	await assert.rejects(
		bridge.handler({ questions: [{ id: "q1", question: "?" }], agent: { session: { id: "s1" } } }, async () => ({ answers: [] })),
	);
});

test("shutdown rejects every pending question", async () => {
	const { api } = apiStub();
	const bridge = ownedBridge(api);
	const pending = bridge.handler(
		{ questions: [{ id: "q1", question: "?" }], agent: { session: { id: "s1" } } },
		async () => ({ answers: [] }),
	);
	await tick();
	bridge.dispose();
	await assert.rejects(pending);
});

test("callback data from another feature is not claimed", async () => {
	const { api } = apiStub();
	const bridge = ownedBridge(api);
	assert.equal(await bridge.handleCallback("ap:y:token", "cb-a"), false);
	assert.equal(await bridge.handleCallback("md:p:0", "cb-b"), false);
	assert.equal(await bridge.handleCallback("nonsense", "cb-c"), false);
});

test("a question with detail sends the detail as its own splittable message before the keyboard prompt", async () => {
	// A plan review carries the whole plan as `detail`, which routinely exceeds
	// Telegram's per-message ceiling. It goes out as its own message — carrying a
	// plain fallback so an over-length body is re-split rather than refused — and
	// the keyboard rides a short prompt that never repeats the plan.
	const { api, sends } = apiStub();
	const bridge = ownedBridge(api);
	const pending = bridge.handler(
		{
			questions: [
				{
					id: "plan-review",
					header: "Plan review",
					question: "Approve this plan?",
					detail: "# Plan\n\nStep one, then step two.",
					options: [{ label: "Approve" }, { label: "Keep planning" }],
				},
			],
			agent: { session: { id: "s1" } },
		},
		async () => ({ answers: [] }),
	);
	await tick();
	assert.equal(sends.length, 2, "the detail and the prompt are separate messages");
	const detail = sends[0] as { text: string; keyboard?: unknown; plain?: string };
	assert.match(detail.text, /Step one, then step two/);
	assert.equal(detail.keyboard, undefined, "the detail message carries no keyboard");
	assert.ok((detail.plain ?? "") !== "", "the detail message carries a plain fallback so it can be re-split when too long");
	const prompt = sends[1] as { text: string; keyboard?: unknown };
	assert.ok(prompt.keyboard !== undefined, "the keyboard rides the prompt message");
	assert.ok(!prompt.text.includes("Step one"), "the prompt must not repeat the plan detail");

	await bridge.handleCallback(`qn:${tokenOf(sends[1] ?? {})}:o:0`, "cb-1");
	assert.deepEqual(await pending, { answers: [{ id: "plan-review", selected: ["Approve"] }] });
});

test("a question without detail sends only the prompt", async () => {
	const { api, sends } = apiStub();
	const bridge = ownedBridge(api);
	bridge.handler(
		{ questions: [{ id: "q1", question: "Pick", options: [{ label: "A" }] }], agent: { session: { id: "s1" } } },
		async () => ({ answers: [] }),
	);
	await tick();
	assert.equal(sends.length, 1);
});

test("the question's own layout survives while untrusted model text is escaped", async () => {
	const { api, sends } = apiStub();
	const bridge = ownedBridge(api);
	const pending = bridge.handler(
		{
			questions: [
				{
					id: "q1",
					header: "Choose",
					question: "Run <script>alert(1)</script>?",
					options: [{ label: "a & b" }],
				},
			],
			agent: { session: { id: "s1" } },
		},
		async () => ({ answers: [] }),
	);
	await tick();
	const text = sends[0]?.text ?? "";
	assert.match(text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, "the model's question text must be escaped");
	assert.ok(!text.includes("<script>"), "untrusted question text must not become markup");
	// The button label is carried by Telegram as plain text, never markup, so it
	// is not HTML-escaped — it is answered verbatim.
	await bridge.handleCallback(`qn:${tokenOf(sends[0] ?? {})}:o:0`, "cb-x");
	assert.deepEqual(await pending, { answers: [{ id: "q1", selected: ["a & b"] }] });
});
