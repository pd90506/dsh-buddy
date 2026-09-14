import assert from "node:assert/strict";
import { test } from "node:test";
import { Config, FALLBACK_CONFIG, PANEL_SECTION_IDS, type BuddyConfig } from "../src/config.ts";

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

test("skills settings carry the reference defaults", () => {
	const resolved = Config({} as never) as BuddyConfig;
	assert.equal(resolved.skills.enabled, true);
	assert.equal(resolved.skills.creationNudgeInterval, 10);
	assert.equal(resolved.skills.maxReviewSteps, 16);
	assert.equal(resolved.skills.maxInputTokens, 600000);
	assert.equal(resolved.skills.writeApproval, false);
	assert.equal(resolved.skills.ledger, true);
	assert.equal(resolved.skills.reviewProvider, "");
	assert.equal(resolved.skills.reviewModel, "");
});
