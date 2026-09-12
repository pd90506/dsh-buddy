import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SOUL, readPersona, soulForPrompt, writePersona } from "../src/persona/soul.ts";
import type { BuddyPaths } from "../src/paths.ts";

/** A real temporary buddy home, because this module's whole job is file IO. */
async function paths(): Promise<BuddyPaths> {
	const home = await mkdtemp(join(tmpdir(), "dsh-buddy-"));
	return { home, soul: join(home, "SOUL.md"), agents: join(home, "AGENTS.md") };
}

test("an absent SOUL.md reads as the default persona, never empty", async () => {
	const document = await readPersona(await paths());
	assert.equal(document.soul, DEFAULT_SOUL);
	assert.equal(document.agents, "");
});

test("a written persona round-trips", async () => {
	const p = await paths();
	const written = await writePersona(p, { soul: "You are terse.", agents: "Never guess." });
	const document = await readPersona(p);
	assert.equal(document.soul, "You are terse.");
	assert.equal(document.agents, "Never guess.");
	assert.equal(await readFile(p.soul, "utf8"), "You are terse.");
	// The write's own return value is what Task 5's gateway answers with, so it
	// must be the persona as it now reads and not a stale or empty echo.
	assert.deepEqual(written, document);
});

test("a partial write leaves the other file alone", async () => {
	const p = await paths();
	await writePersona(p, { soul: "A", agents: "B" });
	await writePersona(p, { soul: "C" });
	const document = await readPersona(p);
	assert.equal(document.soul, "C");
	assert.equal(document.agents, "B");
	// Belt and braces: the untouched file on disk, not just the read-back view.
	assert.equal(await readFile(p.agents, "utf8"), "B");
});

test("an unreadable SOUL.md degrades to the default instead of throwing", async () => {
	const p = await paths();
	// A directory where the file should be: readFile fails with EISDIR.
	await writePersona(p, { agents: "" });
	const { mkdir } = await import("node:fs/promises");
	await mkdir(p.soul, { recursive: true });
	const document = await readPersona(p);
	assert.equal(document.soul, DEFAULT_SOUL);
});

test("an authored file is read verbatim, so the floor lives in soulForPrompt alone", async () => {
	const p = await paths();
	await writeFile(p.soul, "   ", "utf8");
	const document = await readPersona(p);
	assert.equal(document.soul, "   ");
	assert.equal(soulForPrompt(document), DEFAULT_SOUL);
});

test("prompt text is never empty, so the persona row never shadows itself away", async () => {
	assert.notEqual(soulForPrompt({ soul: "", agents: "" }).trim(), "");
	// Whitespace is as fatal as emptiness: a blank prefix still shadows the
	// deployment persona away without replacing it.
	assert.notEqual(soulForPrompt({ soul: " \n\t ", agents: "" }).trim(), "");
	assert.equal(soulForPrompt({ soul: "", agents: "" }), DEFAULT_SOUL);
	assert.equal(soulForPrompt({ soul: " \n\t ", agents: "Rule." }).startsWith(DEFAULT_SOUL), true);
	assert.equal(soulForPrompt({ soul: "Voice.", agents: "" }), "Voice.");
});

test("rules are appended under their own heading when present", async () => {
	const text = soulForPrompt({ soul: "Voice.", agents: "Rule one." });
	assert.equal(text.includes("Voice."), true);
	assert.equal(text.includes("Rule one."), true);
	assert.equal(text.indexOf("Voice.") < text.indexOf("Rule one."), true);
	// Named for the heading: without one the rules read as more of the voice.
	assert.equal(text.includes("## Operating rules"), true);
	assert.equal(text.indexOf("## Operating rules") > text.indexOf("Voice."), true);
	assert.equal(text.indexOf("## Operating rules") < text.indexOf("Rule one."), true);
});

test("a persona containing template braces is carried verbatim", async () => {
	const p = await paths();
	await writePersona(p, { soul: "Literal {{notAVariable}} stays." });
	const document = await readPersona(p);
	assert.equal(document.soul, "Literal {{notAVariable}} stays.");
	// And through to the prompt text, which is what the variable actually carries.
	assert.equal(soulForPrompt(document).includes("{{notAVariable}}"), true);
});
