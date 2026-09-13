import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { visibleModules } from "../src/client/modules.ts";
import {
	contextStub,
	createRenderer,
	elements,
	choose,
	flipSwitch,
	loadClient,
	settle,
	switchControl,
	type RecordedCall,
	type StubElement,
} from "./support/client-harness.ts";

const nodeRequire = createRequire(import.meta.url);
const PREFS = {
	model: { provider: "", model: "", reasoningEffort: "" },
	panel: { sections: { soul: true, agents: true, model: true, telegram: true } },
	conversationCwd: "/home/u/buddy-workspace",
};

test("visibleModules drops hidden modules and orders the rest", () => {
	const modules = [
		{ id: "telegram", order: 40, titleKey: "t", Component: 4 },
		{ id: "soul", order: 10, titleKey: "s", Component: 1 },
		{ id: "agents", order: 20, titleKey: "a", Component: 2 },
	] as const;
	assert.deepEqual(visibleModules(modules, { agents: false }).map((m) => m.Component), [1, 4]);
	assert.deepEqual(visibleModules(modules, undefined).map((m) => m.Component), [1, 2, 4]);
});

function mountPanel(answer: (endpoint: string, payload: unknown) => Promise<unknown>, remote?: unknown) {
	const renderer = createRenderer();
	const calls: RecordedCall[] = [];
	const actions: { service: string; arg: unknown }[] = [];
	const client = loadClient((name) => renderer.modules[name] ?? nodeRequire(name));
	const { ctx, registrations } = contextStub({
		rpc: {
			call: async (route, endpoint, payload) => {
				calls.push({ route, endpoint, payload });
				return await answer(endpoint, payload);
			},
		},
		remote,
		sessions: {
			open: (id: string) => actions.push({ service: "sessions.open", arg: id }),
			refresh: async () => {
				actions.push({ service: "sessions.refresh", arg: undefined });
			},
			list: { getSnapshot: () => ({ current: undefined }), subscribe: () => () => undefined },
		},
		layout: { selectPanel: (id: unknown) => actions.push({ service: "layout.selectPanel", arg: id }) },
	});
	client.apply(ctx);
	const main = registrations.find((r) => r.options.name === "main");
	assert.ok(main !== undefined);
	renderer.mount(main.component as () => unknown);
	return { calls, actions, tree: () => renderer.tree() };
}

function texts(tree: unknown): unknown[] {
	return elements(tree).map((element) => element.props["children"]);
}

function button(tree: unknown, label: string): StubElement {
	const found = elements(tree).find((e) => e.type === "button" && e.props["children"] === label);
	assert.ok(found !== undefined, `no button "${label}"`);
	return found;
}

test("the panel shows only the modules preferences leave visible", async () => {
	const panel = mountPanel(async (endpoint) =>
		endpoint === "buddyPersona/preferences"
			? { ok: true, value: { ...PREFS, panel: { sections: { ...PREFS.panel.sections, agents: false, model: false, telegram: false } } } }
			: { ok: true, value: { soul: "v", agents: "r", home: "/h" } },
	);
	await settle();
	const shown = texts(panel.tree());
	assert.ok(shown.includes("settings.buddy:soulTitle"));
	assert.ok(!shown.includes("settings.buddy:agentsTitle"), "a hidden module must not render");
});

test("a document module that failed to load cannot save over the file", async () => {
	const panel = mountPanel(async (endpoint) =>
		endpoint === "buddyPersona/preferences"
			? { ok: true, value: { ...PREFS, panel: { sections: { soul: true, agents: false, model: false, telegram: false } } } }
			: { ok: false, error: { code: "EIO", message: "host is down" } },
	);
	await settle();
	const save = button(panel.tree(), "settings.buddy:save");
	assert.equal(save.props["disabled"], true);
	(save.props["onClick"] as () => void)();
	await settle();
	assert.ok(!panel.calls.some((call) => call.endpoint === "buddyPersona/updatePersona"));
});

test("the soul module saves only its own field", async () => {
	const panel = mountPanel(async (endpoint) =>
		endpoint === "buddyPersona/preferences"
			? { ok: true, value: { ...PREFS, panel: { sections: { soul: true, agents: false, model: false, telegram: false } } } }
			: { ok: true, value: { soul: "a voice", agents: "rules", home: "/h" } },
	);
	await settle();
	(button(panel.tree(), "settings.buddy:save").props["onClick"] as () => void)();
	await settle();
	const write = panel.calls.find((call) => call.endpoint === "buddyPersona/updatePersona");
	assert.deepEqual(write?.payload, { args: { patch: { soul: "a voice" } } });
});

const ONLY = (id: string) => ({ ...PREFS, panel: { sections: { soul: false, agents: false, model: false, telegram: false, [id]: true } } });

