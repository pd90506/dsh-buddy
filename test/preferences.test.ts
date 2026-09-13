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
		{ panel: { sections: { soul: true, agents: true, model: true, telegram: false } } },
	);
});

test("unknown top-level fields and malformed shapes produce an empty patch", () => {
	assert.deepEqual(cleanPreferencesPatch(FALLBACK_CONFIG, { home: "/elsewhere", model: "x", panel: [] }), {});
});
