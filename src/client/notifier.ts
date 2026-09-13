/**
 * A minimal pub/sub used to push a live update across two independent
 * registrations mounted from the same `apply(ctx)` call — the Settings tab and
 * the main panel are separate component trees with no shared React tree to
 * carry state through, so a plain listener set is what lets one tell the other
 * "preferences changed, reload".
 * @module dsh-buddy/client/notifier
 */

/** A one-event pub/sub: no payload, just "something changed". */
export interface Notifier {
	/**
	 * Register a listener.
	 * @param listener - called on every `notify()` after this call.
	 * @returns a disposer that removes the listener.
	 */
	subscribe(listener: () => void): () => void;
	/** Call every currently subscribed listener. */
	notify(): void;
}

/**
 * Build a fresh notifier, backed by a `Set` so a listener that unsubscribes
 * during a `notify()` (or resubscribes) never corrupts the in-flight iteration.
 * @returns the notifier.
 */
export function createNotifier(): Notifier {
	const listeners = new Set<() => void>();
	return {
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		notify() {
			for (const listener of listeners) listener();
		},
	};
}