const CATALOG = {
	default: { provider: "g", model: "gm" },
	routableProviders: ["p"],
	groups: [
		{
			id: "p",
			name: "Provider P",
			models: [
				{ id: "m1", name: "Model 1", reasoning: { efforts: [{ id: "low", name: "Low" }, { id: "high", name: "High" }] } },
				{ id: "m2", name: "Model 2" },
			],
		},
	],
	failures: [],
};

test("the model module saves a concrete buddy default", async () => {
	const remote = { session: { modelCatalog: async () => ({ ok: true, value: CATALOG }) } };
	const panel = mountPanel(
		async (endpoint) => ({ ok: true, value: endpoint === "buddyPersona/updatePreferences" ? PREFS : ONLY("model") }),
		remote,
	);
	await settle();
	assert.equal(switchControl(panel.tree(), "settings.buddy:modelFollow").props["aria-checked"], true, "an empty buddy model reads as following the global default");
	flipSwitch(panel.tree(), "settings.buddy:modelFollow");
	choose(panel.tree(), "provider", "p");
	choose(panel.tree(), "model", "m1");
	choose(panel.tree(), "effort", "high");
	(button(panel.tree(), "settings.buddy:save").props["onClick"] as () => void)();
	await settle();
	const write = panel.calls.find((call) => call.endpoint === "buddyPersona/updatePreferences");
	assert.deepEqual(write?.payload, { args: { patch: { model: { provider: "p", model: "m1", reasoningEffort: "high" } } } });
});

test("following the global default saves an empty model", async () => {
	const remote = { session: { modelCatalog: async () => ({ ok: true, value: CATALOG }) } };
	const panel = mountPanel(
		async () => ({ ok: true, value: { ...ONLY("model"), model: { provider: "p", model: "m2", reasoningEffort: "" } } }),
		remote,
	);
	await settle();
	assert.equal(switchControl(panel.tree(), "settings.buddy:modelFollow").props["aria-checked"], false);
	flipSwitch(panel.tree(), "settings.buddy:modelFollow");
	(button(panel.tree(), "settings.buddy:save").props["onClick"] as () => void)();
	await settle();
	const write = panel.calls.find((call) => call.endpoint === "buddyPersona/updatePreferences");
	assert.deepEqual(write?.payload, { args: { patch: { model: { provider: "", model: "", reasoningEffort: "" } } } });
});

test("the telegram module shows status and saves config through buddyTelegram", async () => {
	const status = { state: "error", detail: "dsh-telegram is still polling this bot; remove it from the profile first", botUsername: "example_dev_bot", token: { configured: true, source: "file", writable: true }, sessions: 2 };
	const config = { enabled: false, ownerUserId: "1000000000", defaultCwd: "~/dsh-telegram", permissionPreset: "workspace-write", renderMarkdown: true, mediaDelivery: "all" };
	const panel = mountPanel(async (endpoint) => {
		if (endpoint === "buddyPersona/preferences") return { ok: true, value: ONLY("telegram") };
		if (endpoint === "buddyTelegram/status") return { ok: true, value: status };
		return { ok: true, value: config };
	});
	await settle();
	assert.ok(texts(panel.tree()).includes(status.detail), "the occupancy detail must be visible");
	flipSwitch(panel.tree(), "settings.buddy:telegramEnabledLabel");
	(button(panel.tree(), "settings.buddy:telegramSave").props["onClick"] as () => void)();
	await settle();
	const write = panel.calls.find((call) => call.endpoint === "buddyTelegram/updateConfig");
	assert.deepEqual(write?.payload, { args: { patch: { enabled: true } } });
});

test("the telegram token is written through remote.credentials and never read back", async () => {
	const writes: unknown[] = [];
	const remote = {
		credentials: {
			set: async (ref: string, value: string) => {
				writes.push({ ref, value });
				return { ok: true };
			},
			unset: async (ref: string) => {
				writes.push({ ref });
				return { ok: true };
			},
		},
	};
	const panel = mountPanel(async (endpoint) => {
		if (endpoint === "buddyPersona/preferences") return { ok: true, value: ONLY("telegram") };
		if (endpoint === "buddyTelegram/status") return { ok: true, value: { state: "off", token: { configured: false, writable: true }, sessions: 0 } };
		return { ok: true, value: { enabled: false, ownerUserId: "", defaultCwd: "", permissionPreset: "workspace-write", renderMarkdown: true, mediaDelivery: "all" } };
	}, remote);
	await settle();
	const input = elements(panel.tree()).find((e) => e.type === "input" && e.props["type"] === "password");
	(input?.props["onChange"] as (event: { target: { value: string } }) => void)({ target: { value: " 123:abc " } });
	(button(panel.tree(), "settings.buddy:tokenSave").props["onClick"] as () => void)();
	await settle();
	assert.deepEqual(writes, [{ ref: "TELEGRAM_BOT_TOKEN", value: "123:abc" }]);
});

