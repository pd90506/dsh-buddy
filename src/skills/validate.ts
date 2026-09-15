/**
 * Skill document validation, ported from the reference implementation.
 *
 * The name grammar is DSH's, NOT hermes' looser `^[a-z0-9][a-z0-9._-]*$`: the
 * DSH registry validates candidate names with its own kebab-case grammar and
 * throws on a mismatch, so a name hermes would accept could not be loaded here.
 *
 * **No YAML dependency.** This package's `build.mjs` derives its externals from
 * `dependencies ∪ peerDependencies`, and `yaml` is in neither — a bare import
 * could neither resolve at build time nor be bundled. A flat-frontmatter parser
 * lives here instead, with two deliberate strictness levels: the write path
 * ({@link validateSkillDocument}) accepts only the documented subset, while
 * {@link parseFrontmatter} never throws, so a read path can fall back to a
 * default instead of dropping a hand-written skill from the catalog.
 * @module dsh-buddy/skills/validate
 */
import { isAbsolute } from "node:path";

/** DSH's public skill-name grammar (`dsh-skill`'s own `SKILL_NAME`). */
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The least-exposed tier, and both providers' default for an unreadable value. */
export const BUDDY_TIER = "buddy";

/** The prefix a path-scoped tier carries. */
const PROJECT_TIER_PREFIX = "project:";

/** The only directories a skill may ship support files in. */
export const ALLOWED_SUBDIRS = ["references", "templates", "scripts", "assets"] as const;

/** Description ceiling for a skill that already exists. */
export const MAX_DESCRIPTION_LENGTH = 1024;

/** Description ceiling for a brand-new skill: the index shows only the head. */
export const SKILL_CREATE_DESC_LIMIT = 60;

/** SKILL.md body ceiling, in characters. */
export const MAX_SKILL_CONTENT_CHARS = 100_000;

/** One support file's ceiling, in bytes. */
export const MAX_SKILL_FILE_BYTES = 1_048_576;

/** A frontmatter key this parser accepts. */
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/** A parsed frontmatter plus the body after the closing fence, or why it failed. */
export type FrontmatterParse =
	| { frontmatter: Record<string, unknown>; body: string }
	| { error: string };

/**
 * Validate one skill name.
 * @param name - the candidate name.
 * @returns the failure message, or `undefined` when the name is valid.
 */
export function validateSkillName(name: string): string | undefined {
	if (name.trim() === "") return "a skill name is required";
	if (!SKILL_NAME_RE.test(name)) {
		return `skill name '${name}' must be lowercase letters, digits and hyphens only`;
	}
	return undefined;
}

/**
 * Parse a skill document's frontmatter without ever throwing.
 *
 * The accepted subset is a flat mapping (`key: value`) whose values are bare or
 * quoted scalars, inline lists (`[a, b]`), or block lists (`- item` lines under
 * a bare key). Blank lines and `#` comments are skipped. Anything else returns
 * an `error` — never an exception — so a caller reading a hand-written skill can
 * fall back to a default rather than losing the skill.
 * @param content - the complete SKILL.md text.
 * @returns the parsed mapping and body, or the reason it could not be read.
 */
export function parseFrontmatter(content: string): FrontmatterParse {
	try {
		return parseFlatFrontmatter(content);
	} catch (error) {
		// Belt and braces: the inner parser is written to be total, and a read
		// path must still be unable to throw through this function.
		return { error: `frontmatter could not be parsed: ${(error as Error).message}` };
	}
}

/**
 * Validate a complete skill document for a write.
 * @param input - the target directory name, the document text, and whether this is a creation.
 * @returns the parsed frontmatter and body, or the first failure.
 */
export function validateSkillDocument(input: {
	name: string;
	content: string;
	creating: boolean;
}): { ok: true; frontmatter: Record<string, unknown>; body: string } | { ok: false; error: string } {
	const nameError = validateSkillName(input.name);
	if (nameError !== undefined) return { ok: false, error: nameError };
	if (input.content.length > MAX_SKILL_CONTENT_CHARS) {
		return { ok: false, error: `SKILL.md exceeds ${MAX_SKILL_CONTENT_CHARS} chars` };
	}
	const parsed = parseFrontmatter(input.content);
	if ("error" in parsed) return { ok: false, error: parsed.error };
	const rawName = parsed.frontmatter["name"];
	if (typeof rawName !== "string" || rawName.trim() === "") {
		return { ok: false, error: "frontmatter is missing 'name'" };
	}
	if (rawName !== input.name) {
		return { ok: false, error: `frontmatter name '${rawName}' does not match directory '${input.name}'` };
	}
	const description = parsed.frontmatter["description"];
	if (typeof description !== "string" || description.trim() === "") {
		return { ok: false, error: "frontmatter is missing 'description'" };
	}
	const limit = input.creating ? SKILL_CREATE_DESC_LIMIT : MAX_DESCRIPTION_LENGTH;
	if (description.length > limit) {
		return { ok: false, error: `description is ${description.length} chars; the create limit is ${limit}` };
	}
	if (parsed.body.trim() === "") return { ok: false, error: "the body is empty" };
	return { ok: true, frontmatter: parsed.frontmatter, body: parsed.body };
}

/**
 * The tier one frontmatter declares, resolved as the providers resolve it.
 *
 * Deliberately mirrors `provider.ts`'s read path (`resolveVisibility`), because
 * this is the *write* side of the same rule: an absent, empty, non-scalar,
 * relative-`project:` or unknown value is `buddy`, so an unreadable declaration
 * can never be mistaken for a promotion. The provider resolves to a
 * discriminated `SkillVisibility`; this answers the canonical string the write
 * path compares against.
 * @param frontmatter - a parsed frontmatter mapping.
 * @returns `"buddy"`, `"global"`, or `"project:<absolute path>"`.
 */
