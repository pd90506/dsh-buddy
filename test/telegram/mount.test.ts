/**
 * The mount test: `apply()` inside a real cordis app.
 *
 * `plugin.test.ts` assembles the plugin against a hand-written stub — fast, and
 * precise about what wiring happens, but it has no cordis rules: reading a service
 * as a plain property (`ctx.settings`) works there and fails in production.
 *
 * In a real composition the services belong to *sibling* fibers, which is what
 * arms cordis's inject Guard (`Reflect.has(target, prop)` is false, the fiber store
 * has no entry because the plugin never declared the dependency, and the read
 * throws). The live tab's Save button was the first thing to find out:
 *
 *     gateway/internal: cannot get property "settings" without inject
 *
 * So this file mounts the real plugin next to real sibling service plugins and lets
 * cordis's own resolution decide. Both live failures are covered here — the Guard
 * above, and the service proxy that broke every endpoint before it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { apply, inject, name } from "../../src/telegram/index.ts";
import type { TelegramConfig } from "../../src/telegram/config.ts";
import { FALLBACK_CONFIG } from "../../src/config.ts";

/** The configuration the fake settings service hands the plugin. */
const CONFIG: TelegramConfig = {
	enabled: false,
	ownerUserId: "42",
	defaultCwd: "/tmp/dsh-telegram",
	permissionPreset: "workspace-write",
	renderMarkdown: true,
	mediaDelivery: "all",
};

/** A storage domain stub with one empty table and a global slot. */
function domainStub(): unknown {
	const table = { get: () => undefined, put: async () => undefined, delete: async () => true };
	return {
		name: "buddy_telegram",
		table: () => table,
		global: { get: () => ({ updateOffset: 0 }), set: async () => undefined },
		close: async () => undefined,
	};
}

/** What the test needs to observe from outside the plugin. */
interface Mounted {
	/** The gateway as `ctx.get` hands it out (a proxy, not the instance). */
	readonly service: Record<string, (...args: unknown[]) => unknown>;
	/** Settings sections installed, by namespace. */
	readonly sections: string[];
	/** Patches that reached the settings plane. */
	readonly patches: { ns: string; patch: Record<string, unknown> }[];
}

