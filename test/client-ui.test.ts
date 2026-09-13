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
import {
	bundleText,
	clientSourceText,
	loadClient,
	contextStub,
	createRenderer,
	elements,
	settle,
	type StubElement,
	type RecordedCall,
	type SectionOptions,
	type MainPanelOptions,
} from "./support/client-harness.ts";

/** Node's `require`, used as the default module resolver for a stubbed renderer. */
const nodeRequire = createRequire(import.meta.url);

/** A mounted settings tab and what its RPC client saw. */
interface MountedTab {
	/** Every call the tab made, in order. */
	readonly calls: RecordedCall[];
	/** The element tree of the most recent render. */
	tree(): unknown;
	/** The save button of the most recent render. */
	saveButton(): StubElement;
}

/**
 * Mount the real settings tab: `apply` builds it, so the component under test is
 * the registered one, wired to the plugin's own envelope unwrap.
 * @param answer - the gateway envelope (or rejection) for each endpoint.
 * @returns the mounted tab handle.
 */
function mountSettingsTab(answer: (endpoint: string) => Promise<unknown>): MountedTab {
	const renderer = createRenderer();
	const calls: RecordedCall[] = [];
	const client = loadClient((name) => renderer.modules[name] ?? nodeRequire(name));
	const { ctx, registrations } = contextStub({
		rpc: {
			call: async (route: string, endpoint: string, payload: unknown) => {
				calls.push({ route, endpoint, payload });
				return await answer(endpoint);
			},
		},
	});
	client.apply(ctx);

	const registration = registrations.find((r) => r.options.name === "settings.section");
	assert.ok(registration !== undefined, "the settings section must be registered");
	renderer.mount(registration.component as () => unknown);

	return {
		calls,
		tree: () => renderer.tree(),
		saveButton(): StubElement {
			const button = elements(renderer.tree()).find((element) => element.type === "button");
			assert.ok(button !== undefined, "the tab must render a save button");
			return button;
		},
	};
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

test("every cordis-injected service has its real declaring package in dsh.client.inject, with no exemption", async () => {
	// `dsh.client.inject` is NOT a per-service provider contract — it is a bundle
	// arrival-order list (@deepseek-ai/dsh-client-modules/lib/client.js:265-268
	// iterates `row.inject` and looks each name up in the loaded graph; a name
	// absent from the graph is silently skipped). That silence is exactly how two
	// phantom entries survived in this manifest since task 1: `dsh-client-runtime`
	// (never an installable package) and `dsh-client-ui-slots` (a types-only
	// import name — the real owner of `ctx.slots` is `dsh-client-ui-renderer`,
	// confirmed by reading its `declare module '@deepseek-ai/cordis' { interface
	// Context { slots: SlotRegistry } }`). Neither ever broke anything, because
	// the renderer sets `immediately: true` and always arrives early regardless
	// of who lists it — which is also why the wrong name went unnoticed.
	//
	// This test cannot check "is this package actually installed and does its
	// package.json declare dsh.client" from inside this repo: that lives in the
	// harness's own vendored tree at a machine-specific path outside this
	// plugin's dependency graph (this repo's own package.json never installs the
	// browser-side @deepseek-ai/dsh-client-* packages — the harness supplies
	// them), so hardcoding that path here would be either non-portable or
	// silently vacuous in a different checkout. What it DOES check: every cordis
	// service this plugin hard-declares in `inject` (`export const inject` in
	// src/client/index.tsx) has its real declaring package — each confirmed by
	// reading that package's own Context augmentation, recorded in the task-8 fix
	// reports — present in the manifest. The map has NO exemptions on purpose:
	// omitting one (as `slots` was, the first time) is exactly the gap that let a
	// wrong entry through uncaught, so an unmapped service now fails loudly
	// instead of being silently skipped.
	const client = loadClient();
	const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
		dsh: { client: { inject: string[] } };
	};
	const declared = pkg.dsh.client.inject;

	const provider: Record<string, string> = {
		slots: "@deepseek-ai/dsh-client-ui-renderer",
		locale: "@deepseek-ai/dsh-client-locale",
		connection: "@deepseek-ai/dsh-client-connection",
		layout: "@deepseek-ai/dsh-client-ui-layout",
		sessions: "@deepseek-ai/dsh-api-session-controller",
	};

	for (const service of client.inject) {
		const expected = provider[service];
		assert.ok(
			expected !== undefined,
			`no declaring package recorded for cordis service "${service}" — add it to this map, do not skip it`,
		);
		assert.ok(
			declared.includes(expected),
			`cordis inject "${service}" has no declaring package (${expected}) in dsh.client.inject`,
		);
	}
	// The map must track `inject` exactly, not a superset with a stale leftover
	// from a service this plugin no longer depends on.
	assert.deepEqual(Object.keys(provider).sort(), [...client.inject].sort());
});

