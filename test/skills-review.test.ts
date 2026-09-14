/**
 * Task 12: the review coordinator — when a review fires, which path it takes,
 * and what it cost.
 *
 * The whole file drives the coordinator through its injected seam (`config`,
 * `spawn`, `interrupt`, `now`, `log`) rather than a live host row, because the
 * rules under test are decisions, not wiring: the trigger chain (a completed
 * turn, enough steps, not a delegate, nothing already in flight), the two input
 * paths (same-model `fork` vs cheap-model `spawn` carrying the digest), and the
 * two budgets enforced by observing the child session's own events.
 *
 * Two decisions carry the most weight, and each has a test that can only fail
 * for its own reason. **Path selection** is measured against the route the
 * conversation really ran on (`onTurnEnd`'s `route`), not against Buddy's
 * default model — so the tests deliberately make the config's `model` and the
 * session route disagree, and one covers the documented degraded fallback when
 * the host row omits the route. **The single-flight guard** is pinned by the
 * test where a whole new interval elapses while the first review is still
 * flying and the second trigger is dropped; the back-to-back double call is
 * kept as a second angle on the same claim.
 *
 * The failure test holds `done`'s rejection until after the child's message has
 * been observed — a review that spent tokens and *then* threw is the case the
 * reference implementation added a side table for, and the `finally` is where
 * that lives.
 * @module test/skills-review
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { KvTable } from "@deepseek-ai/dsh-storage-domain";
import { FALLBACK_CONFIG, type BuddyConfig } from "../src/config.ts";
import { digestHistory, type DigestMessage } from "../src/skills/digest.ts";
import { REVIEW_TOOL_CLAUSE, SKILL_REVIEW_PROMPT } from "../src/skills/prompt.ts";
import {
	REVIEW_TOOL_FILTER,
	ReviewCoordinator,
	type ReviewCoordinatorDeps,
	type ReviewSpawnInput,
} from "../src/skills/review.ts";
import type { ReviewUsageRecord } from "../src/store/domain.ts";
import { tableStub } from "./support/domain-tables.ts";

/**
 * The shipped nudge interval, read from the defaults rather than copied, so a
 * change to `creationNudgeInterval` fails the fixture rather than three tests
 * that are not about it.
 */
const NUDGE = FALLBACK_CONFIG.skills.creationNudgeInterval;

/** The shipped step ceiling, for the same reason. */
const STEP_BUDGET = FALLBACK_CONFIG.skills.maxReviewSteps;

/** A model route: the pair the fork decision compares against. */
interface Route {
	readonly provider: string;
	readonly model: string;
}

/** One recorded `spawn` call, reduced to the fields a test asserts. */
interface SpawnCall {
	readonly provider: "fork" | "spawn";
	readonly prompt: string;
	readonly toolFilter: ReviewSpawnInput["toolFilter"];
	readonly childSessionId: string;
}

/** A pending spawn the test controls. */
interface Gate {
	/**
	 * `"pending"` leaves the review in flight so the test can deliver its child
	 * events while it is alive, `"resolve"`/`"reject"` settle it immediately.
	 */
	mode: "pending" | "resolve" | "reject";
	/** Settle a `"pending"` gate. */
	settle: { resolve(value: unknown): void; reject(error: unknown): void };
}

/** Everything one `makeCoordinator` hands back to its test. */
interface Harness {
	/**
	 * The coordinator under test. Assigned after construction because the spawn
	 * seam closes over the harness that holds it.
	 */
	coordinator: ReviewCoordinator;
	/** Every `spawn` call, in order. */
	readonly spawned: SpawnCall[];
	/** The `review_usage` table the coordinator writes. */
	readonly reviewUsage: KvTable<string, ReviewUsageRecord>;
	/** Controls the next spawn's settlement. */
	gate: Gate;
	/** The child id most recently spawned (the stub is deterministic). */
	childId: string | undefined;
	/** The spawn result most recently returned, so a test can await `done`. */
	done: Promise<unknown> | undefined;
	/** Mutable state shared by every coordinator in one test. */
	readonly shared: Shared;
}

