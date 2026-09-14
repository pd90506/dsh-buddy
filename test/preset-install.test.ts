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
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	GENERATED_MARKER,
	presetOwnership,
	presetTargetDir,
	resolveTemplateDir,
	syncPreset,
} from "../src/store/preset.ts";

/**
 * Absolute path to one file of the REAL historical template.
 *
 * Synthetic bytes can never hash into the published-template table, so the
 * adoption path cannot be reached with a fixture this file invents: these bytes
 * are the ones `git show 59b9e98:assets/preset/...` produced, i.e. exactly what
 * the plugin left in a real `~/.dsh/.agent-presets/buddy/` before it wrote
 * markers. The test is therefore falsifiable against the real machine's state.
 * @param name - the template file name.
 * @returns the fixture's absolute path.
 */
function legacyFixture(name: string): string {
	return join(dirname(fileURLToPath(import.meta.url)), "fixtures", "preset-legacy", name);
}

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
		// `old` is written into the TEMPLATE before the install, never over the
		// installed file afterwards. The marker's per-file hash baseline is the
		// only thing that separates "the plugin's own previous output" from "a
		// hand-edit", so the only way to express "the template moved on and
		// nobody hand-edited anything" is for the previous content to be what
		// the plugin actually wrote. Writing `old` over the installed file
		// instead would leave bytes hashing to neither the baseline nor the new
		// template — a hand-edit by definition, which is the NEXT test — and
		// this one would stop exercising the silent upgrade path at all.
		await writeFile(f.templateFile("agent.cordis.yml"), "old\n", "utf8");
		assert.equal(await syncPreset(f.target, f.template), "installed");
		// Now the next version moves that file on and nobody touches the
		// install, so the on-disk bytes still hash to the baseline and the
		// overwrite must be silent: no `.bak`, no `backed-up-synced`. A sync
		// that backed up here would be the rejected "differs from the current
		// template" rule — it cannot tell an upgrade from a hand-edit.
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

// ── the legacy install this plugin itself wrote before it wrote markers ────
//
// The old `installPreset` never wrote a marker, so the directory the plugin
// installed is byte-identical to a template it published and still looks like
// someone else's hand-written preset. Under "unmarked = the user's" that
// directory would be `kept` forever and every later row would silently never
// arrive. The rule that recovers it has to be strict — it may only claim bytes
// this plugin provably published — because a wrong claim overwrites a human's
// preset.

test("a pristine legacy install is adopted and upgraded, not left alone", async () => {
	const f = await fixture();
	try {
		await mkdir(f.target, { recursive: true });
		await copyFile(legacyFixture("agent.cordis.yml"), join(f.target, "agent.cordis.yml"));
		await copyFile(legacyFixture("preset.yml"), join(f.target, "preset.yml"));
		// Before the claim it is indistinguishable from a hand-written preset.
		assert.equal(await presetOwnership(f.target), "user");
		assert.equal(await syncPreset(f.target, f.template), "synced");
		// The claim must have MARKED the directory and upgraded its files, and
		// it must have done so silently: the bytes it overwrote were its own,
		// so there is nothing to preserve and no `.bak` to leave behind.
		assert.equal(existsSync(join(f.target, GENERATED_MARKER)), true);
		assert.equal(
			await readFile(join(f.target, "agent.cordis.yml"), "utf8"),
			await readFile(f.templateFile("agent.cordis.yml"), "utf8"),
		);
		assert.equal(existsSync(join(f.target, "agent.cordis.yml.bak")), false);
		assert.equal(await presetOwnership(f.target), "plugin");
	} finally {
		await f.cleanup();
	}
});

test("one hand-edited file makes the legacy directory the user's, and it is reported", async () => {
	const f = await fixture();
	try {
		await mkdir(f.target, { recursive: true });
		await copyFile(legacyFixture("agent.cordis.yml"), join(f.target, "agent.cordis.yml"));
		// Not bytes this plugin ever published, so the directory is the user's.
		await writeFile(join(f.target, "preset.yml"), "mine\n", "utf8");
		assert.equal(await syncPreset(f.target, f.template), "kept");
		assert.equal(existsSync(join(f.target, GENERATED_MARKER)), false);
		assert.equal(await readFile(join(f.target, "preset.yml"), "utf8"), "mine\n");
		// And that verdict has to reach the panel, not just a log line.
		assert.equal(await presetOwnership(f.target), "user");
	} finally {
		await f.cleanup();
	}
});

test("a legacy directory with one extra entry is not claimed", async () => {
	// The entry set must match the template exactly. A `.bak` beside a pristine
	// legacy pair means a human was in here — the plugin's own sync never
	// leaves a backup next to files it wrote itself.
	const f = await fixture();
	try {
		await mkdir(f.target, { recursive: true });
		await copyFile(legacyFixture("agent.cordis.yml"), join(f.target, "agent.cordis.yml"));
		await copyFile(legacyFixture("preset.yml"), join(f.target, "preset.yml"));
		await writeFile(join(f.target, "agent.cordis.yml.bak"), "leftover\n", "utf8");
		assert.equal(await syncPreset(f.target, f.template), "kept");
		assert.equal(existsSync(join(f.target, GENERATED_MARKER)), false);
		assert.equal(
			await readFile(join(f.target, "agent.cordis.yml"), "utf8"),
			await readFile(legacyFixture("agent.cordis.yml"), "utf8"),
		);
		assert.equal(await readFile(join(f.target, "agent.cordis.yml.bak"), "utf8"), "leftover\n");
	} finally {
		await f.cleanup();
	}
});

test("a directory byte-identical to the current template is marked without a rewrite", async () => {
	// The current template's own hash belongs in the table: an install that is
	// already up to date and merely unmarked needs the marker, not a rewrite.
	// A table that stopped at the previous release would leave this `kept`,
	// unmarked and stuck — and would return `kept` for every future release too.
	const f = await fixture();
	try {
		await mkdir(f.target, { recursive: true });
		await copyFile(join(REAL_TEMPLATE_DIR, "agent.cordis.yml"), join(f.target, "agent.cordis.yml"));
		await copyFile(join(REAL_TEMPLATE_DIR, "preset.yml"), join(f.target, "preset.yml"));
		assert.equal(await syncPreset(f.target, REAL_TEMPLATE_DIR), "kept");
		assert.equal(existsSync(join(f.target, GENERATED_MARKER)), true);
		assert.equal(existsSync(join(f.target, "agent.cordis.yml.bak")), false);
		assert.equal(await presetOwnership(f.target), "plugin");
	} finally {
		await f.cleanup();
	}
});

test("presetOwnership classifies without throwing, and never reads a missing directory as the user's", async () => {
	const f = await fixture();
	try {
		// Absent and empty are both "nothing here yet": the panel says so
		// instead of claiming the user owns a directory that does not exist.
		assert.equal(await presetOwnership(f.target), "absent");
		await mkdir(f.target, { recursive: true });
		assert.equal(await presetOwnership(f.target), "absent");
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
