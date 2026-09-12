import assert from "node:assert/strict";
import { test } from "node:test";
import { BUDDY_DOMAIN_NAME, buddyDomainSpec, globalSchema, openStore } from "../src/store/domain.ts";

/** A minimal live domain stand-in matching the accessors openStore uses. */
interface DomainStub {
	readonly name: string;
	readonly global: {
		get(): Record<string, unknown>;
		set(next: Record<string, unknown>): Promise<void>;
	};
	close(): Promise<void>;
	/** Set by `close`, so a test can tell a delegated close from a swallowed one. */
	closed: boolean;
}

/**
 * @param initial - the global the stand-in already holds, so a test can tell
 * the real domain apart from a freshly fabricated empty one.
 * @returns the stand-in.
 */
function domainStub(initial: Record<string, unknown> = {}): DomainStub {
	let global = initial;
	const stub: DomainStub = {
		name: BUDDY_DOMAIN_NAME,
		global: {
			get: () => global,
			set: async (next: Record<string, unknown>) => {
				global = next;
			},
		},
		close: async () => {
			stub.closed = true;
		},
		closed: false,
	};
	return stub;
}

test("the domain spec is named and versioned", () => {
	assert.equal(BUDDY_DOMAIN_NAME, "buddy");
	assert.equal(buddyDomainSpec.name, "buddy");
	assert.equal(buddyDomainSpec.version, 1);
	// Phase 1 has no per-key derived state; the global slot carries everything.
	assert.deepEqual(buddyDomainSpec.tables, {});
	assert.deepEqual(buddyDomainSpec.global.initial, {});
});

test("the global schema accepts an absent timestamp and rejects a non-string one", () => {
	assert.deepEqual(globalSchema.parse({}), {});
	assert.deepEqual(globalSchema.parse({ lastPersonaWriteAt: "2026-01-01T00:00:00.000Z" }), {
		lastPersonaWriteAt: "2026-01-01T00:00:00.000Z",
	});
	assert.throws(() => globalSchema.parse({ lastPersonaWriteAt: 5 }));
});

test("a missing storageDomain facility fails loudly", async () => {
	await assert.rejects(() => openStore({ get: () => undefined }), /storageDomain/);
});

test("opening the domain hands back that domain's own accessors", async () => {
	const live = domainStub({ lastPersonaWriteAt: "2026-01-01T00:00:00.000Z" });
	const requested: string[] = [];
	const opened: unknown[] = [];
	const lookups: string[] = [];
	const facility = {
		open: async (spec: unknown) => {
			opened.push(spec);
			return live;
		},
		get: (name: string) => {
			lookups.push(name);
			return undefined;
		},
	};

	const handle = await openStore({
		get: (name: string) => {
			requested.push(name);
			return facility;
		},
	});

	assert.deepEqual(requested, ["storageDomain"]);
	assert.equal(opened.length, 1);
	// The declared spec is what was opened, not some ad-hoc descriptor.
	assert.equal(opened[0], buddyDomainSpec);
	// The accessors belong to the opened domain, not to a fresh stand-in.
	assert.equal(handle.global.get()["lastPersonaWriteAt"], "2026-01-01T00:00:00.000Z");
	// A successful open never consults the already-open adoption path.
	assert.deepEqual(lookups, []);

	assert.equal(live.closed, false);
	await handle.close();
	// `close` delegates to the domain; it is the effect disposer's only lever.
	assert.equal(live.closed, true);
});

test("an already-open domain is adopted instead of failing (hot reload)", async () => {
	const live = domainStub({ lastPersonaWriteAt: "2026-02-02T00:00:00.000Z" });
	const lookups: string[] = [];
	const facility = {
		open: async () => {
			throw Object.assign(new Error("already open"), { code: "already-open" });
		},
		get: (name: string) => {
			lookups.push(name);
			return name === BUDDY_DOMAIN_NAME ? live : undefined;
		},
	};

	const handle = await openStore({ get: () => facility });

	// Adoption looks the live domain up by its one name.
	assert.deepEqual(lookups, [BUDDY_DOMAIN_NAME]);
	// The adopted handle is the LIVE domain: it already holds the other fiber's
	// state, which a fabricated empty stand-in would not.
	assert.equal(handle.global.get()["lastPersonaWriteAt"], "2026-02-02T00:00:00.000Z");
	// And writes through the adopted handle land on that same domain.
	await handle.global.set({ lastPersonaWriteAt: "2026-03-03T00:00:00.000Z" });
	assert.equal(live.global.get()["lastPersonaWriteAt"], "2026-03-03T00:00:00.000Z");
});

test("an open failure that is not already-open propagates untouched", async () => {
	const lookups: string[] = [];
	const failure = Object.assign(new Error("invalid record"), { code: "invalid-record" });
	const facility = {
		open: async () => {
			throw failure;
		},
		get: (name: string) => {
			lookups.push(name);
			return undefined;
		},
	};

	await assert.rejects(
		() => openStore({ get: () => facility }),
		(error: unknown) => {
			// The original error, not a rewrap: schema drift must reach the log
			// with its own code intact.
			assert.equal(error, failure);
			assert.equal((error as { code?: string }).code, "invalid-record");
			return true;
		},
	);
	// Nothing was adopted: swallowing this into the hot-reload path would hand
	// back a handle instead of failing.
	assert.deepEqual(lookups, []);
});
