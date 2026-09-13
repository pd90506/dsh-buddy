/**
 * Configuration resolution: the working directory decides the sandbox root for
 * every Telegram session, so it must always come out absolute.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { DEFAULT_CWD, expandHome, isPermissionPreset, resolveDefaultCwd } from "../../src/telegram/config.ts";

test("expandHome handles ~, ~/x and plain paths", () => {
	assert.equal(expandHome("~", "/home/u"), "/home/u");
	assert.equal(expandHome("~/dsh-telegram", "/home/u"), "/home/u/dsh-telegram");
	assert.equal(expandHome("/abs/path", "/home/u"), "/abs/path");
	assert.equal(expandHome("relative/path", "/home/u"), "relative/path");
});

test("resolveDefaultCwd returns an absolute path for every accepted input", () => {
	assert.equal(resolveDefaultCwd({ defaultCwd: "/srv/work" }), "/srv/work");
	assert.equal(resolveDefaultCwd({ defaultCwd: "~/dsh-telegram" }).startsWith("/"), true);
	assert.equal(resolveDefaultCwd({ defaultCwd: "" }).endsWith(join("main", "workspace")), true);
	assert.equal(resolveDefaultCwd({ defaultCwd: "   " }).endsWith(join("main", "workspace")), true);
	assert.equal(resolveDefaultCwd({ defaultCwd: "relative" }).startsWith("/"), true);
});

test("the documented default is the buddy workspace under main/, always absolute", () => {
	assert.equal(DEFAULT_CWD.startsWith("/"), true);
	assert.equal(DEFAULT_CWD.endsWith(join("buddy", "main", "workspace")), true);
	assert.ok(!resolveDefaultCwd({ defaultCwd: DEFAULT_CWD }).endsWith(join("workspace", "..")));
});

test("only the three known permission presets are accepted", () => {
	assert.equal(isPermissionPreset("read-only"), true);
	assert.equal(isPermissionPreset("workspace-write"), true);
	assert.equal(isPermissionPreset("danger-full-access"), true);
	assert.equal(isPermissionPreset("yolo"), false);
	assert.equal(isPermissionPreset(""), false);
});
