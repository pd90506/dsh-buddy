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

/**
 * Who a `buddy` preset directory belongs to.
 *
 * A panel needs this because the two failure modes look identical from the
 * outside — no `buddy-skills-agent` row ever arrives — and the fix differs:
 * `"plugin"` means the plugin owns the directory and will sync it on the next
 * release, `"user"` means a hand-written preset occupies the id and the plugin
 * will never touch it, so only the user can resolve it.
 */
export type PresetOwnership = "absent" | "plugin" | "user";

/**
 * The sha256 of every template file this plugin has ever published.
 *
 * **Append to this table whenever a template file's bytes change.** It is what
 * makes a pre-marker install provable as the plugin's own output: the old
 * `installPreset` wrote no marker, so a directory the plugin itself installed
 * looks exactly like a hand-written one, and without this record the ownership
 * rule ("unmarked = the user's") keeps it forever — silently freezing every
 * later row out of that install.
 *
 * Deliberately an explicit list. Scanning a git history or fetching a hash
 * cannot work: neither exists on a user's machine, and an unbounded rule
 * ("anything that looks like our template") is how a hand-edit gets
 * overwritten. Every entry was verified against the commit that published it.
 */
const PUBLISHED_TEMPLATE_HASHES: Record<string, readonly string[]> = {
	"agent.cordis.yml": [
		// 9ac9ca2 (provisional)
		"451ccc7ed34c02282aeb5e1f2b441e1951b848596d10bfec8d63e60aab180337",
		// 9d393f7
		"b7a3d0a1fba93d47fe5be26951946c21bf4c071c7cad37cca0bb0dc85a8667d8",
		// 0b7cad8
		"67a8042208047bd7f3c9000fd5f68999c92a42c537e21103ad3c457e3a5ef83d",
		// 3a0028c
		"ee5a74423496f7cbc38452ae19e24f491219d5498e8f3b39a2653a566f0e4ff5",
		// 59b9e98 — the bytes a real machine's unmarked install held
		"731b2258190785f8827f5c68a5e742864fcafc59bbb707586fbb95c8fa7c58b8",
		// d4e1607 — the template Task 10 published, and the current one
		"2c5e5f59990e494026fed63093e68fb4f3b216e4d544d19f6158b7c51e16f291",
	],
	// `preset.yml` has never changed, so it has exactly one published value.
	"preset.yml": ["eaf479947aa348633ce2d0ca44494f26433e832086f7576e4e7e23291914267c"],
};

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
 * Whether an unmarked, non-empty directory is provably this plugin's own old
 * output.
 *
 * Strict on purpose — a wrong claim overwrites a human's preset, while a missed
 * claim only leaves an install the user can delete. Both conditions must hold:
 * the entry set is exactly {@link PRESET_FILES} (an extra `.bak` beside a
 * pristine pair means a human was in there; the plugin's own sync never leaves
 * one next to files it wrote itself), and every file's sha256 appears in that
 * file's row of {@link PUBLISHED_TEMPLATE_HASHES}.
 * @param targetDir - the preset directory.
 * @param entries - its current entry names, as `readdir` reported them.
 * @returns `true` when the directory may be claimed and marked.
 */
async function isLegacyInstall(targetDir: string, entries: readonly string[]): Promise<boolean> {
	if (entries.length !== PRESET_FILES.length) return false;
	if (!PRESET_FILES.every((file) => entries.includes(file))) return false;
	for (const file of PRESET_FILES) {
		const published = PUBLISHED_TEMPLATE_HASHES[file];
		if (published === undefined) return false;
		const current = await hashFile(join(targetDir, file)).catch(() => undefined);
		if (current === undefined || !published.includes(current)) return false;
	}
	return true;
}

/**
 * Classify the `buddy` preset directory for the panel.
 *
 * Follows {@link syncPreset}'s own decision order and, like it, is total: a
 * missing, unreadable or empty directory is `"absent"` rather than an error, so
 * a panel can ask at any time without a try/catch. Only the marker decides
 * between `"plugin"` and `"user"` here — an unmarked directory is the user's
 * until a sync proves otherwise and marks it, which is also why this reports
 * `"user"` for a pristine legacy install that has not been synced yet.
 * @param targetDir - the preset directory.
 * @returns who the directory belongs to.
 */
export async function presetOwnership(targetDir: string): Promise<PresetOwnership> {
	const entries = await readdir(targetDir).catch(() => undefined);
	if (entries === undefined || entries.length === 0) return "absent";
	return existsSync(join(targetDir, GENERATED_MARKER)) ? "plugin" : "user";
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
 *    preset, with one exception: when the entry set is exactly
 *    {@link PRESET_FILES} and every file's sha256 is one this plugin published
 *    ({@link PUBLISHED_TEMPLATE_HASHES}), it is this plugin's own pre-marker
 *    output — the old installer wrote no marker — so it is CLAIMED: the marker
 *    is written with the on-disk bytes as the baseline, and the sync continues
 *    through case 3. Anything else is the user's: touch nothing, return `kept`;
 * 3. it exists with the marker → compare file by file. An identical file is
 *    left alone. A differing file is overwritten; if its current bytes do not
 *    hash to the baseline (or it has no baseline entry, or the marker could
 *    not be trusted at all) it cannot be proven unedited, so it is copied to
 *    `<file>.bak` first — `backed-up-synced` — otherwise `synced`. A claimed
 *    directory's baseline is what it held a moment ago, so its upgrade is
 *    silent: no `.bak`.
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
	if (!existsSync(markerPath)) {
		if (!(await isLegacyInstall(targetDir, existing))) return "kept";
		// The marker's baseline is written from what is on disk NOW, which is
		// the legacy bytes, so case 3 sees files that still match their own
		// baseline and upgrades them without a backup.
		await writeMarker(targetDir);
	}
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
