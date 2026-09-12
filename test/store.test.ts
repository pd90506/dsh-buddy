import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import type { Plugin } from "@deepseek-ai/cordis";
import * as row from "../src/store/index.ts";
import { BuddyStore } from "../src/store/index.ts";
import type { BuddyDomainHandle, BuddyGlobal } from "../src/store/domain.ts";

/** A domain stand-in plus the flags a test needs to read back. */
interface HandleStub extends BuddyDomainHandle {
	closed: boolean;
}

/**
 * @param initial - the global the stand-in starts with.
 * @returns a {@link BuddyDomainHandle} backed by memory.
 */
function handleStub(initial: BuddyGlobal = {}): HandleStub {
	let global: BuddyGlobal = initial;
	const stub: HandleStub = {
		global: {
			get: () => global,
			set: async (next) => {
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

/**
 * Spin the event loop until `predicate` holds, so a test never depends on a
 * fixed sleep for cordis's asynchronous activation.
 * @param predicate - the condition to wait for.
 * @returns resolution once it holds.
 * @throws when it never holds.
 */
async function until(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.fail("condition never held");
}

/**
 * Give cordis and any pending microtask chain ample room to run, so a "nothing
 * happened" assertion is a real observation rather than one made before the
 * work had a chance to start.
 * @returns resolution after several event-loop turns.
 */
async function settle(): Promise<void> {
	for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

/**
 * The row as cordis loads it. The module types `apply` against its own narrow
 * `PluginContext` rather than cordis's `Context`, which is deliberate (it keeps
 * the row from depending on the settings types) but leaves the module not
 * *statically* assignable to `Plugin`. Mounting it here exercises the real
 * loader path, which is what the cast buys.
 */
const storeRow = row as unknown as Plugin;

/**
 * Point `$DSH_HOME` at a throwaway directory for one test.
 * @returns the temporary harness home and its restore function.
 */
function scratchHome(): { home: string; restore: () => void } {
	const previous = process.env["DSH_HOME"];
	const home = mkdtempSync(join(tmpdir(), "dsh-buddy-store-"));
	process.env["DSH_HOME"] = home;
	return {
		home,
		restore: () => {
			if (previous === undefined) delete process.env["DSH_HOME"];
			else process.env["DSH_HOME"] = previous;
		},
	};
}

test("the row names itself and declares storageDomain as its only hard dependency", () => {
	assert.equal(row.name, "dsh-buddy-store");
	// `settings` must stay soft: listing it here would keep the row in waiting
	// forever in a profile without the settings plane.
	assert.deepEqual(row.inject, ["storageDomain"]);
});

test("every service member survives cordis's traceable proxy", async () => {
	const ctx = new Context();
	const handle = handleStub();
	const paths = { home: "/tmp/x", soul: "/tmp/x/SOUL.md", agents: "/tmp/x/AGENTS.md" };
	new BuddyStore(ctx as unknown as Context, paths, handle);

	// Consumers never hold the raw instance: cordis dispatches through a proxy
	// with a shadow receiver, which a `#`-private field would make unreachable.
	const store = ctx.get("buddyStore") as BuddyStore;
	assert.notEqual(store, undefined);
	assert.equal(store.lastPersonaWriteAt(), undefined);
	await store.markPersonaWritten("2026-01-01T00:00:00.000Z");
	assert.equal(store.lastPersonaWriteAt(), "2026-01-01T00:00:00.000Z");
	assert.equal(store.paths.soul, "/tmp/x/SOUL.md");
	// The write reached the domain, not just a field on the instance.
	assert.equal(handle.global.get().lastPersonaWriteAt, "2026-01-01T00:00:00.000Z");
});

test("marking a persona write leaves the rest of the global alone", async () => {
	const ctx = new Context();
	const handle = handleStub({ lastPersonaWriteAt: "2026-01-01T00:00:00.000Z" });
	// A future field must survive the write; a bare `set({ lastPersonaWriteAt })`
	// would silently drop it.
	(handle.global.get() as Record<string, unknown>)["future"] = "keep me";
	const store = new BuddyStore(
		ctx as unknown as Context,
		{ home: "/tmp/x", soul: "/tmp/x/SOUL.md", agents: "/tmp/x/AGENTS.md" },
		handle,
	);

	await store.markPersonaWritten("2026-02-02T00:00:00.000Z");

	assert.deepEqual(handle.global.get(), {
		future: "keep me",
		lastPersonaWriteAt: "2026-02-02T00:00:00.000Z",
	});
});

test("the row waits for storageDomain, then creates the home and publishes the service", async () => {
	const scratch = scratchHome();
	const ctx = new Context();
	const handle = handleStub();
	try {
		const fiber = ctx.plugin(storeRow);
		await settle();
		// No storageDomain yet: the hard dependency keeps the row in waiting.
		assert.equal(ctx.get("buddyStore"), undefined);
		assert.equal(existsSync(join(scratch.home, "buddy")), false);

		ctx.provide("storageDomain", {
			open: async () => ({ name: "buddy", global: handle.global, close: handle.close }),
			get: () => undefined,
		});
		await until(() => ctx.get("buddyStore") !== undefined);

		const store = ctx.get("buddyStore") as BuddyStore;
		// No settings plane is mounted here, and the row still boots on the
		// documented default home.
		assert.equal(store.paths.home, join(scratch.home, "buddy"));
		assert.equal(existsSync(store.paths.home), true, "the buddy home must exist after boot");

		await fiber.dispose();
		await until(() => handle.closed);
		// The effect disposer releases the domain and withdraws the service.
		assert.equal(handle.closed, true);
		assert.equal(ctx.get("buddyStore"), undefined);
	} finally {
		scratch.restore();
	}
});

test("a store that cannot open publishes nothing and says why", async () => {
	const scratch = scratchHome();
	const ctx = new Context();
	const logged: string[] = [];
	const previousError = console.error;
	console.error = (message: unknown) => {
		logged.push(String(message));
	};
	try {
		ctx.plugin(storeRow);
		ctx.provide("storageDomain", {
			open: async () => {
				throw Object.assign(new Error("invalid record"), { code: "invalid-record" });
			},
			get: () => undefined,
		});
		await until(() => logged.length > 0);

		// Half-mounting is worse than waiting: dependents must not see a store
		// whose domain never opened.
		assert.equal(ctx.get("buddyStore"), undefined);
		assert.equal(logged.length, 1);
		assert.match(logged[0] ?? "", /dsh-buddy-store: boot failed: invalid record/);
	} finally {
		console.error = previousError;
		scratch.restore();
	}
});