test("the settings tab registers into settings.section with a stable id, order and namespaced label", () => {
	const client = loadClient();
	const { ctx, registrations, injected } = contextStub();
	client.apply(ctx);

	// Task 8 adds the "main" and "sidebar.panellist" pair alongside task 7's
	// settings tab; those are asserted separately below, so here only the count
	// and the settings.section entry itself are pinned.
	assert.deepEqual(injected, ["settings.section", "main", "sidebar.panellist"]);
	assert.equal(registrations.length, 3, "settings.section, main and sidebar.panellist — nothing else");
	const registration = registrations.find((r) => r.options.name === "settings.section");
	assert.ok(registration !== undefined);
	const options = registration.options as SectionOptions;
	assert.equal(options.id, "buddy");
	assert.equal(options.locale, "settings.buddy");
	// The nav is sorted by a bare numeric comparator with no tie-breaker, so the
	// order must not collide with a neighbour: Telegram takes 26, Plugin Market 40.
	assert.equal(options.order, 27);
	assert.equal(options.label(), "settings.buddy:nav", "the label must resolve through the bound namespace");
	assert.equal(typeof registration.component, "function");
});

test("the main panel and the sidebar button are registered as one pair, addressed by the shared key", () => {
	const client = loadClient();
	const { ctx, registrations } = contextStub();
	client.apply(ctx);

	const main = registrations.find((r) => r.options.name === "main");
	assert.ok(main !== undefined, "the generator-shaped main registration must actually run, not just be injected");
	assert.equal((main.options as MainPanelOptions).key, MAIN_PANEL_KEY);
	assert.equal(typeof main.component, "function");

	const button = registrations.find((r) => r.options.name === "sidebar.panellist");
	assert.ok(button !== undefined);
	const buttonOptions = button.options as SectionOptions;
	// This is the pairing itself: the sidebar addresses the main panel by this
	// same id, so a drift here is a button that throws on click in the browser.
	assert.equal(buttonOptions.id, MAIN_PANEL_KEY);
	assert.equal((main.options as MainPanelOptions).key, buttonOptions.id, "the button's id and the panel's key must be the same string");
	// Left-column render order is panellist → workspaces → settings → footer, so
	// any order here lands above Settings; this only pins it away from 0/undefined.
	assert.equal(buttonOptions.order, 10);
	assert.equal(buttonOptions.locale, "settings.buddy");
	assert.equal(buttonOptions.label(), "settings.buddy:nav", "the label must resolve through the bound namespace");
	assert.equal(typeof button.component, "function");
});

