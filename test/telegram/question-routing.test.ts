/**
 * Wiring: the runtime must hand incoming presses and typed replies to the
 * question bridge before they become a new turn.
 *
 * A pending question runs while the turn is still open, so a typed answer would
 * otherwise be steered into the agent instead of resolving the question, and a
 * `qn:` press would be dropped by the callback router. Both are asserted here
 * against a spy bridge; the bridge's own behaviour is covered in
 * `questions.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ApprovalBridge } from "../../src/telegram/approvals.ts";
import { ModelMenu } from "../../src/telegram/model.ts";
import { TelegramRuntime } from "../../src/telegram/runtime.ts";
import type { TelegramUpdate } from "../../src/telegram/telegram/api.ts";

/** A question-bridge spy recording what the runtime routes to it. */
function questionSpy(consume: { text: boolean; callback: boolean }): {
	spy: unknown;
	texts: { chatId: number; text: string }[];
	callbacks: string[];
} {
	const texts: { chatId: number; text: string }[] = [];
	const callbacks: string[] = [];
	const spy = {
		handleText: (chatId: number, text: string) => {
			texts.push({ chatId, text });
			return consume.text;
		},
		handleCallback: async (data: string) => {
			callbacks.push(data);
			return consume.callback;
		},
		dispose: () => undefined,
	};
	return { spy, texts, callbacks };
}

/** A runtime with just enough deps to drive `handleUpdate`, and a turn spy. */
function makeRuntime(spy: unknown): { runtime: TelegramRuntime; turns: string[] } {
	const turns: string[] = [];
	const runtime = new TelegramRuntime({
		get: () => undefined,
		store: {
			chats: { get: () => undefined, put: async () => undefined },
			origins: { put: async () => undefined },
			global: { get: () => ({}), set: async () => undefined },
		} as never,
		manager: {
			ensure: async () => ({ sessionId: "s1", agent: { session: { header: { cwd: "/tmp/dsh-question-routing" } } } }),
			runTurn: async (_chat: unknown, text: string) => {
				turns.push(text);
			},
			steer: (_chat: unknown, text: string) => {
				turns.push(`steer:${text}`);
			},
		} as never,
		approvals: new ApprovalBridge({ api: () => undefined, isOurs: () => false, chatFor: () => undefined, log: () => undefined }),
		questions: spy as never,
		menu: new ModelMenu(),
		config: () => ({ ownerUserId: "42", defaultCwd: "/tmp/dsh-question-routing", permissionPreset: "workspace-write" }) as never,
		log: () => undefined,
		timing: { mergeMs: 5 },
	});
	return { runtime, turns };
}

/** A private-chat text message from the owner. */
function textMessage(text: string): TelegramUpdate {
	const chat = { id: 42, type: "private" };
	return { update_id: 1, message: { message_id: 1, date: 0, chat, from: { ...chat, is_bot: false }, text } };
}

/** A button press from the owner. */
function press(data: string): TelegramUpdate {
	return {
		update_id: 2,
		callback_query: {
			id: "cb-1",
			from: { id: 42, type: "private", is_bot: false },
			message: { message_id: 5, date: 0, chat: { id: 42, type: "private" } },
			data,
		},
	};
}

async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 30));
}

test("a typed reply answering a pending question does not start a turn", async () => {
	const { spy, texts } = questionSpy({ text: true, callback: false });
	const { runtime, turns } = makeRuntime(spy);
	await runtime.handleUpdate(textMessage("https://example.test"));
	await settle();
	assert.deepEqual(texts, [{ chatId: 42, text: "https://example.test" }]);
	assert.deepEqual(turns, [], "a consumed reply must not become a turn or a steer");
});

test("every text message is offered to the question bridge, which may decline it", async () => {
	// When the bridge declines (no question is pending), the message is not
	// swallowed here — it continues down the ordinary turn path, which
	// `runtime-shell.test.ts` exercises end to end with a started runtime.
	const { spy, texts } = questionSpy({ text: false, callback: false });
	const { runtime } = makeRuntime(spy);
	await runtime.handleUpdate(textMessage("just chatting"));
	await settle();
	assert.deepEqual(texts, [{ chatId: 42, text: "just chatting" }]);
});

test("a qn: press is routed to the question bridge", async () => {
	const { spy, callbacks } = questionSpy({ text: false, callback: true });
	const { runtime } = makeRuntime(spy);
	await runtime.handleUpdate(press("qn:abc123:o:0"));
	assert.deepEqual(callbacks, ["qn:abc123:o:0"]);
});
