import assert from "node:assert/strict";
import { test } from "node:test";
import { Config, FALLBACK_CONFIG } from "../src/config.ts";

test("a silent document produces the documented defaults", () => {
	const resolved = Config({});
	assert.equal(resolved.home, "");
	assert.equal(resolved.panelOrder, 10);
});

test("the fallback matches the schema defaults", () => {
	assert.deepEqual({ ...FALLBACK_CONFIG }, { ...Config({}) });
});

test("an explicit home survives resolution", () => {
	assert.equal(Config({ home: "~/elsewhere" }).home, "~/elsewhere");
});

test("an explicit panelOrder survives resolution", () => {
	// `panelOrder` exists only so the sidebar position is not hardcoded, and the
	// three tests above all stay green if it were pinned to a constant 10. This
	// is the one assertion that fails when the value stops being tunable.
	assert.equal(Config({ panelOrder: 5 }).panelOrder, 5);
});
