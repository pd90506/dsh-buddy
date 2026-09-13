/**
 * The wiring test: `apply()` must assemble the plugin against a stubbed context.
 *
 * Everything else in this suite tests a module. This one tests the thing that
 * decides whether the plugin exists at all — a `settings.section` registration, an
 * approval listener, a typert contribution, and a boot that reaches the storage
 * domain — because a throw anywhere in `apply()` shows up as a plugin that simply
 * never mounts, with the reason buried in a loader log nobody reads.
 *
 * The stub mirrors exactly the context surface the code touches, including
 * `reflect.provide`, which is where a cordis `Service` publishes itself.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { apply, inject, name } from "../../src/telegram/index.ts";
import { TELEGRAM_TOKEN_KEY } from "../../src/telegram/credential-key.ts";
import { TELEGRAM_TOKEN_REF } from "../../src/telegram/credentials.ts";
import { OCCUPIED_DETAIL } from "../../src/telegram/occupancy.ts";

/** A storage domain stub with one empty table and a global slot. */
function domainStub(): unknown {
	const table = {
		get: () => undefined,
		put: async () => undefined,
		delete: async () => true,
	};
	return {
		name: "buddy_telegram",
		table: () => table,
		global: { get: () => ({ updateOffset: 7 }), set: async () => undefined },
		close: async () => undefined,
	};
}

/** A context stub recording everything `apply()` does. */
function contextStub(services: Record<string, unknown> = {}): {
	ctx: Record<string, unknown>;
	sections: string[];
	listeners: Map<string, unknown>;
	contributions: unknown[];
	provided: Map<string, unknown>;
	disposers: (() => void)[];
	logs: string[];
} {
	const sections: string[] = [];
	const listeners = new Map<string, unknown>();
	const contributions: unknown[] = [];
	const provided = new Map<string, unknown>();
	const disposers: (() => void)[] = [];
	const logs: string[] = [];
	const registry: Record<string, unknown> = {
		// A logger keeps the plugin's diagnostics out of the test output and lets
		// the boot line be asserted instead.
		logger: { info: (line: string) => logs.push(line) },
		typert: { register: (contribution: unknown) => contributions.push(contribution) },
		storageDomain: { open: async () => domainStub(), get: () => undefined },
		credentials: {
			resolve: async () => undefined,
			describe: async () => ({ configured: false, writable: true }),
		},
		settings: {
			installSection: (_owner: unknown, ns: string, _schema: unknown, _entry: unknown, hooks: unknown) => {
				sections.push(ns);
				(hooks as { setSource: (source: () => unknown) => void }).setSource(() => ({
					enabled: false,
					ownerUserId: "",
					defaultCwd: path.join("/tmp", "dsh-telegram-wiring"),
					permissionPreset: "workspace-write",
					renderMarkdown: true,
					mediaDelivery: "all",
				}));
			},
			describe: () => [],
			update: async () => undefined,
		},
		...services,
	};
	const ctx: Record<string, unknown> = {
		get: (service: string) => registry[service],
		on: (event: string, listener: unknown) => {
			listeners.set(event, listener);
			return () => undefined;
		},
		effect: (effect: () => (() => void) | void) => {
			const dispose = effect();
			if (typeof dispose === "function") disposers.push(dispose);
		},
		inject: (_services: string[], callback: (scoped: unknown) => void) => callback(ctx),
		// What `new Service(ctx, key)` needs to publish itself.
		reflect: {
			provide: (serviceName: string, instance: unknown) => {
				provided.set(serviceName, instance);
			},
		},
	};
	// Cordis exposes every injected service both through `ctx.get(name)` and as a
	// property on the context — `scoped.settings?.installSection(...)` takes the
	// property path, so the stub must too.
	Object.assign(ctx, registry);
	return { ctx, sections, listeners, contributions, provided, disposers, logs };
}