/** Mutable state shared by every coordinator in one test. */
interface Shared {
	/** The ids `interrupt` was called with, in order. */
	readonly interrupted: string[];
	/** The lines `log` was called with, in order. */
	readonly logged: string[];
	/** How many children have been spawned, for unique child ids. */
	children: number;
	/** The child id most recently spawned, so `interrupt` can be asserted. */
	lastChild: string | undefined;
}

/** A fresh bundle of cross-coordinator state. */
function freshShared(): Shared {
	return { interrupted: [], logged: [], children: 0, lastChild: undefined };
}

/** An unsettled promise plus its two settlers. */
function deferred(): {
	readonly promise: Promise<unknown>;
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: unknown) => void;
} {
	let resolve!: (value: unknown) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<unknown>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	// A test that rejects the gate awaits `onTurnEnd`, which observes it, so this
	// promise is never left unhandled.
	return { promise, resolve, reject };
}

/** A fresh gate that settles a spawn at once, the way a fast review does. */
function immediateGate(): Gate {
	return { mode: "resolve", settle: { resolve: () => {}, reject: () => {} } };
}

/** The settings one coordinator runs with; `FALLBACK_CONFIG.skills` plus overrides. */
function skills(override: Partial<BuddyConfig["skills"]>): BuddyConfig["skills"] {
	return { ...FALLBACK_CONFIG.skills, ...override };
}

/**
 * Build a fake host row: a settings config, a fake clock, and a `spawn` that
 * records its input and settles according to {@link Harness.gate}.
 *
 * The config starts from the shipped {@link FALLBACK_CONFIG} rather than a
 * hand-copied literal, so a new settings field lands here for free and the
 * trigger tests run at the real nudge interval. `model` is Buddy's *default*
 * model and deliberately left all-empty (the shipped value) — the tests that
 * care about the parent route pass `route` to {@link startReview}, which is
 * what a host row does.
 * @param skillsOverride - settings overrides on top of the shipped defaults.
 * @param shared - mutable cross-coordinator state; a fresh one by default.
 * @returns the harness, whose `spawned` log is the assertion surface.
 */
function makeCoordinator(
	skillsOverride: Partial<BuddyConfig["skills"]> = {},
	shared: Shared = freshShared(),
): Harness {
	const spawned: SpawnCall[] = [];
	const config: BuddyConfig = { ...FALLBACK_CONFIG, skills: skills(skillsOverride) };
	const reviewUsage = tableStub<ReviewUsageRecord>();
	const harness: Harness = {
		coordinator: undefined as unknown as ReviewCoordinator,
		spawned,
		reviewUsage,
		gate: immediateGate(),
		childId: undefined,
		done: undefined,
		shared,
	};
	const deps: ReviewCoordinatorDeps = {
		config: () => config,
		spawn: (input) => {
			shared.children += 1;
			const childSessionId = shared.children === 1 ? "child" : `child${shared.children}`;
			shared.lastChild = childSessionId;
			spawned.push({ provider: input.provider, prompt: input.prompt, toolFilter: input.toolFilter, childSessionId });
			let done: Promise<unknown>;
			if (harness.gate.mode === "resolve") {
				done = Promise.resolve("ok");
			} else if (harness.gate.mode === "reject") {
				done = Promise.reject(new Error("review blew up"));
			} else {
				const pending = deferred();
				harness.gate = { ...harness.gate, settle: { resolve: pending.resolve, reject: pending.reject } };
				done = pending.promise;
			}
			harness.childId = childSessionId;
			harness.done = done;
			return { childSessionId, done };
		},
		interrupt: (childSessionId) => {
			shared.interrupted.push(childSessionId);
		},
		now: () => "2026-09-14T00:00:00.000Z",
		log: (line) => {
			shared.logged.push(line);
		},
	};
	harness.coordinator = new ReviewCoordinator({ ...deps, reviewUsage });
	return harness;
}

