/**
 * The merge window: Telegram splits a long paste into several messages, and each
 * one must not become its own turn (or its own `steer`).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { MessageMerger, type MergeScheduler } from "../../src/telegram/telegram/merge.ts";

/** A scheduler whose timers only fire when the test says so. */
class FakeScheduler implements MergeScheduler {
	readonly pending = new Map<number, () => void>();
	#next = 1;

	set(run: () => void, _ms: number): unknown {
		const handle = this.#next++;
		this.pending.set(handle, run);
		return handle;
	}

	clear(handle: unknown): void {
		this.pending.delete(handle as number);
	}

	/** Fire every outstanding timer. */
	runAll(): void {
		for (const run of [...this.pending.values()]) run();
	}

	/** How many windows are currently open. */
	get size(): number {
		return this.pending.size;
	}
}

test("fragments arriving inside the window are delivered as one batch", () => {
	const scheduler = new FakeScheduler();
	const batches: { key: string; items: readonly string[] }[] = [];
	const merger = new MessageMerger<string>((key, items) => batches.push({ key, items }), 2000, scheduler);

	merger.push("42", "part one");
	merger.push("42", "part two");
	assert.equal(scheduler.size, 1, "a second fragment must reuse the same window");
	scheduler.runAll();

	assert.deepEqual(batches, [{ key: "42", items: ["part one", "part two"] }]);
});

test("each push restarts the window, so one timer is outstanding per chat", () => {
	const scheduler = new FakeScheduler();
	const merger = new MessageMerger<string>(() => undefined, 2000, scheduler);
	merger.push("1", "a");
	const first = [...scheduler.pending.keys()][0];
	merger.push("1", "b");
	assert.equal(scheduler.size, 1);
	assert.notEqual([...scheduler.pending.keys()][0], first, "the original timer should have been replaced");
});

test("separate chats buffer independently", () => {
	const scheduler = new FakeScheduler();
	const batches: string[] = [];
	const merger = new MessageMerger<string>((key) => batches.push(key), 2000, scheduler);
	merger.push("1", "a");
	merger.push("2", "b");
	assert.equal(scheduler.size, 2);
	merger.flushNow("1");
	assert.deepEqual(batches, ["1"]);
});

test("dispose drops buffered fragments without delivering them", () => {
	const scheduler = new FakeScheduler();
	let delivered = 0;
	const merger = new MessageMerger<string>(() => {
		delivered += 1;
	}, 2000, scheduler);
	merger.push("1", "a");
	merger.dispose();
	scheduler.runAll();
	assert.equal(delivered, 0);
	assert.equal(merger.hasPending("1"), false);
});

test("a flushed key can start a fresh window", () => {
	const scheduler = new FakeScheduler();
	const batches: (readonly string[])[] = [];
	const merger = new MessageMerger<string>((_key, items) => batches.push(items), 2000, scheduler);
	merger.push("1", "a");
	merger.flushNow("1");
	merger.push("1", "b");
	scheduler.runAll();
	assert.deepEqual(batches, [["a"], ["b"]]);
});