/** Let the plugin's asynchronous boot settle. */
async function settle(): Promise<void> {
	for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Mount the plugin beside sibling service plugins on a real context.
 * @returns the published service and what the fake services recorded.
 */
async function mount(): Promise<Mounted> {
	const root = new Context();
	const sections: string[] = [];
	const patches: { ns: string; patch: Record<string, unknown> }[] = [];
	const sibling = (pluginName: string, provide: (ctx: unknown) => void): void => {
		(root as unknown as { plugin(plugin: unknown): unknown }).plugin({
			name: pluginName,
			apply: (ctx: unknown) => {
				provide(ctx);
			},
		});
	};

	sibling("fake-typert", (ctx) => {
		(ctx as { reflect: { provide(name: string, value: unknown): void } }).reflect.provide("typert", {
			register: () => undefined,
		});
	});
	sibling("fake-storage", (ctx) => {
		(ctx as { reflect: { provide(name: string, value: unknown): void } }).reflect.provide("storageDomain", {
			open: async () => domainStub(),
			get: () => undefined,
		});
	});
	sibling("fake-buddy-store", (ctx) => {
		(ctx as { reflect: { provide(name: string, value: unknown): void } }).reflect.provide("buddyStore", {
			paths: { home: "/tmp/buddy" },
			config: () => FALLBACK_CONFIG,
		});
	});
	sibling("fake-settings", (ctx) => {
		(ctx as { reflect: { provide(name: string, value: unknown): void } }).reflect.provide("settings", {
			installSection: (
				_owner: unknown,
				ns: string,
				_schema: unknown,
				_entry: unknown,
				hooks: { setSource(source: () => TelegramConfig): void },
			) => {
				sections.push(ns);
				hooks.setSource(() => CONFIG);
			},
			update: async (ns: string, patch: Record<string, unknown>) => {
				patches.push({ ns, patch });
			},
		});
	});

	(root as unknown as { plugin(plugin: unknown): unknown }).plugin({ name, inject, apply });
	await settle();
	return {
		service: root.get("buddyTelegram") as unknown as Record<string, (...args: unknown[]) => unknown>,
		sections,
		patches,
	};
}

/** Call one endpoint the way the api-gateway does: applied with the proxy as `this`. */
function dispatch(service: Record<string, (...args: unknown[]) => unknown>, method: string, args: unknown[]): unknown {
	const found = service[method];
	if (typeof found !== "function") assert.fail(`${method} must be callable on the service`);
	return Reflect.apply(found, service, args);
}

test("apply mounts on a real cordis context and publishes the endpoints", async () => {
	const { service } = await mount();
	assert.notEqual(service, undefined, "the gateway must publish itself as the telegram service");
	for (const method of ["config", "status", "updateConfig"]) {
		assert.equal(typeof service[method], "function", `${method} must be callable through the service`);
	}
});

test("the settings section is installed through the scoped injection", async () => {
	const { sections } = await mount();
	assert.deepEqual(sections, ["buddy-telegram"]);
});

test("the bot starts once credentials become active (live autostart regression)", async () => {
	// The live failure: after a restart the tab reported `Stopped · 0 session(s)`
	// with an empty detail — the tell that `start()` was never attempted — even
	// though `enabled: true` and a valid token were both configured.
	//
	// The cause is not a missing registration but cordis's own readiness rule:
	// `ctx.get(name)` defaults to `strict = true` and returns undefined unless the
	// *providing fiber is active* (`cordis/lib/index.js`: `if (strict &&
	// impl.fiber.state !== 2) return`). At boot the credentials provider has not
	// reached that state, so `readToken` saw no token, `sync()` took the "no token"
	// branch and stopped — and nothing re-ran it afterwards, because
	// `credentials/reference-updated` only fires on a *write*.
	//
	// So the provider here is mounted *after* the plugin, which is exactly the
	// condition that makes a strict read miss it.
	const root = new Context();
	const started: string[] = [];
	const plugin = (root as unknown as { plugin(plugin: unknown, config?: unknown): unknown }).plugin.bind(root);

	plugin({
		name: "fake-typert",
		apply: (ctx: any) => ctx.reflect.provide("typert", { register: () => undefined }),
	});
	plugin({
		name: "fake-storage",
		apply: (ctx: any) =>
			ctx.reflect.provide("storageDomain", { open: async () => domainStub(), get: () => undefined }),
	});
	plugin({
		name: "fake-buddy-store",
		apply: (ctx: any) => ctx.reflect.provide("buddyStore", { paths: { home: "/tmp/buddy" }, config: () => FALLBACK_CONFIG }),
	});
	plugin({
		name: "fake-settings",
		apply: (ctx: any) =>
			ctx.reflect.provide("settings", {
				installSection: (_o: unknown, ns: string, _s: unknown, _e: unknown, hooks: any) => {
					hooks.setSource(() => ({ ...CONFIG, enabled: true }));
				},
				update: async () => undefined,
			}),
	});

	plugin({ name, inject, apply });
	await settle();

	// Before credentials exist the bot must stay down: this is correct behaviour,
	// not the bug — there is genuinely no token to start with yet.
	assert.equal(started.length, 0, "nothing to start before a credentials service exists");

	// Now the provider arrives and its fiber becomes active.
	plugin({
		name: "fake-credentials",
		apply: (ctx: any) =>
			ctx.reflect.provide("credentials", {
				resolve: async () => {
					started.push("resolved");
					return { value: "110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw" };
				},
				describe: async () => ({ configured: true, writable: true }),
			}),
	});
	await settle();

	// The regression: without a readiness-scoped re-sync the plugin never looks at
	// the token again, so `resolve` is never called and the bot stays stopped.
	assert.ok(started.length > 0, "the plugin must re-read the token once credentials become active");
});

test("updateConfig reaches the settings plane (live Guard failure regression)", async () => {
	const { service, patches } = await mount();
	const after = await dispatch(service, "updateConfig", [
		{
			enabled: true,
			ownerUserId: "  42  ",
			defaultCwd: "  /tmp/dsh-telegram  ",
			botToken: "110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw",
			nonsense: 1,
		},
	]);
	// `ctx.settings` instead of `ctx.get("settings")` used to throw here instead:
	// `cannot get property "settings" without inject`.
	assert.deepEqual(patches, [
		{ ns: "buddy-telegram", patch: { enabled: true, ownerUserId: "42", defaultCwd: "/tmp/dsh-telegram" } },
	]);
	assert.ok(!JSON.stringify(patches).includes("110201543"), "a token must never reach the settings plane");
	assert.deepEqual(after, CONFIG, "the endpoint answers with the section the settings service reports");
});