/** What a test may vary about the triggering turn. */
interface TurnOptions {
	/** The route the conversation actually ran on; omitted exercises the fallback. */
	readonly route?: Route | undefined;
	/** The transcript, needed only by the cheap-model path. */
	readonly surface?: readonly DigestMessage[] | undefined;
}

/**
 * Count a full interval and fire the triggering turn.
 *
 * Deliberately does not await `onTurnEnd`: the caller holds the returned
 * promise so it can deliver the review's child events *while it is alive* and
 * settle it afterwards, which is the order a real review is observed in.
 * @param harness - the harness under test.
 * @param options - the turn's route and transcript, when the test cares.
 * @returns the in-flight `onTurnEnd` promise.
 */
function startReview(harness: Harness, options: TurnOptions = {}): Promise<void> {
	for (let i = 0; i < NUDGE; i += 1) harness.coordinator.noteStep("s1");
	return harness.coordinator.onTurnEnd({ sessionId: "s1", reason: { kind: "completed" }, ...options });
}

/** Start a review and wait for it to finish. */
async function fire(harness: Harness, options: TurnOptions = {}): Promise<void> {
	await startReview(harness, options);
}

/** A surface long enough that `digestHistory` synthesizes a digest message. */
function manyMessages(): DigestMessage[] {
	const messages: DigestMessage[] = [];
	for (let i = 0; i < 60; i += 1) {
		messages.push({ role: "user", text: `question ${i}` });
		messages.push({ role: "assistant", text: `answer ${i}` });
	}
	return messages;
}

/** The single usage row a finished review must leave behind. */
function soleUsageRow(harness: Harness): ReviewUsageRecord {
	assert.equal(harness.reviewUsage.size, 1);
	return [...harness.reviewUsage.entries()][0]![1];
}

test("the nudge counts steps and fires only on a completed turn", async () => {
	const harness = makeCoordinator();
	for (let i = 0; i < NUDGE; i += 1) harness.coordinator.noteStep("s1");
	await harness.coordinator.onTurnEnd({ sessionId: "s1", reason: { kind: "completed" } });
	assert.equal(harness.spawned.length, 1);
	assert.equal(harness.spawned[0]!.provider, "fork");
	assert.deepEqual(harness.spawned[0]!.toolFilter, ["skill", "skill_manage", "read", "grep", "glob"]);
	assert.equal(harness.spawned[0]!.prompt.includes("You can only call skill management tools"), true);
});

test("an aborted turn never fires, and one step short is not enough", async () => {
	const harness = makeCoordinator();
	for (let i = 0; i < NUDGE; i += 1) harness.coordinator.noteStep("s1");
	await harness.coordinator.onTurnEnd({ sessionId: "s1", reason: { kind: "aborted" } });
	assert.equal(harness.spawned.length, 0);

	const other = makeCoordinator();
	for (let i = 0; i < NUDGE - 1; i += 1) other.coordinator.noteStep("s2");
	await other.coordinator.onTurnEnd({ sessionId: "s2", reason: { kind: "completed" } });
	assert.equal(other.spawned.length, 0);
});

test("calling skill_manage resets the counter", async () => {
	const harness = makeCoordinator();
	for (let i = 0; i < NUDGE - 1; i += 1) harness.coordinator.noteStep("s1");
	harness.coordinator.noteSkillManageCalled("s1");
	await harness.coordinator.onTurnEnd({ sessionId: "s1", reason: { kind: "completed" } });
	assert.equal(harness.spawned.length, 0);
});

test("a delegated session never triggers", async () => {
	const harness = makeCoordinator();
	for (let i = 0; i < NUDGE; i += 1) harness.coordinator.noteStep("sub");
	await harness.coordinator.onTurnEnd({ sessionId: "sub", reason: { kind: "completed" }, origin: "subagent" });
	assert.equal(harness.spawned.length, 0);
});

