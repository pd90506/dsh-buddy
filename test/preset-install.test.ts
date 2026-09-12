import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installPreset, presetTargetDir, resolveTemplateDir } from "../src/store/preset.ts";

/** A stand-in template directory. */
async function template(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "dsh-buddy-tpl-"));
	await writeFile(join(dir, "agent.cordis.yml"), "- id: persona\n", "utf8");
	await writeFile(join(dir, "preset.yml"), "name: Buddy\n", "utf8");
	return dir;
}

test("the preset lands under the harness home's authored-preset root", () => {
	assert.equal(presetTargetDir("/home/u/.dsh"), join("/home/u/.dsh", ".agent-presets", "buddy"));
});

test("an absent preset directory is created from the template", async () => {
	const target = join(await mkdtemp(join(tmpdir(), "dsh-buddy-home-")), ".agent-presets", "buddy");
	assert.equal(await installPreset(target, await template()), "installed");
	assert.equal(await readFile(join(target, "agent.cordis.yml"), "utf8"), "- id: persona\n");
	assert.equal(await readFile(join(target, "preset.yml"), "utf8"), "name: Buddy\n");
});

test("an existing preset is never overwritten", async () => {
	const target = join(await mkdtemp(join(tmpdir(), "dsh-buddy-home-")), ".agent-presets", "buddy");
	await mkdir(target, { recursive: true });
	await writeFile(join(target, "agent.cordis.yml"), "MINE\n", "utf8");
	assert.equal(await installPreset(target, await template()), "kept");
	assert.equal(await readFile(join(target, "agent.cordis.yml"), "utf8"), "MINE\n");
});

test("installing twice is idempotent and keeps the first result", async () => {
	const target = join(await mkdtemp(join(tmpdir(), "dsh-buddy-home-")), ".agent-presets", "buddy");
	const tpl = await template();
	assert.equal(await installPreset(target, tpl), "installed");
	assert.equal(await installPreset(target, tpl), "kept");
});

// ── edge case the brief's doc comment calls out but does not test ──────────

test("an existing but empty preset directory is treated as absent and gets installed", async () => {
	// The doc comment on `installPreset` distinguishes "no entries at all" from
	// "one file present": an implementation that instead judges presence with
	// `existsSync(targetDir)` would wrongly return "kept" here and leave the
	// directory empty, since `mkdtemp` + a bare `mkdir(target)` creates the
	// directory itself but writes nothing inside it.
	const target = join(await mkdtemp(join(tmpdir(), "dsh-buddy-home-")), ".agent-presets", "buddy");
	await mkdir(target, { recursive: true });
	assert.equal(await installPreset(target, await template()), "installed");
	assert.equal(await readFile(join(target, "preset.yml"), "utf8"), "name: Buddy\n");
});

// ── resolveTemplateDir: the built-artifact vs. source-under-test split ─────
//
// `lib/store.js` (the built artifact) sits one directory below the package
// root; `src/store/index.ts` (what every test imports directly, since Node's
// type-stripping runs it in place rather than transpiling to `lib` first)
// sits two directories below it. A resolver hardcoded to either depth alone
// silently misses the other — that is hazard 2 from the task brief. These
// tests use the real files this package ships, not synthetic fixtures, so
// they exercise exactly the two shapes `resolveTemplateDir` must handle.

/** Absolute path to this package's shipped `assets/preset`. */
const REAL_TEMPLATE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "preset");

test("resolveTemplateDir finds the template from the built artifact's location", () => {
	// `pretest` always builds `lib/store.js` before `node --test` runs, so this
	// file exists for real; the URL below is exactly what `import.meta.url`
	// evaluates to inside that built module.
	const asBuilt = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "store.js"));
	assert.equal(resolveTemplateDir(asBuilt), REAL_TEMPLATE_DIR);
	assert.equal(existsSync(resolveTemplateDir(asBuilt)), true);
});

test("resolveTemplateDir finds the template when running from source, as tests do", () => {
	// This is the exact module URL `src/store/index.ts` sees at its own
	// `import.meta.url` when a test imports it directly.
	const asSource = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "store", "index.ts"));
	assert.equal(resolveTemplateDir(asSource), REAL_TEMPLATE_DIR);
	assert.equal(existsSync(resolveTemplateDir(asSource)), true);
});