test("no registration happens when the shell has none of the matching slots", () => {
	const client = loadClient();
	const { ctx, registrations, injected } = contextStub({ runSlotCallback: false });
	client.apply(ctx);

	assert.deepEqual(injected, ["settings.section", "main", "sidebar.panellist"]);
	assert.equal(registrations.length, 0, "every registration must be gated on slots.inject, not unconditional");
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

test("the browser half takes the shared panel key from src/index.ts and never restates it", async () => {
	assert.equal(MAIN_PANEL_KEY, "dsh-buddy");

	// The sidebar list id and the main panel key are the same string, so task 8's
	// button and the panel it selects must read one constant or they can drift
	// apart — and nothing catches that drift until `selectPanel` throws in a
	// browser.
	//
	// "Imported rather than redeclared" is a property of the *source*: bundling
	// inlines the value either way, so no assertion against `lib/client.js` can
	// tell a hand-restated constant from the shared one. Hence the source text —
	// read as a string, which is not importing a `.tsx` module.
	const source = await clientSourceText();
	assert.match(
		source,
		/import\s*\{[^}]*\bMAIN_PANEL_KEY\b[^}]*\}\s*from\s*"\.\.\/index\.ts"/,
		"the browser half must import MAIN_PANEL_KEY from the shared constants module",
	);
	assert.doesNotMatch(
		source,
		/(?:const|let|var)\s+MAIN_PANEL_KEY/,
		"the browser half must never declare its own MAIN_PANEL_KEY",
	);
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

test("a persona that failed to load cannot be saved back over the files", async () => {
	// The drafts start empty and are filled by the mount load. If that load fails
	// — a dead endpoint, a host error, exactly what the envelope unwrap exists to
	// surface — saving would send `{ patch: { soul: "", agents: "" } }` and
	// truncate SOUL.md and AGENTS.md. The host cannot refuse that: it drops
	// non-string fields and `""` is a string, indistinguishable from a user who
	// cleared both boxes on purpose. So the refusal has to happen here.
	const tab = mountSettingsTab(async () => ({ ok: false, error: { code: "EIO", message: "host is down" } }));
	await settle();

	assert.deepEqual(
		tab.calls.map((call) => call.endpoint),
		["buddyPersona/persona"],
	);
	const failure = elements(tab.tree()).find(
		(element) => element.props["children"] === "buddyPersona/persona failed: EIO: host is down",
	);
	assert.ok(failure !== undefined, "the load failure must be shown, not swallowed");

	const button = tab.saveButton();
	assert.equal(button.props["disabled"], true, "save must be disabled until a load succeeds");

	// `disabled` is a browser courtesy, not an invariant — the path itself must
	// refuse too, or a stray click still truncates both files.
	(button.props["onClick"] as () => void)();
	await settle();
	assert.deepEqual(
		tab.calls.map((call) => call.endpoint),
		["buddyPersona/persona"],
		"no update may be produced by a tab that never loaded",
	);
});

test("a loaded persona saves exactly the drafts the load produced", async () => {
	const view = { soul: "a voice", agents: "some rules", home: "/home/buddy" };
	const tab = mountSettingsTab(async (endpoint) =>
		endpoint === "buddyPersona/persona"
			? { ok: true, value: view }
			: { ok: true, value: { ...view, lastWriteAt: "2026-09-12T00:00:00.000Z" } },
	);

	// Still in flight: the drafts are empty, so the gate must already hold.
	assert.equal(tab.saveButton().props["disabled"], true, "save must be gated while the load is in flight");

	await settle();
	const button = tab.saveButton();
	assert.equal(button.props["disabled"], false, "a loaded tab must be saveable, or the gate is just a dead button");

	(button.props["onClick"] as () => void)();
	// Synchronously after the click the write is in flight: no double submit.
	assert.equal(tab.saveButton().props["disabled"], true, "save must be disabled while a write is in flight");

	await settle();
	assert.deepEqual(
		tab.calls.map((call) => call.endpoint),
		["buddyPersona/persona", "buddyPersona/updatePersona"],
	);
	// Proves the wiring too: `apply` hands the component the unwrapped caller,
	// addressed at the gateway route with the endpoint's own `{ args }` body.
	assert.deepEqual(tab.calls[1], {
		route: "/api",
		endpoint: "buddyPersona/updatePersona",
		payload: { args: { patch: { soul: "a voice", agents: "some rules" } } },
	});
	assert.equal(tab.saveButton().props["disabled"], false, "the tab must be saveable again once the write settles");
});

/** One call recorded against the sessions or layout service stubs. */
interface RecordedAction {
	readonly service: "sessions.open" | "layout.selectPanel";
	readonly arg: unknown;
}

/** A mounted main panel and what it did to its collaborators. */
interface MountedPanel {
	/** Every call the panel made through the connection service. */
	readonly calls: RecordedCall[];
	/** Every call the panel's `openSession` made against sessions/layout, in order. */
	readonly actions: RecordedAction[];
	/** The element tree of the most recent render. */
	tree(): unknown;
}

/**
 * Mount the real main panel: `apply` builds it, so the component under test is
 * the one actually registered into the `main` slot, wired to the plugin's own
 * `openSession` (which drives `ctx.sessions.open` then `ctx.layout.selectPanel(null)`).
 * @param answer - the gateway envelope (or rejection) for `buddyPersona/sessions`.
 * @returns the mounted panel handle.
 */
function mountBuddyPanel(answer: (endpoint: string) => Promise<unknown>): MountedPanel {
	const renderer = createRenderer();
	const calls: RecordedCall[] = [];
	const actions: RecordedAction[] = [];
	const client = loadClient((name) => renderer.modules[name] ?? nodeRequire(name));
	const { ctx, registrations } = contextStub({
		rpc: {
			call: async (route: string, endpoint: string, payload: unknown) => {
				calls.push({ route, endpoint, payload });
				return await answer(endpoint);
			},
		},
		sessions: { open: (sessionId: string) => actions.push({ service: "sessions.open", arg: sessionId }) },
		layout: { selectPanel: (panelId: unknown) => actions.push({ service: "layout.selectPanel", arg: panelId }) },
	});
	client.apply(ctx);

	const registration = registrations.find((r) => r.options.name === "main");
	assert.ok(registration !== undefined, "the main panel must be registered");
	renderer.mount(registration.component as () => unknown);

	return { calls, actions, tree: () => renderer.tree() };
}

/**
 * Find a conversation row button by its rendered title.
 *
 * Deliberately shallow (only the button's own immediate children), so it
 * cannot be confused with the header's Refresh button, whose only child is a
 * plain locale-key string rather than a title span.
 * @param tree - the rendered element tree.
 * @param title - the row's rendered title text.
 * @returns the row's button element.
 */
function rowButton(tree: unknown, title: string): StubElement {
	const button = elements(tree).find((element) => {
		if (element.type !== "button") return false;
		const children = element.props["children"];
		const kids = Array.isArray(children) ? children : [children];
		return kids.some(
			(kid) => typeof kid === "object" && kid !== null && (kid as Partial<StubElement>).props?.["children"] === title,
		);
	});
	assert.ok(button !== undefined, `no row button found for "${title}"`);
	return button;
}

test("the panel loads on mount, lists conversations, and falls back to Untitled for a blank title", async () => {
	const items = [
		{ sessionId: "s1", title: "Trip planning", updatedAt: 2, cwd: "/home/x" },
		{ sessionId: "s2", title: "", updatedAt: 0, cwd: "" },
	];
	const panel = mountBuddyPanel(async () => ({ ok: true, value: items }));
	await settle();

	assert.deepEqual(panel.calls.map((call) => call.endpoint), ["buddyPersona/sessions"]);
	const texts = elements(panel.tree())
		.map((element) => element.props["children"])
		.filter((child): child is string => typeof child === "string");
	assert.ok(texts.includes("Trip planning"), "a titled session must show its own title");
	assert.ok(texts.includes("/home/x"), "a non-empty cwd must render as a meta line");
	assert.ok(texts.includes("settings.buddy:untitled"), "a blank title must render as Untitled, not an empty row");
});

test("an empty cwd renders no meta line", async () => {
	// s2 above has title "" (covered by the untitled fallback) and cwd "" — this
	// pins the cwd side of that same row separately, so a defect in either
	// condition is caught by a specific assertion rather than a shared one.
	const panel = mountBuddyPanel(async () => ({
		ok: true,
		value: [{ sessionId: "s2", title: "", updatedAt: 0, cwd: "" }],
	}));
	await settle();

	const row = rowButton(panel.tree(), "settings.buddy:untitled");
	const children = row.props["children"];
	const kids = Array.isArray(children) ? children : [children];
	// React renders `false` as nothing, but the JSX call site still evaluates
	// `item.cwd !== "" && <span>…</span>` to that `false` rather than omitting
	// the slot entirely — so the falsifiable check is "no rendered element
	// besides the title span", not "a shorter children array".
	const rendered = kids.filter((kid) => typeof kid === "object" && kid !== null);
	assert.equal(rendered.length, 1, "an empty cwd must not add a rendered meta span");
});

test("the empty-state hint shows only after a load resolves to zero conversations", async () => {
	const panel = mountBuddyPanel(async () => ({ ok: true, value: [] }));

	// Still in flight: items is undefined, so the empty hint must not show yet
	// (it would otherwise flash "no conversations" while a slow load is pending).
	let texts = elements(panel.tree()).map((element) => element.props["children"]);
	assert.ok(!texts.includes("settings.buddy:empty"), "the empty hint must not show before the load settles");

	await settle();
	texts = elements(panel.tree()).map((element) => element.props["children"]);
	assert.ok(texts.includes("settings.buddy:empty"));
});

test("a failed sessions load surfaces the error instead of an empty-state lie", async () => {
	const panel = mountBuddyPanel(async () => ({ ok: false, error: { code: "EIO", message: "host is down" } }));
	await settle();

	const texts = elements(panel.tree()).map((element) => element.props["children"]);
	assert.ok(texts.includes("buddyPersona/sessions failed: EIO: host is down"), "the load failure must be shown, not swallowed");
	assert.ok(!texts.includes("settings.buddy:empty"), "an error is not the same claim as zero conversations");
});

test("the refresh button re-issues the sessions call", async () => {
	const panel = mountBuddyPanel(async () => ({ ok: true, value: [] }));
	await settle();
	assert.equal(panel.calls.length, 1);

	const refresh = elements(panel.tree()).find(
		(element) => element.type === "button" && element.props["children"] === "settings.buddy:refresh",
	);
	assert.ok(refresh !== undefined, "the header must render a refresh button");
	(refresh.props["onClick"] as () => void)();
	await settle();
	assert.equal(panel.calls.length, 2, "clicking refresh must call the endpoint again, not replay the first result");
});

test("opening a conversation calls sessions.open, then returns the centre column via layout.selectPanel(null)", async () => {
	const panel = mountBuddyPanel(async () => ({
		ok: true,
		value: [{ sessionId: "s1", title: "Trip planning", updatedAt: 2, cwd: "" }],
	}));
	await settle();

	const row = rowButton(panel.tree(), "Trip planning");
	(row.props["onClick"] as () => void)();

	// Order matters: selectPanel(null) first would flip the centre column away
	// before sessions.open had a chance to stage the target conversation.
	assert.deepEqual(panel.actions, [
		{ service: "sessions.open", arg: "s1" },
		{ service: "layout.selectPanel", arg: null },
	]);
});

test("the sidebar icon defaults to size 16 and honours a supplied size", () => {
	const renderer = createRenderer();
	const client = loadClient((name) => renderer.modules[name] ?? nodeRequire(name));
	const { ctx, registrations } = contextStub();
	client.apply(ctx);

	const registration = registrations.find((r) => r.options.name === "sidebar.panellist");
	assert.ok(registration !== undefined);
	const Icon = registration.component as (props: { size?: number }) => StubElement;

	assert.equal(Icon({}).props["width"], 16, "the sidebar row's default glyph size is 16");
	assert.equal(Icon({ size: 24 }).props["width"], 24, "a supplied size must be honoured, not ignored");
});

test("the button and the panel are both registered — neither alone", async () => {
	// A sidebar row without a main entry throws on click, because
	// ctx.layout.selectPanel rejects a key the main slot never registered.
	const built = await bundleText();
	assert.match(built, /sidebar\.panellist/);
	assert.match(built, /"main"|'main'/);
});
