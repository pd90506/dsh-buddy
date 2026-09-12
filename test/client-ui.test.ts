/**
 * The browser half's registration contract.
 *
 * What most often breaks an out-of-tree settings tab is not its markup — it is
 * the registration: a missing `inject`, a wrong slot name, an id that collides,
 * a label that bypasses the plugin's own locale namespace, or a dictionary that
 * was registered outside an effect and so survives teardown. Each of those
 * shows up in the browser as a tab that never appears, or one that cannot be
 * unmounted, and none of them is visible in a source-level test.
 *
 * So this asserts against the **built** `lib/client.js`, loaded through the same
 * `window.__ModuleLoader__` envelope the browser boot graph uses, and drives the
 * real `apply` against a recording context. Asserting on the artifact also
 * proves the browser half actually compiles: no test in this plan may import a
 * `.tsx` module, because Node's type stripping does not handle JSX. `pretest`
 * runs the build, so the artifact is present whenever `npm test` runs.
 *
 * The RPC envelope unwrap lives in `src/client/call.ts` — plain `.ts` precisely
 * so it can be driven directly here rather than only through a React tree this
 * repo has no renderer for.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { MAIN_PANEL_KEY } from "../src/index.ts";
import { createCall } from "../src/client/call.ts";

/** The browser plugin object the bundle's factory returns. */
interface ClientPlugin {
	readonly inject: string[];
	apply(ctx: unknown): void;
	/** Re-exported shared constant; see `src/client/index.tsx`. */
	readonly MAIN_PANEL_KEY: string;
}

/** A `settings.section` registration, as the slot service receives it. */
interface SectionOptions {
	readonly name: string;
	readonly id: string;
	readonly order: number;
	readonly locale: string;
	readonly label: () => string;
}

/** One recorded slot registration. */
interface Registration {
	readonly options: SectionOptions;
	readonly component: unknown;
}

/** One recorded dictionary registration. */
interface Dictionary {
	readonly ns: string;
	readonly dictionary: Record<string, unknown>;
	/** Whether `locale.register` was reached from inside a `ctx.effect` body. */
	readonly insideEffect: boolean;
}

/** Everything the stub context observed. */
interface Recorded {
	readonly ctx: Record<string, unknown>;
	readonly registrations: Registration[];
	readonly injected: string[];
	readonly effects: string[];
	readonly dictionaries: Dictionary[];
}

/** The built bundle, as text. */
async function bundleText(): Promise<string> {
	return await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
}

/** The bundle is evaluated once; `require` caches it, so the factory result is memoized here. */
let loaded: ClientPlugin | undefined;

/**
 * Load `lib/client.js` the way the browser boot graph does.
 * @returns the plugin object the bundle's factory returns.
 */
function loadClient(): ClientPlugin {
	if (loaded !== undefined) return loaded;
	const require = createRequire(import.meta.url);
	let captured: { id: string; factory: (resolve: (name: string) => unknown) => unknown } | undefined;
	(globalThis as unknown as { window: unknown }).window = {
		__ModuleLoader__: {
			load: (module: { id: string; factory: (resolve: (name: string) => unknown) => unknown }) => {
				captured = module;
			},
		},
	};
	require("../lib/client.js");
	assert.ok(captured !== undefined, "the bundle must call window.__ModuleLoader__.load");
	assert.equal(captured.id, "dsh-buddy", "the module id must match the package name");
	loaded = captured.factory((name: string) => require(name)) as ClientPlugin;
	return loaded;
}

/**
 * A browser-side context stub that records every contribution.
 * @param options - `runSlotCallback: false` models a shell with no settings slot.
 * @returns the stub context and its recordings.
 */
function contextStub(options: { runSlotCallback?: boolean } = {}): Recorded {
	const runSlotCallback = options.runSlotCallback ?? true;
	const registrations: Registration[] = [];
	const injected: string[] = [];
	const effects: string[] = [];
	const dictionaries: Dictionary[] = [];
	let depth = 0;

	const ctx: Record<string, unknown> = {
		get: (name: string) =>
			name === "connection" ? { rpc: { call: async () => ({ ok: true, value: {} }) } } : undefined,
		effect: (body: () => unknown, label: string) => {
			effects.push(label);
			depth += 1;
			try {
				return body();
			} finally {
				depth -= 1;
			}
		},
		locale: {
			// A label built from the namespace proves it resolved through this
			// plugin's own bound lookup rather than a bare global key.
			bind: (ns: string) => (key: string) => `${ns}:${key}`,
			register: (ns: string, dictionary: Record<string, unknown>) => {
				dictionaries.push({ ns, dictionary, insideEffect: depth > 0 });
				return () => {};
			},
		},
		slots: {
			inject: (name: string, callback: () => unknown) => {
				injected.push(name);
				if (runSlotCallback) callback();
			},
			register: (sectionOptions: SectionOptions, component: unknown) => {
				registrations.push({ options: sectionOptions, component });
				return () => {};
			},
		},
		layout: { selectPanel: () => {} },
		sessions: {},
	};
	return { ctx, registrations, injected, effects, dictionaries };
}