test("the panel header carries only its title — conversations start elsewhere", async () => {
	const panel = mountPanel(async (endpoint) =>
		endpoint === "buddyPersona/preferences"
			? { ok: true, value: { ...PREFS, panel: { sections: { soul: false, agents: false, model: false, telegram: false } } } }
			: { ok: true, value: {} },
	);
	await settle();
	assert.deepEqual(elements(panel.tree()).filter((e) => e.type === "button"), []);
	assert.ok(texts(panel.tree()).includes("settings.buddy:panelTitle"));
});

test("module buttons are the harness's own Button, not hand-styled ones", async () => {
	const panel = mountPanel(async (endpoint) =>
		endpoint === "buddyPersona/preferences"
			? { ok: true, value: ONLY("soul") }
			: { ok: true, value: { soul: "", agents: "", home: "/h" } },
	);
	await settle();
	const save = button(panel.tree(), "settings.buddy:save");
	assert.equal(save.props["data-variant"], "primary");
	assert.equal(save.props["data-size"], "sm");
	assert.equal(save.props["style"], undefined, "no inline styling on top of the native button");
});

test("no module renders a raw checkbox, text input, select or inline style — every control is a harness primitive", async () => {
	const remote = { session: { modelCatalog: async () => ({ ok: true, value: CATALOG }) } };
	const panel = mountPanel(async (endpoint) => {
		if (endpoint === "buddyPersona/preferences") {
			return { ok: true, value: { ...PREFS, model: { provider: "p", model: "m1", reasoningEffort: "" } } };
		}
		if (endpoint === "buddyPersona/persona") return { ok: true, value: { soul: "", agents: "", home: "/h" } };
		if (endpoint === "buddyTelegram/status") return { ok: true, value: { state: "off", token: { configured: false, writable: true }, sessions: 0 } };
		return { ok: true, value: { enabled: false, ownerUserId: "", defaultCwd: "", permissionPreset: "workspace-write", renderMarkdown: true, mediaDelivery: "all" } };
	}, remote);
	await settle();
	const all = elements(panel.tree());
	assert.deepEqual(all.filter((e) => e.type === "select"), [], "selects are Menu-backed selectors");
	assert.deepEqual(all.filter((e) => e.type === "input" && e.props["data-wrapper-class"] === undefined), [], "text fields are the Input primitive");
	assert.deepEqual(all.filter((e) => e.props["style"] !== undefined), [], "styling comes from classes on --dsw tokens");
	assert.equal(all.filter((e) => e.props["role"] === "switch").length, 3, "Model follow-default plus Telegram markdown and enabled");
	assert.equal(all.filter((e) => e.type === "menu").length, 5, "provider, model, effort, permission level and media delivery");
});

test("the panel clears a stale preferences error once a notified reload succeeds (R9)", async () => {
	// Composite mount as in R8, so the settings tab's toggle can fire the shared
	// `preferencesChanged` notifier the panel subscribes to. The panel is listed
	// first here (unlike R8) so its own initial `buddyPersona/preferences` call —
	// the very first RPC either component issues — is the one made to fail;
	// every later call to that endpoint (the settings tab's own initial load,
	// and the panel's post-notify reload) succeeds.
	const renderer = createRenderer();
	const client = loadClient((name) => renderer.modules[name] ?? nodeRequire(name));
	let prefs = { ...PREFS, panel: { sections: { soul: true, agents: true, model: true, telegram: true } } };
	let preferencesCalls = 0;
	const FAILED_LOAD = "buddyPersona/preferences failed: EIO: host is down";
	const { ctx, registrations } = contextStub({
		rpc: {
			call: async (_route: string, endpoint: string, payload: unknown) => {
				if (endpoint === "buddyPersona/preferences") {
					preferencesCalls += 1;
					if (preferencesCalls === 1) return { ok: false, error: { code: "EIO", message: "host is down" } };
					return { ok: true, value: prefs };
				}
				if (endpoint === "buddyPersona/updatePreferences") {
					const patch = (payload as { args: { patch: { panel: { sections: Record<string, boolean> } } } }).args.patch;
					prefs = { ...prefs, panel: { sections: { ...prefs.panel.sections, ...patch.panel.sections } } };
					return { ok: true, value: prefs };
				}
				if (endpoint === "buddyPersona/persona") return { ok: true, value: { soul: "", agents: "", home: "/h" } };
				if (endpoint === "buddyTelegram/config") {
					return {
						ok: true,
						value: { enabled: false, ownerUserId: "", defaultCwd: "", permissionPreset: "workspace-write", renderMarkdown: true, mediaDelivery: "all" },
					};
				}
				if (endpoint === "buddyTelegram/status") {
					return { ok: true, value: { state: "off", token: { configured: false, writable: true }, sessions: 0 } };
				}
				throw new Error(`unexpected endpoint: ${endpoint}`);
			},
		},
		remote: {
			session: {
				modelCatalog: async () => ({
					ok: true,
					value: { default: { provider: "", model: "" }, routableProviders: [], groups: [], failures: [] },
				}),
			},
		},
	});
	client.apply(ctx);
	const settingsReg = registrations.find((r) => r.options.name === "settings.section");
	const mainReg = registrations.find((r) => r.options.name === "main");
	assert.ok(settingsReg !== undefined && mainReg !== undefined);

	const Root = (): unknown => [
		{ type: mainReg.component, props: {} },
		{ type: settingsReg.component, props: {} },
	];
	renderer.mount(Root as () => unknown);
	await settle();

	const [panelTreeBefore] = renderer.tree() as [unknown, unknown];
	assert.ok(texts(panelTreeBefore).includes(FAILED_LOAD), "the panel's own failed load shows its error");

	// Toggling a settings switch is the only path that fires
	// `preferencesChanged.notify()`, which is what makes the panel reload.
	flipSwitch(renderer.tree(), "settings.buddy:soulTitle");
	await settle();

	const [panelTreeAfter] = renderer.tree() as [unknown, unknown];
	assert.ok(!texts(panelTreeAfter).includes(FAILED_LOAD), "a successful reload must clear the earlier error");
});

