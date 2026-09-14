/**
 * The `buddy` preset is a plugin GENERATED ARTIFACT, not a user file: the
 * store row rewrites it on upgrade so every later phase can add its row to the
 * same `agent.cordis.yml`. The safety property that replaced "never write" is
 * the marker: `.dsh-buddy-generated` records the plugin's marker version and,
 * per template file, the sha256 of the bytes the plugin last wrote. That
 * baseline is what separates "the template moved on" (overwrite silently) from
 * "a human edited this" (back the file up first).
 *
 * These tests drive `syncPreset` against real temp directories — never
 * `~/.dsh` — and each case removes its own scratch root in a `finally`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GENERATED_MARKER, presetTargetDir, resolveTemplateDir, syncPreset } from "../src/store/preset.ts";

/** sha256 hex of a file's bytes — the value the marker records per template file. */
async function sha256(path: string): Promise<string> {
	return createHash("sha256").update(await readFile(path)).digest("hex");
}

/** A scratch harness home, a template directory, and the preset target inside the home. */
interface Fixture {
	/** `~/.dsh/.agent-presets/buddy` under the scratch home. */
	readonly target: string;
	/** The shipped-template stand-in. */
	readonly template: string;
	/** One file inside the template directory. */
	templateFile(name: string): string;
	/** Remove the whole scratch root. */
	cleanup(): Promise<void>;
}

/** Build a {@link Fixture}; the caller owns `cleanup()` in a `finally`. */
async function fixture(): Promise<Fixture> {
	const root = await mkdtemp(join(tmpdir(), "dsh-buddy-preset-"));
	const template = join(root, "template");
	await mkdir(template, { recursive: true });
	await writeFile(join(template, "agent.cordis.yml"), "- id: persona\n", "utf8");
	await writeFile(join(template, "preset.yml"), "name: Buddy\n", "utf8");
	return {
		target: join(root, "home", ".agent-presets", "buddy"),
		template,
		templateFile: (name) => join(template, name),
		cleanup: () => rm(root, { recursive: true, force: true }),
	};
}

/** The marker document, as the plugin writes it. */
interface MarkerDocument {
	version?: unknown;
	files?: Record<string, string>;
}

test("the preset lands under the harness home's authored-preset root", () => {
	assert.equal(presetTargetDir("/home/u/.dsh"), join("/home/u/.dsh", ".agent-presets", "buddy"));
});

// ── the decision table (design spec §5.2) ──────────────────────────────────

test("a fresh directory gets the template plus the generated marker", async () => {
	const f = await fixture();
	try {
		assert.equal(await syncPreset(f.target, f.template), "installed");
		assert.equal(existsSync(join(f.target, GENERATED_MARKER)), true);
		assert.equal(await readFile(join(f.target, "agent.cordis.yml"), "utf8"), "- id: persona\n");
		assert.equal(await readFile(join(f.target, "preset.yml"), "utf8"), "name: Buddy\n");
		// The marker is a baseline, not a bare presence flag: without the hashes
		// the next sync could not tell a hand-edit from a template that moved on.
		const marker = JSON.parse(await readFile(join(f.target, GENERATED_MARKER), "utf8")) as MarkerDocument;
		assert.equal(marker.version, 1);
		assert.equal(marker.files?.["agent.cordis.yml"], await sha256(join(f.target, "agent.cordis.yml")));
		assert.equal(marker.files?.["preset.yml"], await sha256(join(f.target, "preset.yml")));
	} finally {
		await f.cleanup();
	}
});

test("an existing but empty preset directory is treated as absent and gets installed", async () => {
	// An empty directory holds nothing to preserve, so it is not "the user's
	// preset" — the same distinction the pre-marker implementation drew between
	// "no entries at all" and "one file present".
	const f = await fixture();
	try {
		await mkdir(f.target, { recursive: true });
		assert.equal(await syncPreset(f.target, f.template), "installed");
		assert.equal(await readFile(join(f.target, "preset.yml"), "utf8"), "name: Buddy\n");
	} finally {
		await f.cleanup();
	}
});

test("an unmarked directory belongs to the user and is never touched", async () => {
	const f = await fixture();
	try {
		await mkdir(f.target, { recursive: true });
		await writeFile(join(f.target, "agent.cordis.yml"), "mine\n", "utf8");
		assert.equal(await syncPreset(f.target, f.template), "kept");
		assert.equal(await readFile(join(f.target, "agent.cordis.yml"), "utf8"), "mine\n");
		// Not even the marker: adopting someone else's directory is the one thing
		// the marker must never do.
		assert.equal(existsSync(join(f.target, GENERATED_MARKER)), false);
		assert.equal(existsSync(join(f.target, "agent.cordis.yml.bak")), false);
	} finally {
		await f.cleanup();
	}
});

test("installing twice with the same template is idempotent", async () => {
	const f = await fixture();
	try {
		assert.equal(await syncPreset(f.target, f.template), "installed");
		assert.equal(await syncPreset(f.target, f.template), "kept");
		assert.equal(existsSync(join(f.target, "agent.cordis.yml.bak")), false);
	} finally {
		await f.cleanup();
	}
});

