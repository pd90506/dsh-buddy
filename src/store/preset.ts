/**
 * Shipping the `buddy` agent preset with the plugin.
 *
 * The preset is what makes a session a buddy session — it stamps
 * `SessionHeader.agentPreset` and carries the persona row — so requiring the
 * user to hand-copy a directory would make the plugin useless until they did.
 *
 * The template is a composition that was produced by copying the shipped
 * `standard` preset and proven to mount before it was committed; it is never
 * hand-authored, because a composition written from scratch tends to forget an
 * isolate realm or a consumer row.
 *
 * **Never overwrite.** Once the directory exists it belongs to the user, who may
 * have edited it. An upgrade that silently reverted their preset would be a far
 * worse failure than an out-of-date template.
 * @module dsh-buddy/store/preset
 */
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUDDY_PRESET_ID } from "../index.ts";

/** The files the template consists of. */
const PRESET_FILES = ["agent.cordis.yml", "preset.yml"] as const;

/**
 * Where an authored preset named `buddy` belongs.
 * @param dshHome - the resolved harness home.
 * @returns the preset directory path.
 */
export function presetTargetDir(dshHome: string): string {
	// The install directory name IS the preset id — `BUDDY_PRESET_ID`, not a
	// restated literal, because the harness resolves an agent preset by
	// looking up this exact directory name under `.agent-presets/`.
	return join(dshHome, ".agent-presets", BUDDY_PRESET_ID);
}

/**
 * Install the preset if, and only if, nothing is there yet.
 *
 * Presence is judged on the directory having any entry at all, not on one file:
 * a user who deleted `preset.yml` on purpose should not have it restored.
 * @param targetDir - where the preset belongs.
 * @param templateDir - the shipped template directory.
 * @returns `installed` when files were written, `kept` when the user's own copy was left alone.
 */
export async function installPreset(targetDir: string, templateDir: string): Promise<"installed" | "kept"> {
	const existing = await readdir(targetDir).catch(() => undefined);
	if (existing !== undefined && existing.length > 0) return "kept";
	await mkdir(targetDir, { recursive: true });
	for (const file of PRESET_FILES) await copyFile(join(templateDir, file), join(targetDir, file));
	return "installed";
}

/**
 * Locate the shipped template directory relative to the *calling* module.
 *
 * The built artifact and the source module under test are not the same
 * number of directories below the package root, so a single fixed relative
 * expression cannot serve both:
 *
 * - `lib/store.js` (what ships, and what `import.meta.url` is at runtime) sits
 *   ONE directory below the package root, so the template is `../assets/preset`.
 * - `src/store/index.ts` (what every test imports directly — Node's
 *   type-stripping runs `.ts` in place rather than transpiling it into `lib`
 *   first) sits TWO directories below the package root, so from there the
 *   template is `../../assets/preset`.
 *
 * Trying the built-artifact candidate first and falling back to the
 * source-under-test candidate means both call sites resolve to the real
 * `assets/preset` — never a path that silently doesn't exist, which would
 * otherwise make the installer a no-op (via the boot's `.catch`) on every
 * single test run and leave the mount path uncovered.
 * @param moduleUrl - the caller's own `import.meta.url`.
 * @returns the resolved template directory. Not guaranteed to exist — a
 * damaged install (a package with no `assets` at all) still returns the
 * built-artifact candidate, and the caller's own error handling covers that.
 */
export function resolveTemplateDir(moduleUrl: string | URL): string {
	const moduleDir = dirname(fileURLToPath(moduleUrl));
	const builtLayout = join(moduleDir, "..", "assets", "preset");
	if (existsSync(builtLayout)) return builtLayout;
	const sourceLayout = join(moduleDir, "..", "..", "assets", "preset");
	return sourceLayout;
}
