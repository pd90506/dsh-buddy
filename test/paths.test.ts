import assert from "node:assert/strict";
import { test } from "node:test";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { resolveBuddyPaths } from "../src/paths.ts";

test("an empty configured home falls back to the harness home", () => {
	// `dshHomePath` reads the environment at call time, so pointing `$DSH_HOME`
	// at a throwaway directory observes the documented precedence for real: a
	// hardcoded default home cannot satisfy this, which is the whole point.
	const previous = process.env.DSH_HOME;
	const harnessHome = mkdtempSync(join(tmpdir(), "dsh-buddy-home-"));
	try {
		process.env.DSH_HOME = harnessHome;
		const paths = resolveBuddyPaths("");
		assert.equal(paths.home, join(harnessHome, "buddy"), "default home must sit under the harness home");
		assert.equal(paths.main, join(paths.home, "main"), "authored files live under main/");
		assert.equal(paths.soul, join(paths.main, "SOUL.md"));
		assert.equal(paths.agents, join(paths.main, "AGENTS.md"));
		assert.equal(paths.workspace, join(paths.main, "workspace"), "session cwd is main/workspace");
	} finally {
		if (previous === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = previous;
	}
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
	assert.equal(paths.home, resolve("./rel-buddy"));
});

test("an absolute configured home is kept verbatim", () => {
	const paths = resolveBuddyPaths("/tmp/buddy-abs");
	assert.equal(paths.home, "/tmp/buddy-abs");
});