export function declaredVisibility(frontmatter: Readonly<Record<string, unknown>>): string {
	const raw = frontmatter["visibility"];
	if (typeof raw !== "string") return BUDDY_TIER;
	const value = raw.trim();
	if (value === "" || value === BUDDY_TIER) return BUDDY_TIER;
	if (value === "global") return "global";
	if (value.startsWith(PROJECT_TIER_PREFIX)) {
		const path = value.slice(PROJECT_TIER_PREFIX.length).trim();
		if (path !== "" && isAbsolute(path)) return `${PROJECT_TIER_PREFIX}${path}`;
	}
	return BUDDY_TIER;
}

/**
 * Validate one support-file path.
 * @param rel - the path as the caller wrote it, relative to the skill directory.
 * @returns the failure message, or `undefined` when it is a safe allowed path.
 */
export function validateSupportPath(rel: string): string | undefined {
	const value = rel.trim();
	if (value === "") return "a support file path is required";
	if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) {
		return `support file path '${rel}' must be relative`;
	}
	const segments = value.split(/[\\/]+/);
	if (segments.includes("..")) {
		return `support file path '${rel}' must not contain '..'`;
	}
	const directory = segments[0];
	if (directory === undefined || !(ALLOWED_SUBDIRS as readonly string[]).includes(directory)) {
		return `support files must live under ${ALLOWED_SUBDIRS.join(", ")}; got '${rel}'`;
	}
	if (segments.length < 2 || segments[segments.length - 1] === "") {
		return `support file path '${rel}' must name a file inside '${directory}'`;
	}
	return undefined;
}

/**
 * Validate one support file's size.
 * @param rel - the support path, used only in the message.
 * @param bytes - the byte count the caller is about to write.
 * @returns the failure message, or `undefined` when the size is acceptable.
 */
export function validateSupportBytes(rel: string, bytes: number): string | undefined {
	if (!Number.isFinite(bytes)) return `support file '${rel}' needs a finite size`;
	if (bytes < 0) return `support file '${rel}' needs a non-negative size`;
	if (bytes > MAX_SKILL_FILE_BYTES) {
		return `support file '${rel}' is ${bytes} bytes; the limit is ${MAX_SKILL_FILE_BYTES}`;
	}
	return undefined;
}

/**
 * The total flat-frontmatter parser behind {@link parseFrontmatter}.
 * @param content - the complete document.
 * @returns the mapping and body, or the reason it could not be read.
 */
function parseFlatFrontmatter(content: string): FrontmatterParse {
	// A leading BOM is an encoding artifact, not part of the first fence.
	const text = content.startsWith("\uFEFF") ? content.slice(1) : content;
	const lines = text.split("\n");
	if ((lines[0] ?? "").trim() !== "---") {
		return { error: "frontmatter must open with a line containing only ---" };
	}
	let closing = -1;
	for (let index = 1; index < lines.length; index += 1) {
		if ((lines[index] ?? "").trim() === "---") {
			closing = index;
			break;
		}
	}
	if (closing === -1) {
		return { error: "frontmatter must close with a line containing only ---" };
	}
	const header = lines.slice(1, closing);
	const frontmatter: Record<string, unknown> = {};
	for (let index = 0; index < header.length; index += 1) {
		const line = header[index] ?? "";
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		const separator = line.indexOf(":");
		const key = separator === -1 ? "" : line.slice(0, separator).trim();
		if (separator === -1 || !KEY_RE.test(key)) {
			return {
				error: `frontmatter must be a flat mapping of key: value pairs; could not read '${trimmed}'`,
			};
		}
		const rawValue = line.slice(separator + 1).trim();
		if (rawValue === "" || rawValue.startsWith("- ")) {
			// A block list: the value line is bare, or carries the first item.
			const keyIndent = line.length - line.trimStart().length;
			const items = rawValue === "" ? [] : [unquote(rawValue.slice(2).trim())];
			let cursor = index + 1;
			while (cursor < header.length) {
				const rawCandidate = header[cursor] ?? "";
				const candidate = rawCandidate.trim();
				if (candidate === "" || candidate.startsWith("#")) {
					cursor += 1;
					continue;
				}
				if (candidate.startsWith("- ")) {
					// A list item, at any indentation: `- item` at the key's own
					// column is still that key's block list, not the next key.
					items.push(unquote(candidate.slice(2).trim()));
					cursor += 1;
					continue;
				}
				if (rawCandidate.length - rawCandidate.trimStart().length > keyIndent) {
					// Indented `key: value` under a bare key is a nested mapping.
					// Promoting its inner keys to the top level would invent
					// frontmatter the document does not have — and could override
					// real top-level keys — so it is outside the documented flat
					// subset and refused instead of flattened.
					return {
						error: `frontmatter must be a flat mapping of key: value pairs; '${key}' has nested content`,
					};
				}
				break;
			}
			if (items.length === 0) {
				// A bare key with nothing under it: an empty string, not a list.
				frontmatter[key] = "";
				continue;
			}
			frontmatter[key] = items;
			index = cursor - 1;
			continue;
		}
		if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
			const inner = rawValue.slice(1, -1).trim();
			frontmatter[key] = inner === "" ? [] : inner.split(",").map((item) => unquote(item.trim()));
			continue;
		}
		frontmatter[key] = unquote(rawValue);
	}
	return { frontmatter, body: lines.slice(closing + 1).join("\n") };
}

/**
 * Strip one matching pair of surrounding quotes.
 * @param value - a trimmed scalar.
 * @returns the scalar without its quotes.
 */
function unquote(value: string): string {
	if (value.length < 2) return value;
	const first = value[0];
	const last = value[value.length - 1];
	if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
		return value.slice(1, -1);
	}
	return value;
}
