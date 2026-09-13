import assert from "node:assert/strict";
import { test } from "node:test";
import { createNotifier } from "../src/client/notifier.ts";

test("every subscriber is called on notify", () => {
	const notifier = createNotifier();
	const calls: string[] = [];
	notifier.subscribe(() => calls.push("a"));
	notifier.subscribe(() => calls.push("b"));
	notifier.notify();
	assert.deepEqual(calls, ["a", "b"]);
	notifier.notify();
	assert.deepEqual(calls, ["a", "b", "a", "b"]);
});

test("an unsubscribed listener is never called again", () => {
	const notifier = createNotifier();
	const calls: string[] = [];
	const unsubscribe = notifier.subscribe(() => calls.push("a"));
	notifier.subscribe(() => calls.push("b"));
	unsubscribe();
	notifier.notify();
	assert.deepEqual(calls, ["b"]);
});

test("notify with no subscribers does nothing", () => {
	const notifier = createNotifier();
	assert.doesNotThrow(() => notifier.notify());
});
