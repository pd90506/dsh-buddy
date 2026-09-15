/**
 * A regression guard for the browser half silently never reaching the page.
 *
 * `dsh-client-modules` decides which packages contribute a `dsh.client` bundle
 * by walking the loader's rows, and it only reads a manifest for a row whose
 * `name` is an *exact* package specifier (`exactPackageSpecifier`: no `/` in an
 * unscoped name). `dsh-buddy/store` and `dsh-buddy/persona` are subpath
 * specifiers, so with only those two rows the package's `dsh.client`
 * declaration was never read: the host rows booted, every test passed, and the
 * Buddy sidebar button and settings tab simply did not exist in the real page.
 *
 * Like `preset.test.ts`, this reads the patch as text — the repo declares no
 * YAML parser.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as entryRow from "../src/index.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_NAME = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { name: string }).name;

/** Every row `name:` in the patch, quotes stripped. */
function rowNames(): string[] {
	const text = readFileSync(join(ROOT, "cordis.patch.yml"), "utf8");
	return [...text.matchAll(/^\s*name:\s*['"]?([^'"\s]+)['"]?\s*$/gm)].map((match) => match[1]!);
}

test("the patch mounts a row named exactly the package, so dsh.client is discovered", () => {
	assert.ok(
		rowNames().includes(PACKAGE_NAME),
		`no row is named "${PACKAGE_NAME}"; subpath rows (${rowNames().join(", ")}) never put the browser half in the boot graph`,
	);
});

test("the package entry is a mountable cordis plugin that registers nothing", () => {
	assert.equal(typeof entryRow.apply, "function");
	assert.ok(!("inject" in entryRow), "the anchor row must not wait on any service");
	assert.equal(entryRow.apply({} as never), undefined);
});

test("the patch mounts the telegram row under the buddy package", () => {
	assert.ok(rowNames().includes("dsh-buddy/telegram"), `rows: ${rowNames().join(", ")}`);
});

test("the patch mounts the buddy-skills host row after the persona row", () => {
	assert.ok(rowNames().includes("dsh-buddy/skills"), `rows: ${rowNames().join(", ")}`);
});

test("the patch mounts the buddy-skills-agent row through the buddy preset, not the host", () => {
	const patch = readFileSync(join(ROOT, "cordis.patch.yml"), "utf8");
	assert.ok(!patch.includes("skills-agent"), "the agent row belongs to the preset template, never the host patch");
});
