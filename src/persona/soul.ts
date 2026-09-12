/**
 * Reading and writing buddy's authored persona.
 *
 * Two files, deliberately separate — the split both reference products
 * converged on independently:
 *
 * - `SOUL.md` is voice, attitude and opinions;
 * - `AGENTS.md` is operating rules.
 *
 * Everything here degrades rather than throws on read. A damaged or missing
 * persona must not be able to stop a session from starting; the worst outcome
 * is the default voice, which is always non-empty for the reason in
 * {@link soulForPrompt}.
 * @module dsh-buddy/persona/soul
 */
import { readFile, writeFile } from "node:fs/promises";
import type { BuddyPaths } from "../paths.ts";

/**
 * The voice a freshly installed buddy speaks in.
 *
 * This is never the empty string. The preset's persona row renders the prompt
 * variable as its `prefix`, and an empty prefix shadows the deployment persona
 * away without putting anything in its place — a session with no identity at all.
 */
export const DEFAULT_SOUL =
	"You are Buddy, a personal assistant running inside the user's own harness. " +
	"You are direct, concrete, and allergic to filler. You remember that you are a " +
	"guest on this machine: you say what you are about to do before you do it.";

/** The authored persona as two independent documents. */
export interface PersonaDocument {
	/** Voice, attitude, opinions. Falls back to {@link DEFAULT_SOUL}. */
	readonly soul: string;
	/** Operating rules. Empty when the user has written none. */
	readonly agents: string;
}

/**
 * Read one file, treating every failure as absence.
 * @param path - the file to read.
 * @param fallback - what an unreadable or missing file means.
 * @returns the file's text, or the fallback.
 */
async function readOr(path: string, fallback: string): Promise<string> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return fallback;
	}
}

/**
 * Read the authored persona.
 * @param paths - resolved buddy file locations.
 * @returns the persona, with the default voice when none is written.
 */
export async function readPersona(paths: BuddyPaths): Promise<PersonaDocument> {
	const [soul, agents] = await Promise.all([readOr(paths.soul, DEFAULT_SOUL), readOr(paths.agents, "")]);
	return { soul, agents };
}

/**
 * Write the parts of the persona the caller supplied.
 *
 * A partial write must not blank the other file: the settings tab edits the two
 * independently, and an omitted field means "unchanged", not "empty".
 * @param paths - resolved buddy file locations.
 * @param next - the fields to change.
 * @returns the persona as it reads after the write.
 */
export async function writePersona(paths: BuddyPaths, next: Partial<PersonaDocument>): Promise<PersonaDocument> {
	if (next.soul !== undefined) await writeFile(paths.soul, next.soul, "utf8");
	if (next.agents !== undefined) await writeFile(paths.agents, next.agents, "utf8");
	return await readPersona(paths);
}

/**
 * Render the persona as the single block the prompt variable carries.
 *
 * The renderer does not scan substituted values again, so this text may contain
 * `{{` freely — a persona the agent itself will later edit must never be able to
 * break prompt assembly.
 * @param document - the authored persona.
 * @returns non-empty prompt text.
 */
export function soulForPrompt(document: PersonaDocument): string {
	const voice = document.soul.trim() === "" ? DEFAULT_SOUL : document.soul.trim();
	const rules = document.agents.trim();
	return rules === "" ? voice : `${voice}\n\n## Operating rules\n\n${rules}`;
}