test("a non-zero delegation depth also skips the review", async () => {
	const harness = makeCoordinator();
	for (let i = 0; i < NUDGE; i += 1) harness.coordinator.noteStep("s1");
	await harness.coordinator.onTurnEnd({ sessionId: "s1", reason: { kind: "completed" }, delegationDepth: 1 });
	assert.equal(harness.spawned.length, 0);
});

test("two triggers for one session in the same instant start one review", async () => {
	const harness = makeCoordinator();
	harness.gate.mode = "pending";
	for (let i = 0; i < NUDGE; i += 1) harness.coordinator.noteStep("s1");
	void harness.coordinator.onTurnEnd({ sessionId: "s1", reason: { kind: "completed" } });
	await harness.coordinator.onTurnEnd({ sessionId: "s1", reason: { kind: "completed" } });
	assert.equal(harness.spawned.length, 1);
	harness.gate.settle.resolve("ok");
});

test("a cheap-model review spawns instead of forking and carries the digest", async () => {
	const harness = makeCoordinator({ reviewProvider: "cliproxyapi", reviewModel: "cheap" });
	await fire(harness, { surface: manyMessages() });
	assert.equal(harness.spawned[0]!.provider, "spawn");
	assert.deepEqual(harness.spawned[0]!.toolFilter, REVIEW_TOOL_FILTER);
	assert.match(harness.spawned[0]!.prompt, /Earlier conversation digest/);
	// The digest's own synthesized prefix reaches the prompt, so the review is
	// handed the older turns and not only the verbatim tail.
	const digest = digestHistory(manyMessages());
	const header = digest[0]!.text.slice(0, 80);
	assert.ok(harness.spawned[0]!.prompt.includes(header));
	assert.ok(harness.spawned[0]!.prompt.includes(SKILL_REVIEW_PROMPT));
	assert.ok(harness.spawned[0]!.prompt.includes(REVIEW_TOOL_CLAUSE));
});

test("the fork path never carries the digest, even when a surface is passed", async () => {
	const harness = makeCoordinator();
	await fire(harness, { surface: manyMessages() });
	assert.equal(harness.spawned[0]!.provider, "fork");
	assert.deepEqual(harness.spawned[0]!.toolFilter, REVIEW_TOOL_FILTER);
	assert.ok(!harness.spawned[0]!.prompt.includes("Earlier conversation digest"));
	assert.ok(harness.spawned[0]!.prompt.includes(SKILL_REVIEW_PROMPT));
});

test("a pinned session route decides the path, not the default model", async () => {
	// `config().model` and the session's real route disagree — the conversation
	// was pinned to the review model by chat `/model` or the global default, so
	// the review must FORK (same model), even though Buddy's default is empty.
	const harness = makeCoordinator({ reviewProvider: "cliproxyapi", reviewModel: "cheap" });
	await fire(harness, {
		route: { provider: "cliproxyapi", model: "cheap" },
		surface: manyMessages(),
	});
	assert.equal(harness.spawned.length, 1);
	assert.equal(harness.spawned[0]!.provider, "fork");
	assert.ok(!harness.spawned[0]!.prompt.includes("Earlier conversation digest"));
});

test("a route that genuinely differs from the review model spawns with the digest", async () => {
	// The session ran on `deepseek` while the review is configured for the cheap
	// aux model, so the paths really do differ: SPAWN, with the digest.
	const harness = makeCoordinator({ reviewProvider: "cliproxyapi", reviewModel: "cheap" });
	await fire(harness, {
		route: { provider: "deepseek", model: "deepseek-chat" },
		surface: manyMessages(),
	});
	assert.equal(harness.spawned.length, 1);
	assert.equal(harness.spawned[0]!.provider, "spawn");
	assert.match(harness.spawned[0]!.prompt, /Earlier conversation digest/);
});