test("the main panel drops a module the settings tab just hid, without remounting (R8)", async () => {
	// The settings tab and the main panel are two independent slot registrations
	// from the SAME `apply(ctx)` call, mounted here as siblings of one composite
	// root so both share the one `react` binding the built bundle captured —
	// each keeps its own hook storage (per `createRenderer`'s per-instance
	// addressing), so a re-render of one never resets the other's state, and only
	// the shared `preferencesChanged` notifier can make the panel reload.
	const renderer = createRenderer();
	const client = loadClient((name) => renderer.modules[name] ?? nodeRequire(name));
	let prefs = { ...PREFS, panel: { sections: { soul: true, agents: true, model: true, telegram: true } } };
	const { ctx, registrations } = contextStub({
		rpc: {
			call: async (_route: string, endpoint: string, payload: unknown) => {
				if (endpoint === "buddyPersona/preferences") return { ok: true, value: prefs };
				if (endpoint === "buddyPersona/updatePreferences") {
					const patch = (payload as { args: { patch: { panel: { sections: Record<string, boolean> } } } }).args.patch;
					prefs = { ...prefs, panel: { sections: { ...prefs.panel.sections, ...patch.panel.sections } } };
					return { ok: true, value: prefs };
				}
				if (endpoint === "buddyPersona/persona") return { ok: true, value: { soul: "", agents: "", home: "/h" } };
				if (endpoint === "buddyTelegram/config") {
					return {
						ok: true,
						value: { enabled: false, ownerUserId: "", defaultCwd: "", permissionPreset: "workspace-write", renderMarkdown: true, mediaDelivery: "all" },
					};
				}
				if (endpoint === "buddyTelegram/status") {
					return { ok: true, value: { state: "off", token: { configured: false, writable: true }, sessions: 0 } };
				}
				throw new Error(`unexpected endpoint: ${endpoint}`);
			},
		},
		remote: { session: { modelCatalog: async () => ({ ok: true, value: { default: { provider: "", model: "" }, routableProviders: [], groups: [], failures: [] } }) } },
	});
	client.apply(ctx);
	const settingsReg = registrations.find((r) => r.options.name === "settings.section");
	const mainReg = registrations.find((r) => r.options.name === "main");
	assert.ok(settingsReg !== undefined && mainReg !== undefined);

	const Root = (): unknown => [
		{ type: settingsReg.component, props: {} },
		{ type: mainReg.component, props: {} },
	];
	renderer.mount(Root as () => unknown);
	await settle();

	// `resolve` maps an array preserving position, so the composite tree's two
	// entries are the settings tab's own rendered output and the panel's, in
	// that order — checked separately below because the settings tab always
	// lists every module's toggle (checked or not), while only the panel's own
	// module cards are expected to come and go.
	const [, panelTree] = renderer.tree() as [unknown, unknown];
	assert.ok(texts(panelTree).includes("settings.buddy:telegramTitle"), "the telegram module card renders before the toggle");
	assert.ok(texts(panelTree).includes("settings.buddy:soulTitle"));

	flipSwitch(renderer.tree(), "settings.buddy:telegramTitle");
	await settle();

	const [, panelTreeAfter] = renderer.tree() as [unknown, unknown];
	assert.ok(!texts(panelTreeAfter).includes("settings.buddy:telegramTitle"), "the panel drops the module live, without a remount");
	assert.ok(texts(panelTreeAfter).includes("settings.buddy:soulTitle"), "an untouched module keeps rendering");
});
