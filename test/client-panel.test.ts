import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { visibleModules } from "../src/client/modules.ts";
import {
	contextStub,
	createRenderer,
	elements,
	loadClient,
	settle,
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

test("New Buddy conversation creates a buddy-preset session in the conversation cwd, applies the buddy model, and opens it", async () => {
	const remoteCalls: { method: string; arg: unknown }[] = [];
	const remote = {
		session: {
			create: async (arg: unknown) => {
				remoteCalls.push({ method: "create", arg });
				return { ok: true, value: { sessionId: "s-new", agentPreset: "buddy" } };
			},
			selectModel: async (arg: unknown) => {
				remoteCalls.push({ method: "selectModel", arg });
				return { ok: true, value: {} };
			},
		},
	};
	const panel = mountPanel(
		async (endpoint) =>
			endpoint === "buddyPersona/preferences"
				? {
						ok: true,
						value: {
							...PREFS,
							model: { provider: "p", model: "m", reasoningEffort: "" },
							// Not under test here, and hiding them keeps this test from
							// having to also stub the Telegram module's own endpoints.
							panel: { sections: { ...PREFS.panel.sections, model: false, telegram: false } },
						},
					}
				: { ok: true, value: { soul: "", agents: "", home: "/h" } },
		remote,
	);
	await settle();
	(button(panel.tree(), "settings.buddy:newConversation").props["onClick"] as () => void)();
	await settle();
	assert.deepEqual(remoteCalls, [
		{ method: "create", arg: { cwd: "/home/u/buddy-workspace", agentPreset: "buddy" } },
		{ method: "selectModel", arg: { sessionId: "s-new", provider: "p", model: "m" } },
	]);
	assert.deepEqual(panel.actions.slice(-3), [
		{ service: "sessions.refresh", arg: undefined },
		{ service: "sessions.open", arg: "s-new" },
		{ service: "layout.selectPanel", arg: null },
	]);
});

test("without a buddy model New Buddy conversation does not pick a model", async () => {
	const remoteCalls: string[] = [];
	const remote = {
		session: {
			create: async () => {
				remoteCalls.push("create");
				return { ok: true, value: { sessionId: "s-new" } };
			},
			selectModel: async () => {
				remoteCalls.push("selectModel");
				return { ok: true, value: {} };
			},
		},
	};
	const panel = mountPanel(
		async (endpoint) =>
			endpoint === "buddyPersona/preferences"
				? {
						ok: true,
						// Not under test here; hidden so the Telegram module never mounts
						// and needs no endpoint stub of its own.
						value: { ...PREFS, panel: { sections: { ...PREFS.panel.sections, model: false, telegram: false } } },
					}
				: { ok: true, value: { soul: "", agents: "", home: "/h" } },
		remote,
	);
	await settle();
	(button(panel.tree(), "settings.buddy:newConversation").props["onClick"] as () => void)();
	await settle();
	assert.deepEqual(remoteCalls, ["create"]);
	// No model to apply is not a failure: the session still opens.
	assert.deepEqual(panel.actions.slice(-3), [
		{ service: "sessions.refresh", arg: undefined },
		{ service: "sessions.open", arg: "s-new" },
		{ service: "layout.selectPanel", arg: null },
	]);
});

test("a failed model selection still opens the created session, and reports the error", async () => {
	const remote = {
		session: {
			create: async () => ({ ok: true, value: { sessionId: "s-new" } }),
			selectModel: async () => ({ ok: false, error: { message: "bad model" } }),
		},
	};
	const panel = mountPanel(
		async (endpoint) =>
			endpoint === "buddyPersona/preferences"
				? {
						ok: true,
						value: {
							...PREFS,
							model: { provider: "p", model: "m", reasoningEffort: "" },
							// Not under test here, and hiding them keeps this test from
							// having to also stub the Telegram module's own endpoints.
							panel: { sections: { ...PREFS.panel.sections, model: false, telegram: false } },
						},
					}
				: { ok: true, value: { soul: "", agents: "", home: "/h" } },
		remote,
	);
	await settle();
	(button(panel.tree(), "settings.buddy:newConversation").props["onClick"] as () => void)();
	await settle();
	// The conversation exists — a bad model default is not a reason to strand
	// the user without the session they just asked for.
	assert.deepEqual(panel.actions.slice(-3), [
		{ service: "sessions.refresh", arg: undefined },
		{ service: "sessions.open", arg: "s-new" },
		{ service: "layout.selectPanel", arg: null },
	]);
	assert.ok(texts(panel.tree()).includes("bad model"), "the model-selection failure must still surface");
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
	const follow = elements(panel.tree()).find((e) => e.type === "input" && e.props["name"] === "followDefault");
	assert.equal(follow?.props["checked"], true, "an empty buddy model reads as following the global default");
	(follow?.props["onChange"] as (event: { target: { checked: boolean } }) => void)({ target: { checked: false } });
	const provider = elements(panel.tree()).find((e) => e.type === "select" && e.props["name"] === "provider");
	(provider?.props["onChange"] as (event: { target: { value: string } }) => void)({ target: { value: "p" } });
	const model = elements(panel.tree()).find((e) => e.type === "select" && e.props["name"] === "model");
	(model?.props["onChange"] as (event: { target: { value: string } }) => void)({ target: { value: "m1" } });
	const effort = elements(panel.tree()).find((e) => e.type === "select" && e.props["name"] === "effort");
	(effort?.props["onChange"] as (event: { target: { value: string } }) => void)({ target: { value: "high" } });
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
	const follow = elements(panel.tree()).find((e) => e.type === "input" && e.props["name"] === "followDefault");
	assert.equal(follow?.props["checked"], false);
	(follow?.props["onChange"] as (event: { target: { checked: boolean } }) => void)({ target: { checked: true } });
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
	const enabled = elements(panel.tree()).find((e) => e.type === "input" && e.props["name"] === "enabled");
	(enabled?.props["onChange"] as (event: { target: { checked: boolean } }) => void)({ target: { checked: true } });
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

test("a failed create is shown and nothing is opened", async () => {
	const remote = { session: { create: async () => ({ ok: false, error: { message: "no workspace" } }), selectModel: async () => ({ ok: true }) } };
	const panel = mountPanel(
		async (endpoint) =>
			endpoint === "buddyPersona/preferences"
				? {
						ok: true,
						// Not under test here; hidden so the Telegram module never mounts
						// and needs no endpoint stub of its own.
						value: { ...PREFS, panel: { sections: { ...PREFS.panel.sections, model: false, telegram: false } } },
					}
				: { ok: true, value: { soul: "", agents: "", home: "/h" } },
		remote,
	);
	await settle();
	(button(panel.tree(), "settings.buddy:newConversation").props["onClick"] as () => void)();
	await settle();
	assert.ok(texts(panel.tree()).includes("no workspace"));
	assert.ok(!panel.actions.some((action) => action.service === "sessions.open"));
});
