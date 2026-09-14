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
 * **It is a generated artifact, not a user file.** Every later phase adds a row
 * to the same `agent.cordis.yml`, so "write only when nothing is there yet"
 * made the plugin's own roadmap silently inert: the feature installed, ran, and
 * did nothing. What made that rule necessary was that nothing could tell a
 * hand-edit from a template that had moved on. The marker answers that:
 * {@link GENERATED_MARKER} records the plugin's marker version and, per
 * template file, the sha256 of the bytes the plugin last wrote. A file whose
 * current bytes still hash to that baseline is the plugin's to overwrite; one
 * that differs was edited by a human, and is copied to `<file>.bak` before the
 * overwrite rather than discarded. A directory with no marker at all is not
 * the plugin's, and is left alone entirely.
 *
 * A user who wants different wiring copies the preset to a new id — the
 * harness's `agentPresets.copy`, which the GUI exposes as "copy preset" — and
 * edits that copy, which this module never touches.
 * @module dsh-buddy/store/preset
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUDDY_PRESET_ID } from "../index.ts";

/** The files the template consists of. */
const PRESET_FILES = ["agent.cordis.yml", "preset.yml"] as const;

/**
 * The marker that declares a preset directory a plugin artifact.
 *
 * Its presence is the ownership signal. Its contents are the baseline the
 * "did a human edit this?" question is answered against — a bare presence flag
 * could say the directory is ours, but not that a file inside it is untouched.
 */
export const GENERATED_MARKER = ".dsh-buddy-generated";

/**
 * The marker document's own version.
 *
 * A marker from a version this build does not know is never interpreted: its
 * hashes may mean something else there, and guessing wrong either overwrites a
 * hand-edit without a backup or backs up the plugin's own output forever.
 */
const MARKER_VERSION = 1;

/** What a hand-edited file is preserved as before it is overwritten. */
const BACKUP_SUFFIX = ".bak";

/** What a sync did to the preset's files. */
export type PresetSyncResult = "installed" | "synced" | "kept" | "backed-up-synced";

/**
 * sha256 hex of some bytes, exactly as the marker records it.
 * @param bytes - the content to hash.
 * @returns the lowercase hex digest.
 */
function sha256Of(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/**
 * sha256 hex of a file's current bytes.
 * @param path - the file to hash.
 * @returns the lowercase hex digest.
 */
async function hashFile(path: string): Promise<string> {
	return sha256Of(await readFile(path));
}

/**
 * Read the marker's per-file baseline.
 * @param markerPath - the marker document.
 * @returns the file-name → sha256 map the plugin last wrote, or `undefined`
 * when no baseline can be trusted — the document is missing, empty, malformed,
 * or from a marker version this build does not know.
 */
async function readBaseline(markerPath: string): Promise<Record<string, string> | undefined> {
	const raw = await readFile(markerPath, "utf8").catch(() => undefined);
	if (raw === undefined) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		// An empty or truncated marker is still OURS; it just has no baseline.
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const document = parsed as { version?: unknown; files?: unknown };
	if (document.version !== MARKER_VERSION) return undefined;
	if (typeof document.files !== "object" || document.files === null) return undefined;
	const files: Record<string, string> = {};
	for (const [name, hash] of Object.entries(document.files)) {
		if (typeof hash === "string") files[name] = hash;
	}
	return files;
}

/**
 * Whether a baseline covers every template file.
 * @param baseline - the map {@link readBaseline} returned.
 * @returns `true` when every {@link PRESET_FILES} entry carries a hash.
 */
function coversEveryFile(baseline: Record<string, string> | undefined): boolean {
	return baseline !== undefined && PRESET_FILES.every((file) => typeof baseline[file] === "string");
}

/**
 * Rewrite the marker so it records exactly what is on disk now.
 *
 * Runs after every sync. A baseline that lagged the files it describes would
 * report `backed-up-synced` forever, backing up the plugin's own output; this
 * is also what repairs a marker whose baseline was unreadable or incomplete.
 * @param targetDir - the preset directory.
 */
async function writeMarker(targetDir: string): Promise<void> {
	const files: Record<string, string> = {};
	for (const file of PRESET_FILES) files[file] = await hashFile(join(targetDir, file));
	const document = { generator: "dsh-buddy", version: MARKER_VERSION, files };
	await writeFile(join(targetDir, GENERATED_MARKER), `${JSON.stringify(document, null, 2)}\n`, "utf8");
}

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
 * Synchronize the `buddy` preset with the shipped template.
 *
 * The decision order is the design spec's (2026-09-13, §5.2):
 *
 * 1. the directory is absent, or exists with no entries at all → write the
 *    template and the marker, return `installed`. An empty directory holds
 *    nothing to preserve, which is the distinction the pre-marker
 *    implementation drew between "no entries" and "one file present";
 * 2. it exists with entries but no marker → it is the user's own `buddy`
 *    preset; touch nothing, return `kept`;
 * 3. it exists with the marker → compare file by file. An identical file is
 *    left alone. A differing file is overwritten; if its current bytes do not
 *    hash to the baseline (or it has no baseline entry, or the marker could
 *    not be trusted at all) it cannot be proven unedited, so it is copied to
 *    `<file>.bak` first — `backed-up-synced` — otherwise `synced`.
 *
 * @param targetDir - where the preset belongs.
 * @param templateDir - the shipped template directory.
 * @returns what the sync did to the preset's files. A repaired marker alone
 * does not make the result `synced`: the return value describes the preset's
 * files, and `kept` means none of them needed writing.
 */
export async function syncPreset(targetDir: string, templateDir: string): Promise<PresetSyncResult> {
	const existing = await readdir(targetDir).catch(() => undefined);
	if (existing === undefined || existing.length === 0) {
		await mkdir(targetDir, { recursive: true });
		for (const file of PRESET_FILES) await copyFile(join(templateDir, file), join(targetDir, file));
		await writeMarker(targetDir);
		return "installed";
	}
	const markerPath = join(targetDir, GENERATED_MARKER);
	if (!existsSync(markerPath)) return "kept";
	const baseline = await readBaseline(markerPath);
	let wrote = false;
	let backedUp = false;
	for (const file of PRESET_FILES) {
		// Read every source before writing anything: a damaged template must
		// fail the sync whole, not leave the preset half-updated.
		const incoming = await readFile(join(templateDir, file));
		const current = await readFile(join(targetDir, file)).catch(() => undefined);
		if (current !== undefined && current.equals(incoming)) continue;
		const recorded = baseline?.[file];
		if (current !== undefined && (recorded === undefined || sha256Of(current) !== recorded)) {
			await writeFile(join(targetDir, `${file}${BACKUP_SUFFIX}`), current);
			backedUp = true;
		}
		await writeFile(join(targetDir, file), incoming);
		wrote = true;
	}
	if (wrote || !coversEveryFile(baseline)) await writeMarker(targetDir);
	if (!wrote) return "kept";
	return backedUp ? "backed-up-synced" : "synced";
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
