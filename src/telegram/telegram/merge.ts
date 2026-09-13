/**
 * The inbound merge window.
 *
 * Telegram clients split a long paste into several messages, and a user typing
 * quickly produces a burst of short ones. Feeding each part to the agent on its
 * own wastes turns and — now that a busy chat steers rather than queues — would
 * inject several steers for what the user meant as one message. Parts that
 * arrive within {@link DEFAULT_MERGE_WINDOW_MS} of each other are therefore
 * concatenated and delivered once.
 *
 * The window resets on every part, so a paste of ten fragments stays one turn,
 * while a genuinely separate message sent a few seconds later starts its own.
 * @module dsh-telegram/telegram/merge
 */

/** How long a chat waits for a follow-up fragment before flushing. */
export const DEFAULT_MERGE_WINDOW_MS = 2000;

/** Injectable timer, so tests need no real clock. */
export interface MergeScheduler {
	/** Schedule `run` after `ms`. */
	set(run: () => void, ms: number): unknown;
	/** Cancel a handle returned by {@link MergeScheduler.set}. */
	clear(handle: unknown): void;
}

/** Default scheduler built on the platform timers. */
export const systemScheduler: MergeScheduler = {
	set: (run, ms) => setTimeout(run, ms),
	clear: (handle) => {
		clearTimeout(handle as ReturnType<typeof setTimeout>);
	},
};

/**
 * Per-key coalescing buffer.
 *
 * One instance serves every chat; keys are chat ids, and each key's fragments are
 * flushed in arrival order once its window closes.
 */
export class MessageMerger<T> {
	readonly #windowMs: number;
	readonly #flush: (key: string, items: readonly T[]) => void;
	readonly #scheduler: MergeScheduler;
	readonly #pending = new Map<string, { items: T[]; handle: unknown }>();

	/**
	 * @param flush - called once per closed window with every buffered item.
	 * @param windowMs - quiet period that closes a window.
	 * @param scheduler - injectable timers.
	 */
	constructor(
		flush: (key: string, items: readonly T[]) => void,
		windowMs: number = DEFAULT_MERGE_WINDOW_MS,
		scheduler: MergeScheduler = systemScheduler,
	) {
		this.#flush = flush;
		this.#windowMs = windowMs;
		this.#scheduler = scheduler;
	}

	/**
	 * Buffer one fragment, restarting the key's window.
	 * @param key - the chat this fragment belongs to.
	 * @param item - the fragment.
	 */
	push(key: string, item: T): void {
		const existing = this.#pending.get(key);
		if (existing === undefined) {
			const entry = { items: [item], handle: undefined as unknown };
			entry.handle = this.#scheduler.set(() => {
				this.#deliver(key);
			}, this.#windowMs);
			this.#pending.set(key, entry);
			return;
		}
		existing.items.push(item);
		this.#scheduler.clear(existing.handle);
		existing.handle = this.#scheduler.set(() => {
			this.#deliver(key);
		}, this.#windowMs);
	}

	/**
	 * Close a key's window immediately, or every window when called with no key.
	 * @param key - the chat to flush.
	 */
	flushNow(key?: string): void {
		if (key === undefined) {
			for (const pendingKey of [...this.#pending.keys()]) this.#deliver(pendingKey);
			return;
		}
		this.#deliver(key);
	}

	/** Drop every buffered fragment without delivering it (plugin shutdown). */
	dispose(): void {
		for (const entry of this.#pending.values()) this.#scheduler.clear(entry.handle);
		this.#pending.clear();
	}

	/** Whether a key currently has fragments waiting. */
	hasPending(key: string): boolean {
		return this.#pending.has(key);
	}

	/** Cancel the timer and hand the buffered items to the flush callback. */
	#deliver(key: string): void {
		const entry = this.#pending.get(key);
		if (entry === undefined) return;
		this.#pending.delete(key);
		this.#scheduler.clear(entry.handle);
		if (entry.items.length === 0) return;
		this.#flush(key, entry.items);
	}
}
