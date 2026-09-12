import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveBuddyPaths } from "../src/paths.ts";

test("an empty configured home falls back to the harness home", () => {
	const paths = resolveBuddyPaths("");
	assert.equal(paths.home.endsWith(join("buddy")), true, "default home must sit under the harness home");
	assert.equal(paths.soul, join(paths.home, "SOUL.md"));
	assert.equal(paths.agents, join(paths.home, "AGENTS.md"));
});

test("a whitespace-only configured home is treated as unset", () => {
	assert.equal(resolveBuddyPaths("   ").home, resolveBuddyPaths("").home);
});

test("a tilde-prefixed configured home expands against the OS home", () => {
	const paths = resolveBuddyPaths("~/buddy-test");
	assert.equal(paths.home, join(homedir(), "buddy-test"));
});

test("a relative configured home resolves to an absolute path", () => {
	const paths = resolveBuddyPaths("./rel-buddy");
	assert.equal(paths.home.startsWith("/") || /^[A-Za-z]:/.test(paths.home), true);
});

test("an absolute configured home is kept verbatim", () => {
	const paths = resolveBuddyPaths("/tmp/buddy-abs");
	assert.equal(paths.home, "/tmp/buddy-abs");
});