test("the browser half is wrapped in the module-loader factory", async () => {
	const text = await bundleText();
	assert.match(text, /^window\.__ModuleLoader__\.load\(\{/);
	// The envelope is only real if evaluating the bundle actually calls `load`
	// and the factory hands back a mountable plugin.
	const client = loadClient();
	assert.equal(typeof client.apply, "function");
});

test("the browser half injects slots, locale, connection, layout and sessions", () => {
	const client = loadClient();
	// The settings tab itself only needs the first three. `layout` and `sessions`
	// are declared now because the sidebar/main pair task 8 appends to this same
	// `apply` needs them, and `inject` is per-fiber rather than per-registration:
	// one list, declared once, so the pair cannot mount half-wired. Every one of
	// these is present in the web shell, so the wait never becomes a stall.
	assert.deepEqual(client.inject, ["slots", "locale", "connection", "layout", "sessions"]);
});

test("the settings tab registers into settings.section with a stable id, order and namespaced label", () => {
	const client = loadClient();
	const { ctx, registrations, injected } = contextStub();
	client.apply(ctx);

	assert.deepEqual(injected, ["settings.section"], "the tab must go into the settings left nav");
	assert.equal(registrations.length, 1, "task 7 contributes the settings section and nothing else");
	const registration = registrations[0];
	assert.ok(registration !== undefined);
	assert.equal(registration.options.name, "settings.section");
	assert.equal(registration.options.id, "buddy");
	assert.equal(registration.options.locale, "settings.buddy");
	// The nav is sorted by a bare numeric comparator with no tie-breaker, so the
	// order must not collide with a neighbour: Telegram takes 26, Plugin Market 40.
	assert.equal(registration.options.order, 27);
	assert.equal(registration.options.label(), "settings.buddy:nav", "the label must resolve through the bound namespace");
	assert.equal(typeof registration.component, "function");
});

test("the settings section is not registered when the shell has no settings slot", () => {
	const client = loadClient();
	const { ctx, registrations, injected } = contextStub({ runSlotCallback: false });
	client.apply(ctx);

	assert.deepEqual(injected, ["settings.section"]);
	assert.equal(registrations.length, 0, "registration must be gated on slots.inject, not unconditional");
});

test("both dictionaries are registered, as a reversible effect", () => {
	const client = loadClient();
	const { ctx, dictionaries, effects } = contextStub();
	client.apply(ctx);

	assert.equal(dictionaries.length, 1);
	const entry = dictionaries[0];
	assert.ok(entry !== undefined);
	assert.equal(entry.ns, "settings.buddy");
	assert.equal(entry.insideEffect, true, "dictionaries must be registered through ctx.effect so teardown removes them");
	assert.ok(
		effects.some((label) => label.includes("dsh-buddy")),
		"every effect must be attributable to this plugin",
	);

	const english = entry.dictionary["en"] as Record<string, unknown> | undefined;
	const chinese = entry.dictionary["zh"] as Record<string, unknown> | undefined;
	assert.ok(english !== undefined && chinese !== undefined, "en and zh are both required");
	assert.deepEqual(Object.keys(english).sort(), Object.keys(chinese).sort(), "the dictionaries must stay in step");
	assert.equal(english["nav"], "Buddy");
	for (const key of ["soulTitle", "soulHint", "rulesTitle", "rulesHint", "save", "homeLabel"]) {
		assert.equal(typeof english[key], "string", `en.${key} is used by the tab`);
		assert.equal(typeof chinese[key], "string", `zh.${key} is used by the tab`);
	}
});

test("the shared panel key is one constant, carried into the browser artifact", () => {
	assert.equal(MAIN_PANEL_KEY, "dsh-buddy");
	// The sidebar list id and the main panel key are the same string; the browser
	// half must take it from `src/index.ts` rather than restating it, or task 8's
	// button and panel can drift apart. Reading it off the built artifact is what
	// proves the import survived bundling.
	assert.equal(loadClient().MAIN_PANEL_KEY, "dsh-buddy");
});

test("the RPC caller addresses the api route and unwraps the payload", async () => {
	const seen: { route: string; endpoint: string; payload: unknown }[] = [];
	const call = createCall({
		call: async (route: string, endpoint: string, payload: unknown) => {
			seen.push({ route, endpoint, payload });
			return { ok: true, value: { soul: "s", agents: "a", home: "/h" } };
		},
	});

	const value = await call("buddyPersona/updatePersona", { patch: { soul: "s" } });
	assert.deepEqual(value, { soul: "s", agents: "a", home: "/h" });
	assert.deepEqual(seen, [
		{ route: "/api", endpoint: "buddyPersona/updatePersona", payload: { args: { patch: { soul: "s" } } } },
	]);
});

test("an RPC failure throws instead of being mistaken for a payload", async () => {
	const call = createCall({
		call: async () => ({ ok: false, error: { code: "ENOENT", message: "no such file" } }),
	});
	await assert.rejects(
		async () => await call("buddyPersona/persona", {}),
		/buddyPersona\/persona failed: ENOENT: no such file/,
	);
});

test("an envelope that is not a success throws even when it carries no error", async () => {
	for (const answer of [undefined, null, {}, { ok: false }, { value: { soul: "" } }]) {
		const call = createCall({ call: async () => answer });
		await assert.rejects(
			async () => await call("buddyPersona/persona", {}),
			/buddyPersona\/persona failed/,
			`a ${JSON.stringify(answer) ?? "undefined"} answer must not resolve`,
		);
	}
});
