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
 *
 * The main panel's and the slim settings tab's own behaviour — modules,
 * document editing, New Buddy conversation — moved to `test/client-panel.test.ts`
 * and `test/client-settings.test.ts`; this file keeps only the registration
 * contract (inject, slot wiring, dictionaries, the shared panel key).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { MAIN_PANEL_KEY } from "../src/index.ts";
import { createCall } from "../src/client/call.ts";
import { bundleText, clientSourceText, loadClient, contextStub, type SectionOptions } from "./support/client-harness.ts";

test("the browser half is wrapped in the module-loader factory", async () => {
	const text = await bundleText();
	assert.match(text, /^window\.__ModuleLoader__\.load\(\{/);
	// The envelope is only real if evaluating the bundle actually calls `load`
	// and the factory hands back a mountable plugin.
	const client = loadClient();
	assert.equal(typeof client.apply, "function");
});

test("the browser half injects slots, locale, connection, layout, sessions, the remote session namespace and the remote credentials namespace", () => {
	const client = loadClient();
	// `remote` and `remote.session` are what "New Buddy conversation" needs to
	// create and configure a session directly against the Remote layer, bypassing
	// the client Session list. `remote.credentials` is what the Telegram module
	// writes the bot token through. `inject` is per-fiber rather than
	// per-registration: one list, declared once, so no registration can mount
	// half-wired. Every one of these is present in the web shell, so the wait
	// never becomes a stall.
	assert.deepEqual(client.inject, [
		"slots",
		"locale",
		"connection",
		"layout",
		"sessions",
		"remote",
		"remote.session",
		"remote.credentials",
	]);
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
	// reading that package's own Context augmentation, recorded in the task-8 and
	// task-11 fix reports — present in the manifest. The map has NO exemptions on
	// purpose: omitting one (as `slots` was, the first time) is exactly the gap
	// that let a wrong entry through uncaught, so an unmapped service now fails
	// loudly instead of being silently skipped.
	//
	// `remote` is declared by `@deepseek-ai/dsh-api-gateway`, but the convention
	// this harness's own plugins follow (dsh-telegram's `src/client/index.tsx`)
	// is to depend on the assembly facade, `@deepseek-ai/dsh-api-remotes`, which
	// re-exports the gateway's types and mounts every generated Remote namespace
	// onto it. `remote.session` is not a static Context augmentation at all — it
	// is a namespace dynamically provided at runtime under the literal cordis
	// service key `remote.session` (`remoteServiceKey` in
	// `@deepseek-ai/dsh-api-gateway/lib/client.js`), backed by
	// `@deepseek-ai/dsh-api-session-controller`'s `SessionController` (see that
	// package's own doc comment: "Host service backing the generated
	// `ctx.remote.session` namespace"), and that package's own client half injects
	// `remote.session` the same way (its `lib/types/client/index.js`).
	//
	// `remote.credentials` is likewise dynamic: `@deepseek-ai/dsh-api-settings-controller`'s
	// `CredentialsController` carries the identical doc-comment pattern ("Host
	// service backing the generated `ctx.remote.credentials` namespace"), but —
	// unlike the session namespace — that host package ships no client half at
	// all, so it is never itself a `dsh.client.inject` entry. The declaring
	// package on the browser side is `@deepseek-ai/dsh-api-remotes`: both
	// first-party client packages that actually inject `remote.credentials`
	// (`@deepseek-ai/dsh-client-ui-settings-plugins`,
	// `@deepseek-ai/dsh-client-ui-settings-models`) list only `dsh-api-remotes`
	// in their own `dsh.client.inject`, exactly as `dsh-telegram` does for the
	// same pair (`remote`, `remote.credentials`) — already present in this
	// plugin's manifest, so no new entry was needed there.
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
		remote: "@deepseek-ai/dsh-api-remotes",
		"remote.session": "@deepseek-ai/dsh-api-session-controller",
		"remote.credentials": "@deepseek-ai/dsh-api-remotes",
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

	// The "main" and "sidebar.footer.action" pair is asserted separately below,
	// so here only the count and the settings.section entry itself are pinned.
	assert.deepEqual(injected, ["settings.section", "main", "sidebar.footer.action"]);
	assert.equal(registrations.length, 3, "settings.section, main and sidebar.footer.action — nothing else");
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

test("the browser half registers the settings tab, the main panel and the sidebar folder — no panellist button", () => {
	const client = loadClient();
	const { ctx, registrations, injected } = contextStub();
	client.apply(ctx);
	assert.deepEqual(injected, ["settings.section", "main", "sidebar.footer.action"]);
	assert.equal(registrations.length, 3);
	const folder = registrations.find((r) => r.options.name === "sidebar.footer.action");
	assert.ok(folder !== undefined);
	assert.equal((folder.options as { id: string }).id, "buddy-folder");
	assert.equal((folder.options as { order: number }).order, -10);
	assert.ok(!registrations.some((r) => r.options.name === "sidebar.panellist"));
});

test("no registration happens when the shell has none of the matching slots", () => {
	const client = loadClient();
	const { ctx, registrations, injected } = contextStub({ runSlotCallback: false });
	client.apply(ctx);
	assert.deepEqual(injected, ["settings.section", "main", "sidebar.footer.action"]);
	assert.equal(registrations.length, 0);
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
	for (const key of [
		"nav",
		"panelTitle",
		"newConversation",
		"soulTitle",
		"soulHint",
		"agentsTitle",
		"agentsHint",
		"save",
		"homeLabel",
		"settingsHint",
		"sectionsTitle",
		// Task 12: the Model module.
		"modelHint",
		"modelFollow",
		"modelProvider",
		"modelModel",
		"modelEffort",
		"modelEffortDefault",
		"modelChoose",
		// Task 12: the Telegram module. `telegramStatusSessions` is deliberately
		// excluded from this loop — it is a function, not a string — but it is
		// still covered by the `Object.keys(...).sort()` comparison above, which
		// is what actually keeps `en` and `zh` in step for a function-valued key.
		"telegramTokenTitle",
		"telegramTokenHint",
		"telegramTokenConfigured",
		"telegramTokenMissing",
		"telegramTokenWritable",
		"telegramTokenReadOnly",
		"telegramTokenPlaceholder",
		"tokenSave",
		"tokenClear",
		"telegramSave",
		"telegramSaved",
		"telegramCleared",
		"telegramConfigTitle",
		"telegramOwnerLabel",
		"telegramOwnerHint",
		"telegramCwdLabel",
		"telegramCwdHint",
		"telegramPresetLabel",
		"telegramPresetHint",
		"telegramPresetReadOnly",
		"telegramPresetWorkspace",
		"telegramPresetFull",
		"telegramMarkdownLabel",
		"telegramMarkdownHint",
		"telegramMediaLabel",
		"telegramMediaHint",
		"telegramMediaOff",
		"telegramMediaPresented",
		"telegramMediaAll",
		"telegramEnabledLabel",
		"telegramEnabledHint",
		"telegramStatusTitle",
		"telegramStatusOff",
		"telegramStatusStarting",
		"telegramStatusRunning",
		"telegramStatusError",
		"telegramLoading",
		"telegramRetry",
		"telegramUnsaved",
	]) {
		assert.equal(typeof english[key], "string", `en.${key} is used by the panel or the settings tab`);
		assert.equal(typeof chinese[key], "string", `zh.${key} is used by the panel or the settings tab`);
	}
	assert.equal(typeof english["telegramStatusSessions"], "function");
	assert.equal(typeof chinese["telegramStatusSessions"], "function");
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