test("without a route the decision falls back to the default model", async () => {
	// The documented degraded path: no route, so Buddy's default model is the
	// only comparable route. The shipped default is empty, so a configured
	// review model looks different and the review spawns with a digest.
	const harness = makeCoordinator({ reviewProvider: "cliproxyapi", reviewModel: "cheap" });
	await fire(harness, { surface: manyMessages() });
	assert.equal(harness.spawned[0]!.provider, "spawn");
	assert.match(harness.spawned[0]!.prompt, /Earlier conversation digest/);
});

test("the review stops at the step budget", async () => {
	const shared = freshShared();
	const harness = makeCoordinator({}, shared);
	const running = startReview(harness);
	assert.equal(shared.interrupted.length, 0);
	for (let i = 0; i < STEP_BUDGET; i += 1) harness.coordinator.noteChildEvent("child", { type: "step/end" });
	assert.equal(shared.interrupted[0], "child");
	harness.gate.settle.resolve("ok");
	await running;
});

test("the input-token budget is cumulative, not per message", async () => {
	const shared = freshShared();
	// Two messages that each fit under the budget alone and only together exceed
	// it, so `interrupt` can only fire on the second and the recorded total can
	// only be the sum (spec §7.4 budgets 600000 cumulatively).
	const harness = makeCoordinator({ maxInputTokens: 1000 }, shared);
	const running = startReview(harness);
	harness.coordinator.noteChildEvent("child", {
		type: "assistant/message",
		usage: { inputTokens: 600, cacheReadTokens: 100 },
	});
	assert.deepEqual(shared.interrupted, [], "one message alone is under the budget");
	harness.coordinator.noteChildEvent("child", {
		type: "assistant/message",
		usage: { inputTokens: 600, cacheReadTokens: 800 },
	});
	assert.equal(shared.interrupted[0], "child");
	harness.gate.settle.resolve("ok");
	await running;
	assert.equal(soleUsageRow(harness).inputTokens, 1200);
});

test("usage is attributed to the parent session in a finally, even on failure", async () => {
	const reviewUsage = tableStub<ReviewUsageRecord>();
	const config: BuddyConfig = { ...FALLBACK_CONFIG };
	// A review that burns tokens and *then* throws is the case the reference
	// implementation added a side table for, so the rejection is held until the
	// child's message has actually been observed.
	let fail!: (error: unknown) => void;
	const done = new Promise<unknown>((_resolve, reject) => {
		fail = reject;
	});
	const coordinator = new ReviewCoordinator({
		config: () => config,
		spawn: () => ({ childSessionId: "child", done }),
		interrupt: () => {},
		now: () => "2026-09-14T00:00:00.000Z",
		log: () => {},
		reviewUsage,
	});
	for (let i = 0; i < NUDGE; i += 1) coordinator.noteStep("s1");
	const ending = coordinator.onTurnEnd({ sessionId: "s1", reason: { kind: "completed" } });
	coordinator.noteChildEvent("child", {
		type: "assistant/message",
		usage: { inputTokens: 1200, outputTokens: 34, cacheReadTokens: 900, cacheWriteTokens: 12 },
	});
	fail(new Error("review blew up"));
	await ending;
	assert.equal(reviewUsage.size, 1);
	const [record] = [...reviewUsage.entries()].map(([, value]) => value);
	assert.equal(record!.parentSessionId, "s1");
	assert.equal(record!.childSessionId, "child");
	assert.equal(record!.provider, "fork");
	assert.equal(record!.cacheReadTokens, 900);
	assert.equal(record!.outputTokens, 34);
	assert.equal(record!.cacheWriteTokens, 12);
	assert.equal(record!.inputTokens, 1200);
	assert.equal(record!.steps, 0);
	assert.equal(record!.outcome, "failed");
});

