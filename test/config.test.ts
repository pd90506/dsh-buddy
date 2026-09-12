import assert from "node:assert/strict";
import { test } from "node:test";
import { Config, FALLBACK_CONFIG } from "../src/config.ts";

test("a silent document produces the documented defaults", () => {
	const resolved = Config({});
	assert.equal(resolved.home, "");
});

test("the fallback matches the schema defaults", () => {
	assert.deepEqual({ ...FALLBACK_CONFIG }, { ...Config({}) });
});

test("an explicit home survives resolution", () => {
	assert.equal(Config({ home: "~/elsewhere" }).home, "~/elsewhere");
});