/** Let the async boot settle. */
async function settle(): Promise<void> {
	for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

test("the plugin declares its name and hard dependencies", () => {
	assert.equal(name, "dsh-buddy-telegram");
	assert.deepEqual(inject, ["typert", "storageDomain", "buddyStore"]);
});

test("apply registers the settings section, the approval listener and the endpoints", () => {
	const { ctx, sections, listeners, contributions } = contextStub();
	assert.doesNotThrow(() => apply(ctx as never));
	assert.deepEqual(sections, ["buddy-telegram"], "the settings section must be installed under the buddy-telegram namespace");
	assert.ok(listeners.has("approval/request"), "approvals must be answerable from the chat");
	assert.equal(contributions.length, 1, "exactly one typert contribution");
	const contribution = contributions[0] as { invocations: { method: string; namespace: string }[] };
	assert.deepEqual(
		contribution.invocations.map((invocation) => invocation.method).sort(),
		["config", "status", "updateConfig"],
	);
	// The wire namespace rides on each invocation, and it is what the browser
	// side addresses: `buddyTelegram/status`, `buddyTelegram/config`, `buddyTelegram/updateConfig`.
	for (const invocation of contribution.invocations) {
		assert.equal(invocation.namespace, "buddyTelegram");
	}
});

test("the status endpoint answers with posture and no token, before anything runs", async () => {
	const { ctx, provided } = contextStub();
	apply(ctx as never);
	await settle();

	const gateway = provided.get("buddyTelegram") as {
		status(): Promise<{ state: string; sessions: number; token: { configured: boolean; writable: boolean } }>;
	};
	assert.ok(gateway !== undefined, "the gateway must publish itself as the telegram service");

	const status = await gateway.status();
	assert.equal(status.state, "off");
	assert.equal(status.sessions, 0);
	assert.equal(status.token.configured, false);
	assert.equal(status.token.writable, true);
	assert.ok(!JSON.stringify(status).includes("110201543"), "no token value may cross the wire");
});

test("every endpoint's declared parameters match the method it names", () => {
	const { ctx, provided, contributions } = contextStub();
	apply(ctx as never);
	const contribution = contributions[0] as {
		invocations: { method: string; parameters: unknown[] }[];
	};
	const gateway = provided.get("buddyTelegram") as unknown as Record<string, (...args: unknown[]) => unknown>;
	for (const invocation of contribution.invocations) {
		const method = gateway[invocation.method];
		if (method === undefined) assert.fail(`${invocation.method} must exist on the gateway`);
		assert.equal(typeof method, "function", `${invocation.method} must be callable`);
		// The wire passes arguments by name and position, so a method whose
		// signature drifted from its declaration would be called with the wrong
		// shape and fail only in the browser.
		assert.equal(
			method.length,
			invocation.parameters.length,
			`${invocation.method}: declared ${String(invocation.parameters.length)} parameter(s), takes ${String(method.length)}`,
		);
	}
});

test("the host's credential reference is the key the tab writes", () => {
	// One literal, imported by both halves: a rename on either side would leave
	// the bot tokenless while the tab reported it configured.
	assert.equal(String(TELEGRAM_TOKEN_REF), TELEGRAM_TOKEN_KEY);
});

test("a token saved after the switch re-judges the pair", async () => {
	// The bot needs both the enable switch and a token, and the user saves them
	// separately. Re-syncing only on settings changes meant pasting the token after
	// enabling left the bot idle, with nothing on screen to explain it.
	let reads = 0;
	const { ctx, listeners } = contextStub({
		credentials: {
			resolve: async () => {
				reads += 1;
				return undefined;
			},
			describe: async () => ({ configured: false, writable: true }),
		},
	});
	apply(ctx as never);
	await settle();

	const listener = listeners.get("credentials/reference-updated") as ((ref: unknown) => void) | undefined;
	assert.ok(listener !== undefined, "the plugin must watch its own credential");

	const before = reads;
	listener("ANOTHER_PLUGINS_KEY");
	await settle();
	assert.equal(reads, before, "another plugin's credential must not restart this bot");

	listener(TELEGRAM_TOKEN_REF);
	await settle();
	assert.equal(reads, before + 1, "our own token must re-judge the switch/token pair");
});

test("a failing reconcile is logged instead of rejecting into the process", async () => {
	// Both hooks fire without awaiting `sync`, so a rejection there is an unhandled
	// rejection — which Node turns into a process exit. The plugin must contain it.
	let hooks: { setSource(source: () => unknown): void; onChange(): void } | undefined;
	let fail = false;
	const { ctx, logs } = contextStub({
		credentials: {
			resolve: async () => {
				if (fail) throw new Error("credentials provider is down");
				return undefined;
			},
			describe: async () => ({ configured: false, writable: true }),
		},
		settings: {
			installSection: (_owner: unknown, _ns: string, _schema: unknown, _entry: unknown, accepted: unknown) => {
				hooks = accepted as { setSource(source: () => unknown): void; onChange(): void };
				hooks.setSource(() => ({
					enabled: true,
					ownerUserId: "42",
					defaultCwd: "/tmp/x",
					permissionPreset: "workspace-write",
					renderMarkdown: true,
					mediaDelivery: "all",
				}));
			},
			describe: () => [],
			update: async () => undefined,
		},
	});
	apply(ctx as never);
	await settle();

	if (hooks === undefined) assert.fail("the settings section must hand the plugin its hooks");
	fail = true;
	hooks.onChange();
	await settle();

	assert.ok(
		logs.some((line) => line.includes("reconcile failed: credentials provider is down")),
		`the failure must be logged rather than thrown; logs: ${JSON.stringify(logs)}`,
	);
});

test("booting reports what it mounted and what it sees, without values", async () => {
	const { ctx, logs } = contextStub();
	apply(ctx as never);
	await settle();
	const mounted = logs.find((line) => line.includes("mounted"));
	assert.ok(mounted !== undefined, "the boot line is the only thing a user can check when the tab is missing");
	assert.match(mounted, /enabled=false/);
	assert.match(mounted, /token=unset/);
	assert.match(mounted, /owner=unset/);
	assert.match(mounted, /cwd=\//);
});

test("booting does not write settings or start polling while disabled", async () => {
	const updates: unknown[] = [];
	const { ctx } = contextStub({
		settings: {
			installSection: (_owner: unknown, _ns: string, _schema: unknown, _entry: unknown, hooks: unknown) => {
				(hooks as { setSource: (source: () => unknown) => void }).setSource(() => ({
					enabled: false,
					ownerUserId: "42",
					defaultCwd: "/tmp/x",
					permissionPreset: "workspace-write",
					renderMarkdown: true,
					mediaDelivery: "all",
				}));
			},
			describe: () => [],
			update: async (_ns: string, patch: unknown) => {
				updates.push(patch);
			},
		},
	});
	apply(ctx as never);
	await settle();
	assert.deepEqual(updates, [], "booting must not write settings");
});

test("updateConfig forwards only known fields into the settings document (AC-2)", async () => {
	const updates: Record<string, unknown>[] = [];
	const { ctx, provided } = contextStub({
		settings: {
			installSection: (_owner: unknown, _ns: string, _schema: unknown, _entry: unknown, hooks: unknown) => {
				(hooks as { setSource: (source: () => unknown) => void }).setSource(() => ({
					enabled: false,
					ownerUserId: "",
					defaultCwd: "/tmp/x",
					permissionPreset: "workspace-write",
					renderMarkdown: true,
					mediaDelivery: "all",
				}));
			},
			describe: () => [],
			update: async (_ns: string, patch: Record<string, unknown>) => {
				updates.push(patch);
			},
		},
	});
	apply(ctx as never);
	await settle();

	const gateway = provided.get("buddyTelegram") as {
		updateConfig(patch: Record<string, unknown>): Promise<unknown>;
	};
	await gateway.updateConfig({
		enabled: true,
		ownerUserId: "  42  ",
		defaultCwd: "  /tmp/dsh-telegram  ",
		permissionPreset: "read-only",
		renderMarkdown: true,
		mediaDelivery: "all",
		// A malformed client must not be able to stuff arbitrary keys — or a
		// token — into the settings document.
		botToken: "110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw",
		nonsense: 1,
	});

	assert.deepEqual(updates, [
		{
			enabled: true,
			ownerUserId: "42",
			defaultCwd: "/tmp/dsh-telegram",
			permissionPreset: "read-only",
			renderMarkdown: true,
			mediaDelivery: "all",
		},
	]);
	assert.ok(!JSON.stringify(updates).includes("110201543"), "a token must never reach the settings document");

	// A media policy outside the known set, and a non-boolean switch, are both
	// dropped rather than written: the schema owns the vocabulary, and a bad
	// client must not be able to store a value the runtime then has to guess at.
	await gateway.updateConfig({ mediaDelivery: "everything", renderMarkdown: "yes" });
	assert.equal(updates.length, 1, "nothing valid in the second patch means no write at all");
});

test("mounting beside a user-set legacy section migrates it into buddy-telegram, switched off", async () => {
	const updates: { ns: string; patch: unknown }[] = [];
	const { ctx } = contextStub({
		settings: {
			installSection: (_owner: unknown, _ns: string, _schema: unknown, _entry: unknown, hooks: unknown) => {
				(hooks as { setSource: (source: () => unknown) => void }).setSource(() => ({
					enabled: false,
					ownerUserId: "",
					defaultCwd: "/tmp/x",
					permissionPreset: "workspace-write",
					renderMarkdown: true,
					mediaDelivery: "all",
				}));
			},
			describe: () => [
				{ ns: "telegram", user: { ownerUserId: "42", enabled: true } },
				{ ns: "buddy-telegram" },
			],
			update: async (ns: string, patch: unknown) => {
				updates.push({ ns, patch });
			},
		},
	});
	apply(ctx as never);
	await settle();
	assert.deepEqual(updates, [{ ns: "buddy-telegram", patch: { enabled: false, ownerUserId: "42" } }]);
});

test("shutdown unwinds every effect without touching the network", async () => {
	const { ctx, disposers } = contextStub();
	apply(ctx as never);
	await settle();
	assert.ok(disposers.length > 0, "the runtime effect must be registered for disposal");
	assert.doesNotThrow(() => {
		for (const dispose of disposers) dispose();
	});
});

/**
 * Replace `globalThis.fetch` for the duration of `body`, recording every URL it is
 * called with and throwing instead of ever reaching the network.
 *
 * The occupied-state tests combine `enabled: true` with a resolvable token — exactly
 * the pair `sync()` otherwise turns into `runtime.start()`, which calls
 * `TelegramApi.getMe()` over real HTTPS. If the occupancy guard ever regressed, this
 * stub is what stands between that regression and an actual call to
 * `api.telegram.org` from the test suite; it also gives a direct assertion that the
 * runtime was never started, rather than only inferring it from log lines.
 * @param body - the test body to run with the network cut off.
 * @returns the URLs `fetch` was called with, in order (must be empty for these tests).
 */
async function withNoNetwork(body: () => Promise<void>): Promise<string[]> {
	const calls: string[] = [];
	const original = globalThis.fetch;
	globalThis.fetch = (async (input: unknown) => {
		calls.push(typeof input === "string" ? input : String((input as { url?: unknown })?.url ?? input));
		throw new Error("test attempted a network call");
	}) as typeof fetch;
	try {
		await body();
	} finally {
		globalThis.fetch = original;
	}
	return calls;
}

test("stays down and reports occupied while dsh-telegram still polls the bot", async () => {
	// A mounted, enabled dsh-telegram row occupies the token. Buddy's own switch
	// is on and a token would resolve, but the occupancy check runs before the
	// token is ever read, so the runtime must never be asked to start and the
	// status must explain why instead of reporting a plain "off".
	let reads = 0;
	let hooks: { onChange(): void } | undefined;
	const { ctx, provided } = contextStub({
		loader: { entries: () => [{ options: { name: "dsh-telegram" }, disabled: false }] },
		settings: {
			installSection: (_owner: unknown, _ns: string, _schema: unknown, _entry: unknown, accepted: unknown) => {
				hooks = accepted as { onChange(): void };
				(accepted as { setSource: (source: () => unknown) => void }).setSource(() => ({
					enabled: true,
					ownerUserId: "42",
					defaultCwd: "/tmp/x",
					permissionPreset: "workspace-write",
					renderMarkdown: true,
					mediaDelivery: "all",
				}));
			},
			describe: () => [],
			update: async () => undefined,
			get: (ns: string) => (ns === "telegram" ? { enabled: true } : undefined),
		},
		credentials: {
			resolve: async () => {
				reads += 1;
				return { value: "110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw" };
			},
			describe: async () => ({ configured: true, writable: true }),
		},
	});

	const fetchCalls = await withNoNetwork(async () => {
		apply(ctx as never);
		await settle();

		const gateway = provided.get("buddyTelegram") as {
			status(): Promise<{ state: string; detail?: string; sessions: number }>;
		};
		const status = await gateway.status();
		assert.equal(status.state, "error");
		assert.equal(status.detail, OCCUPIED_DETAIL);

		// Boot's own diagnostic line reads the token once regardless (it only reports
		// presence, never starts anything); a reconcile triggered afterwards must not
		// read it again, because `sync()` returns on the occupancy check before ever
		// calling `readToken`.
		const afterBoot = reads;
		if (hooks === undefined) assert.fail("the settings section must hand the plugin its hooks");
		hooks.onChange();
		await settle();
		assert.equal(reads, afterBoot, "the token must never be read again while dsh-telegram still holds the bot");
	});
	assert.deepEqual(fetchCalls, [], "the runtime must never be started (no network call) while occupied");
});

test("the settings/updated listener re-syncs only when the legacy telegram namespace changes", async () => {
	// Wiring test: the listener registered at src/telegram/index.ts:247-250 is what
	// notices the legacy switch turning off without a restart. Nothing else in this
	// suite fires it, so this is the only place a regression there (wrong namespace
	// check, or the listener never registered at all) would be caught.
	let legacyEnabled = true;
	// `sync()` reads the config source unconditionally as its very first line,
	// before either the occupancy check or the enable/token check, so counting
	// calls to the source function is a direct, branch-independent count of how
	// many times `sync()` ran — a resync that never happened leaves this alone,
	// regardless of what occupied/enabled end up deciding.
	let configReads = 0;
	const { ctx, provided, listeners } = contextStub({
		loader: { entries: () => [{ options: { name: "dsh-telegram" }, disabled: false }] },
		settings: {
			installSection: (_owner: unknown, _ns: string, _schema: unknown, _entry: unknown, accepted: unknown) => {
				(accepted as { setSource: (source: () => unknown) => void }).setSource(() => {
					configReads += 1;
					return {
						enabled: true,
						ownerUserId: "42",
						defaultCwd: "/tmp/x",
						permissionPreset: "workspace-write",
						renderMarkdown: true,
						mediaDelivery: "all",
					};
				});
			},
			describe: () => [],
			update: async () => undefined,
			get: (ns: string) => (ns === "telegram" ? { enabled: legacyEnabled } : undefined),
		},
		credentials: {
			// No token: once the occupancy clears, `sync()` still must not reach the
			// network from this test — that path is covered by the occupied-state
			// test above. This test only exercises whether the listener re-syncs.
			resolve: async () => undefined,
			describe: async () => ({ configured: false, writable: true }),
		},
	});

	const fetchCalls = await withNoNetwork(async () => {
		apply(ctx as never);
		await settle();

		const gateway = provided.get("buddyTelegram") as {
			status(): Promise<{ state: string; detail?: string; sessions: number }>;
		};
		assert.equal((await gateway.status()).detail, OCCUPIED_DETAIL, "starts occupied");

		const listener = listeners.get("settings/updated") as ((ns: unknown) => void) | undefined;
		if (listener === undefined) assert.fail("the plugin must watch settings/updated to notice the legacy switch");

		// An unrelated namespace changing must not re-judge anything.
		const beforeUnrelated = configReads;
		listener("other");
		await settle();
		assert.equal(configReads, beforeUnrelated, "an unrelated namespace must not trigger a resync");
		assert.equal((await gateway.status()).detail, OCCUPIED_DETAIL, "an unrelated namespace must not change status");

		// The legacy bot is switched off from outside; only the listener firing for
		// "telegram" tells this plugin to look again.
		legacyEnabled = false;
		const beforeRelated = configReads;
		listener("telegram");
		await settle();
		assert.ok(configReads > beforeRelated, "the telegram namespace must trigger a resync");
		const status = await gateway.status();
		assert.notEqual(status.detail, OCCUPIED_DETAIL, "the occupancy must clear once the legacy switch is off");
	});
	assert.deepEqual(fetchCalls, [], "no network call while the occupancy transition is exercised");
});