test("a failing usage write is logged, not thrown at the caller", async () => {
	const stored = tableStub<ReviewUsageRecord>();
	const reviewUsage: KvTable<string, ReviewUsageRecord> = {
		...stored,
		put: async () => {
			throw new Error("storage is read-only");
		},
	};
	const logged: string[] = [];
	const coordinator = new ReviewCoordinator({
		config: () => ({ ...FALLBACK_CONFIG }),
		spawn: () => ({ childSessionId: "child", done: Promise.resolve("ok") }),
		interrupt: () => {},
		now: () => "2026-09-14T00:00:00.000Z",
		log: (line) => {
			logged.push(line);
		},
		reviewUsage,
	});
	for (let i = 0; i < NUDGE; i += 1) coordinator.noteStep("s1");
	// Telemetry is not a gate: a storage failure must not become an unhandled
	// rejection on the turn path (the `skills/usage.ts` discipline).
	await coordinator.onTurnEnd({ sessionId: "s1", reason: { kind: "completed" } });
	assert.equal(stored.size, 0);
	assert.ok(logged.some((line) => line.includes("review_usage")));
	assert.ok(logged.some((line) => line.includes("result=completed")));
});

test("a malformed child event is ignored rather than thrown", async () => {
	const harness = makeCoordinator();
	await fire(harness);
	assert.doesNotThrow(() => {
		harness.coordinator.noteChildEvent("child", undefined);
		harness.coordinator.noteChildEvent("child", { type: "step/end", usage: "nope" });
		harness.coordinator.noteChildEvent("child", { type: "assistant/message", usage: { inputTokens: "many" } });
		harness.coordinator.noteChildEvent("child", { type: 7 });
	});
	assert.deepEqual(harness.shared.interrupted, []);
});

test("a finished review releases the session so the next turn can start a new one", async () => {
	const harness = makeCoordinator();
	await fire(harness);
	await fire(harness);
	assert.equal(harness.spawned.length, 2);
	assert.equal(harness.reviewUsage.size, 2);
});

test("no step is counted while skills are disabled", async () => {
	const harness = makeCoordinator({ enabled: false });
	await fire(harness);
	assert.equal(harness.spawned.length, 0);
});

test("the completion log line carries the calls and cache facts", async () => {
	const harness = makeCoordinator();
	const running = startReview(harness);
	harness.coordinator.noteChildEvent("child", { type: "step/end" });
	harness.coordinator.noteChildEvent("child", {
		type: "assistant/message",
		usage: { inputTokens: 1200, outputTokens: 34, cacheReadTokens: 900 },
	});
	harness.gate.settle.resolve("ok");
	await running;
	assert.deepEqual(harness.shared.logged, [
		"Background review complete: calls=1 in=1200 out=34 cache_read=900 result=completed",
	]);
});

test("a review still running across a whole new interval drops the new trigger", async () => {
	const harness = makeCoordinator();
	harness.gate.mode = "pending";
	for (let i = 0; i < NUDGE; i += 1) harness.coordinator.noteStep("s1");
	const first = harness.coordinator.onTurnEnd({ sessionId: "s1", reason: { kind: "completed" } });
	assert.equal(harness.spawned.length, 1);
	// Another full interval elapses while the first review is still flying, so
	// the second completed turn passes the counter check and is dropped there —
	// no queue, no second spawn (spec §6: drops silently, never reorders).
	for (let i = 0; i < NUDGE; i += 1) harness.coordinator.noteStep("s1");
	await harness.coordinator.onTurnEnd({ sessionId: "s1", reason: { kind: "completed" } });
	assert.equal(harness.spawned.length, 1);
	harness.gate.settle.resolve("ok");
	// Awaiting the first trigger, not just the spawn result, is what proves the
	// release landed: the session leaves the in-flight set after `done` settles.
	await first;
	// The release is what allows the next interval to fire again.
	harness.gate = immediateGate();
	for (let i = 0; i < NUDGE; i += 1) harness.coordinator.noteStep("s1");
	await harness.coordinator.onTurnEnd({ sessionId: "s1", reason: { kind: "completed" } });
	assert.equal(harness.spawned.length, 2);
});
