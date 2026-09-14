/**
 * An in-memory stand-in for one domain table.
 *
 * Two test files need a `KvTable` they can hand to `openStore` without a live
 * storage backend — the domain spec's tests and the store row's boot tests. The
 * map is real (not a fresh object per call), so a test that writes through
 * `put` and reads back through `get` exercises the same storage the production
 * handle would, which is the point of testing the wiring at all.
 * @module test/support/domain-tables
 */
import type { KvTable } from "@deepseek-ai/dsh-storage-domain";

/**
 * Build one empty in-memory table.
 *
 * The returned value also carries the backing `Map` as `rows`, so a caller can
 * seed or read state directly: a row of telemetry that only the store ever
 * writes is otherwise impossible to arrange from a mount test. The value stays
 * assignable to `KvTable` — the extra field widens the object, it changes none
 * of the eight contract members.
 * @returns a table backed by a `Map`, mirroring `KvTable`'s five reads and three writes.
 */
export function tableStub<V>(): KvTable<string, V> & { readonly rows: Map<string, V> } {
	const rows = new Map<string, V>();
	return {
		rows,
		get: (key) => rows.get(key),
		entries: () => rows.entries(),
		keys: () => rows.keys(),
		get size() {
			return rows.size;
		},
		put: async (key, value) => {
			rows.set(key, value);
		},
		delete: async (key) => rows.delete(key),
		update: async (key, fn) => {
			const current = rows.get(key);
			// Mirrors the real table: an absent key rejects rather than inventing
			// a first value, so a test cannot pass on a backend that never would.
			if (current === undefined) {
				throw Object.assign(new Error(`missing key "${key}"`), { code: "missing-key" });
			}
			const next = fn(current);
			rows.set(key, next);
			return next;
		},
	};
}
