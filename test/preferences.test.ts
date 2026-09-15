import assert from "node:assert/strict";
import { test } from "node:test";
import { FALLBACK_CONFIG } from "../src/config.ts";
import { cleanPreferencesPatch } from "../src/persona/gateway.ts";

test("a model patch is completed from the current model and only strings are accepted", () => {
	const current = { ...FALLBACK_CONFIG, model: { provider: "p", model: "m", reasoningEffort: "low" } };
	assert.deepEqual(cleanPreferencesPatch(current, { model: { model: "m2", reasoningEffort: 3 } }), {
		model: { provider: "p", model: "m2", reasoningEffort: "low" },
	});
});

test("a panel patch accepts only the known module ids with boolean values", () => {
	assert.deepEqual(
		cleanPreferencesPatch(FALLBACK_CONFIG, { panel: { sections: { telegram: false, soul: "no", rogue: false } } }),
		{ panel: { sections: { soul: true, agents: true, skills: true, model: true, telegram: false } } },
	);
});

test("unknown top-level fields and malformed shapes produce an empty patch", () => {
	assert.deepEqual(cleanPreferencesPatch(FALLBACK_CONFIG, { home: "/elsewhere", model: "x", panel: [] }), {});
});

test("a skills patch copies only the reviewed switch, never an adjacent settings write", () => {
	// The panel owns exactly one field of `skills`, and this is a live settings
	// write: a patch that smuggled a second field must not reach the config, or
	// the review route and the budgets would become panel-writable.
	const current = {
		...FALLBACK_CONFIG,
		skills: { ...FALLBACK_CONFIG.skills, reviewProvider: "kept", reviewModel: "kept" },
	};
	assert.deepEqual(
		cleanPreferencesPatch(current, { skills: { enabled: false, reviewProvider: "evil", maxReviewSteps: 1 } }),
		{ skills: { ...current.skills, enabled: false } },
	);
});