test("a marked install is synced when the template moves on", async () => {
	const f = await fixture();
	try {
		// The installed version's template wrote `old`; the marker records it.
		await writeFile(f.templateFile("agent.cordis.yml"), "old\n", "utf8");
		assert.equal(await syncPreset(f.target, f.template), "installed");
		// The next version moves that file on. Nobody touched the install, so the
		// on-disk bytes still hash to the baseline and the overwrite is silent.
		await writeFile(f.templateFile("agent.cordis.yml"), "new\n", "utf8");
		assert.equal(await syncPreset(f.target, f.template), "synced");
		assert.equal(await readFile(join(f.target, "agent.cordis.yml"), "utf8"), "new\n");
		assert.equal(existsSync(join(f.target, "agent.cordis.yml.bak")), false);
	} finally {
		await f.cleanup();
	}
});

test("a hand-edited marked install is backed up before being overwritten", async () => {
	const f = await fixture();
	try {
		assert.equal(await syncPreset(f.target, f.template), "installed");
		await writeFile(join(f.target, "agent.cordis.yml"), "hand edited\n", "utf8");
		await writeFile(f.templateFile("agent.cordis.yml"), "new\n", "utf8");
		assert.equal(await syncPreset(f.target, f.template), "backed-up-synced");
		assert.equal(await readFile(join(f.target, "agent.cordis.yml.bak"), "utf8"), "hand edited\n");
		assert.equal(await readFile(join(f.target, "agent.cordis.yml"), "utf8"), "new\n");
		// The sync rewrote the marker's baseline to what it just wrote, so the
		// NEXT template move is silent — without that rewrite every later sync
		// would see the old baseline, call the file hand-edited, and back it up
		// again forever.
		await writeFile(f.templateFile("agent.cordis.yml"), "newer\n", "utf8");
		assert.equal(await syncPreset(f.target, f.template), "synced");
		assert.equal(await readFile(join(f.target, "agent.cordis.yml"), "utf8"), "newer\n");
		assert.equal(await readFile(join(f.target, "agent.cordis.yml.bak"), "utf8"), "hand edited\n");
	} finally {
		await f.cleanup();
	}
});

// ── a marker that is unreadable is still ours (the safety valve) ───────────
//
// The marker file is what declares the directory a plugin artifact. If it is
// present but its baseline cannot be read — empty, malformed, an unknown
// future version, or missing an entry — the install is still the plugin's, so
// it syncs; but nothing can prove a given file is unedited, so every file it
// overwrites is backed up first and the marker is repaired.

test("a marker with an unreadable baseline still syncs, backs up what it overwrites, and is repaired", async () => {
	const f = await fixture();
	try {
		assert.equal(await syncPreset(f.target, f.template), "installed");
		await writeFile(join(f.target, GENERATED_MARKER), "", "utf8");
		await writeFile(f.templateFile("agent.cordis.yml"), "new\n", "utf8");
		assert.equal(await syncPreset(f.target, f.template), "backed-up-synced");
		assert.equal(await readFile(join(f.target, "agent.cordis.yml.bak"), "utf8"), "- id: persona\n");
		assert.equal(await readFile(join(f.target, "agent.cordis.yml"), "utf8"), "new\n");
		// Only what it actually overwrote is backed up.
		assert.equal(existsSync(join(f.target, "preset.yml.bak")), false);
		const marker = JSON.parse(await readFile(join(f.target, GENERATED_MARKER), "utf8")) as MarkerDocument;
		assert.equal(marker.version, 1);
		assert.equal(marker.files?.["agent.cordis.yml"], await sha256(join(f.target, "agent.cordis.yml")));
		assert.equal(marker.files?.["preset.yml"], await sha256(join(f.target, "preset.yml")));
	} finally {
		await f.cleanup();
	}
});

test("an unknown future marker version is not trusted as a baseline", async () => {
	const f = await fixture();
	try {
		assert.equal(await syncPreset(f.target, f.template), "installed");
		// Readable JSON and a correct-looking hash, but a version this build does
		// not know: the hashes may mean something else in that version.
		const future = {
			generator: "dsh-buddy",
			version: 99,
			files: { "agent.cordis.yml": await sha256(join(f.target, "agent.cordis.yml")) },
		};
		await writeFile(join(f.target, GENERATED_MARKER), `${JSON.stringify(future, null, 2)}\n`, "utf8");
		await writeFile(f.templateFile("agent.cordis.yml"), "new\n", "utf8");
		assert.equal(await syncPreset(f.target, f.template), "backed-up-synced");
		assert.equal(await readFile(join(f.target, "agent.cordis.yml.bak"), "utf8"), "- id: persona\n");
	} finally {
		await f.cleanup();
	}
});

test("a marker with no baseline entry for a file backs that file up", async () => {
	const f = await fixture();
	try {
		assert.equal(await syncPreset(f.target, f.template), "installed");
		const markerPath = join(f.target, GENERATED_MARKER);
		const marker = JSON.parse(await readFile(markerPath, "utf8")) as { files: Record<string, string> };
		delete marker.files["agent.cordis.yml"];
		await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
		await writeFile(f.templateFile("agent.cordis.yml"), "new\n", "utf8");
		assert.equal(await syncPreset(f.target, f.template), "backed-up-synced");
		assert.equal(await readFile(join(f.target, "agent.cordis.yml.bak"), "utf8"), "- id: persona\n");
	} finally {
		await f.cleanup();
	}
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
