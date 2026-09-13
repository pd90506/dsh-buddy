/**
 * `runTurn` streams: each assistant message reaches Telegram the moment its
 * `session/event` commits, not in one batch after the turn goes idle. This is
 * what makes a multi-step Buddy reply arrive on the phone the way DSH chat shows
 * it — one bubble at a time — instead of a wall of text at the end.
 *
 * The firehose is fire-and-forget and a tail callback can, in principle, run
 * after `whenIdle()` resolves; the final sweep is the belt-and-suspenders that
 * guarantees nothing the log recorded is ever dropped.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager, type ResolvedChat, type SessionEventLike, type TurnPart } from "../../src/telegram/session.ts";

/** A promise a test resolves by hand, to hold `whenIdle` open. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve: () => void = () => undefined;
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

/** Yield to the microtask/timer queue so chained deliveries can run. */
function tick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function turnStart(seq: number, turn: number): SessionEventLike {
	return { seq, type: "turn/start", data: { turn } };
}

function assistant(seq: number, turn: number, text: string): SessionEventLike {
	return { seq, type: "assistant/message", data: { turn, message: { content: [{ type: "text", text }] } } };
}

/** The captured firehose handler, the manager, and the recorded deliveries. */
interface Rig {
	readonly manager: SessionManager;
	readonly resolved: ResolvedChat;
	/** All events the fake session log holds; drives `snapshotEvents`. */
	readonly log: SessionEventLike[];
	/** Push an event AND fire it on the firehose, as a live commit would. */
	fire(event: SessionEventLike): void;
	/** Fire an event on the firehose tagged with a foreign session id. */
	fireAs(id: string, event: SessionEventLike): void;
	/** Push an event to the log only, without firing it (a missed tail callback). */
	record(event: SessionEventLike): void;
	/** Resolve `whenIdle`, ending the turn. */
	finish(): void;
	/** Every `onParts` call, as arrays of parts. */
	readonly deliveries: TurnPart[][];
	/** The turn promise, once `run` is called. */
	run(): Promise<void>;
}

/**
 * Build a manager with a fake agent and a captured firehose.
 * @param baseline - the session's seq before the turn starts.
 * @param sessionId - the session id the firehose tags its events with.
 */
function rig(baseline: number, sessionId = "s1"): Rig {
	const log: SessionEventLike[] = [];
	const idle = deferred();
	const deliveries: TurnPart[][] = [];
	let handler: ((session: { readonly id: unknown }, event: SessionEventLike) => void) | undefined;

	const session = {
		id: sessionId,
		seq: baseline,
		snapshotEvents: (from = 0): readonly SessionEventLike[] => log.filter((event) => event.seq >= from),
		header: undefined,
	};
	const agent = {
		session,
		status: "idle",
		followup: (): void => undefined,
		steer: (): void => undefined,
		cancel: (): void => undefined,
		whenIdle: (): Promise<void> => idle.promise,
	};
	const resolved: ResolvedChat = { sessionId: sessionId as never, agent: agent as never, created: false };

	const manager = new SessionManager({
		get: () => undefined,
		store: {} as never,
		log: () => undefined,
		presetId: "buddy",
		buddyModel: () => undefined,
		onSessionEvent: (h) => {
			handler = h as never;
			return () => {
				handler = undefined;
			};
		},
	});

	return {
		manager,
		resolved,
		log,
		fire: (event) => {
			log.push(event);
			handler?.(session, event);
		},
		fireAs: (id, event) => {
			handler?.({ id }, event);
		},
		record: (event) => {
			log.push(event);
		},
		finish: () => idle.resolve(),
		deliveries,
		run: () => manager.runTurn(resolved, "hi", async (parts) => {
			deliveries.push([...parts]);
		}),
	};
}

test("runTurn delivers each assistant message before the turn goes idle", async () => {
	const r = rig(10);
	const turn = r.run();

	r.fire(turnStart(10, 5));
	r.fire(assistant(11, 5, "first"));
	await tick();
	assert.deepEqual(r.deliveries, [[{ kind: "text", text: "first" }]], "the first message must go out before whenIdle resolves");

	r.fire(assistant(12, 5, "second"));
	await tick();
	assert.deepEqual(r.deliveries, [[{ kind: "text", text: "first" }], [{ kind: "text", text: "second" }]]);

	r.finish();
	await turn;
	// The final sweep must not re-deliver what the firehose already sent.
	assert.equal(r.deliveries.length, 2, "no duplicate delivery from the final sweep");
});

test("runTurn's final sweep delivers a message the firehose missed", async () => {
	const r = rig(10);
	const turn = r.run();

	r.fire(turnStart(10, 5));
	r.fire(assistant(11, 5, "streamed"));
	await tick();
	// A tail callback that never fired: the event is in the log but was not pushed.
	r.record(assistant(12, 5, "missed"));

	r.finish();
	await turn;
	assert.deepEqual(r.deliveries, [[{ kind: "text", text: "streamed" }], [{ kind: "text", text: "missed" }]]);
});

test("runTurn ignores events from another session on the shared firehose", async () => {
	const r = rig(10, "s1");
	const turn = r.run();

	r.fire(turnStart(10, 5));
	// An event tagged with a different session id must not reach this chat.
	r.fireAs("other", assistant(11, 5, "not ours"));
	r.fire(assistant(12, 5, "ours"));
	await tick();

	r.finish();
	await turn;
	assert.deepEqual(r.deliveries, [[{ kind: "text", text: "ours" }]]);
});
