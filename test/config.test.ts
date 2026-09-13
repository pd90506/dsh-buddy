import assert from "node:assert/strict";
import { test } from "node:test";
import { Config, FALLBACK_CONFIG, PANEL_SECTION_IDS } from "../src/config.ts";

test("a silent document produces the documented defaults", () => {
	const resolved = Config({});
	assert.equal(resolved.home, "");
	assert.deepEqual(resolved.model, { provider: "", model: "", reasoningEffort: "" });
	assert.deepEqual(resolved.panel, { sections: { soul: true, agents: true, model: true, telegram: true } });
});

test("the fallback matches the schema defaults", () => {
	assert.deepEqual(JSON.parse(JSON.stringify(FALLBACK_CONFIG)), JSON.parse(JSON.stringify(Config({}))));
});

test("an explicit home survives resolution", () => {
	assert.equal(Config({ home: "~/elsewhere" }).home, "~/elsewhere");
});

test("a partial model and a partial panel are completed from defaults", () => {
	const resolved = Config({ model: { provider: "p" }, panel: { sections: { telegram: false } } } as never);
	assert.deepEqual(resolved.model, { provider: "p", model: "", reasoningEffort: "" });
	assert.deepEqual(resolved.panel.sections, { soul: true, agents: true, model: true, telegram: false });
});

test("the panel section ids are the four modules, in display order", () => {
	assert.deepEqual([...PANEL_SECTION_IDS], ["soul", "agents", "model", "telegram"]);
});
