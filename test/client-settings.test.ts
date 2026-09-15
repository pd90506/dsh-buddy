import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { contextStub, createRenderer, elements, flipSwitch, loadClient, settle, type RecordedCall } from "./support/client-harness.ts";

const nodeRequire = createRequire(import.meta.url);
const PREFS = {
	model: { provider: "", model: "", reasoningEffort: "" },
	panel: { sections: { soul: true, agents: true, skills: true, model: true, telegram: true } },
	conversationCwd: "/c",
};

function mountSettings(answer: (endpoint: string) => Promise<unknown>) {
	const renderer = createRenderer();
	const calls: RecordedCall[] = [];
	const client = loadClient((name) => renderer.modules[name] ?? nodeRequire(name));
	const { ctx, registrations } = contextStub({
		rpc: {
			call: async (route, endpoint, payload) => {
				calls.push({ route, endpoint, payload });
				return await answer(endpoint);
			},
		},
	});
	client.apply(ctx);
	const section = registrations.find((r) => r.options.name === "settings.section");
	assert.ok(section !== undefined);
	renderer.mount(section.component as () => unknown);
	return { calls, tree: () => renderer.tree() };
}

test("the settings tab holds module switches and the home path — no persona editors", async () => {
	const tab = mountSettings(async (endpoint) =>
		endpoint === "buddyPersona/preferences" ? { ok: true, value: PREFS } : { ok: true, value: { soul: "x", agents: "y", home: "/home/buddy" } },
	);
	await settle();
	const all = elements(tab.tree());
	assert.equal(all.filter((e) => e.type === "textarea").length, 0, "persona editing lives in the main panel now");
	assert.equal(all.filter((e) => e.type === "input").length, 0, "no raw checkboxes");
	assert.equal(all.filter((e) => e.props["role"] === "switch").length, 5, "one harness Switch per module");
	assert.ok(all.some((e) => e.props["children"] === "settings.buddy:homeLabel /home/buddy"));
});

test("toggling a module writes the whole sections object", async () => {
	const tab = mountSettings(async (endpoint) =>
		endpoint === "buddyPersona/preferences" || endpoint === "buddyPersona/updatePreferences"
			? { ok: true, value: PREFS }
			: { ok: true, value: { soul: "", agents: "", home: "/h" } },
	);
	await settle();
	flipSwitch(tab.tree(), "settings.buddy:telegramTitle");
	await settle();
	const write = tab.calls.find((call) => call.endpoint === "buddyPersona/updatePreferences");
	assert.deepEqual(write?.payload, {
		args: { patch: { panel: { sections: { soul: true, agents: true, skills: true, model: true, telegram: false } } } },
	});
});
