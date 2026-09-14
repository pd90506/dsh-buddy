/**
 * Advisory skill linting, ported from the reference implementation.
 *
 * Every rule is advisory by contract: {@link lintSkill} returns findings and
 * **never throws**, for any input, so a caller can attach them to a tool result
 * without the linter ever becoming a gate. Findings are plain data — no harness
 * object ever reaches them.
 *
 * Three things change on the way over from hermes, and the rules themselves do
 * not move:
 *
 * 1. `shell-utility-reference` maps to **DSH's** tool names rather than hermes'
 *    `search_files` / `read_file` / `patch`.
 * 2. `author-caps` is deliberately absent — Buddy has no author convention, so
 *    the rule would only ever produce noise.
 * 3. `missing-metadata` checks Buddy's own `visibility` field in place of
 *    hermes' `metadata.hermes.{tags, related_skills}`, keeping the
 *    `version` / `author` / `license` half.
 *
 * The one filesystem seam is the injected `dirExists` predicate: the rules that
 * need to know whether a path exists call it and nothing else, so the linter
 * works in tests and in a sandbox that has no real filesystem behind it.
 * @module dsh-buddy/skills/linter
 */

import { SKILL_CREATE_DESC_LIMIT, validateSkillName } from "./validate.ts";

/** How strongly a finding is meant: an error is a real defect, a warning advice. */
export type LintSeverity = "error" | "warning";

/** One advisory finding. The linter never converts a finding into a failure. */
export interface LintFinding {
	severity: LintSeverity;
	rule: string;
	message: string;
}

/** Everything the linter may look at for one skill. */
export interface LintInput {
	/** The complete SKILL.md text. */
	content: string;
	/** The skill's directory, used only for messages. */
	skillDir: string;
	/** The skill directory's own name; `name-dir-mismatch` compares against it. */
	skillName: string;
	/** The already-parsed frontmatter, as Task 3's parser produced it. */
	frontmatter: Record<string, unknown>;
	/**
	 * Whether a path relative to the skill directory exists.
	 *
	 * Both files and directories are probed. When absent, the two rules that
	 * need it (`dangling-reference`, `forbidden-file`) report nothing rather
	 * than guessing.
	 */
	dirExists?: (rel: string) => boolean;
}

/** hermes maps these to search_files/read_file/patch; DSH's tool names differ, so the map follows. */
const SHELL_UTIL_TO_TOOL: Record<string, string> = {
	grep: "grep",
	rg: "grep",
	cat: "read",
	head: "read",
	tail: "read",
	sed: "edit",
	awk: "edit",
	find: "glob",
	ls: "glob",
};

/** Praise that tells a reader nothing about when the skill applies. */
const MARKETING_WORDS = [
	"powerful",
	"comprehensive",
	"seamless",
	"advanced",
	"cutting-edge",
	"state-of-the-art",
	"revolutionary",
	"robust",
];

/** Files that are never part of a skill, whatever their contents. */
const FORBIDDEN_FILES = ["README.md", "CHANGELOG.md", "install.sh", ".env", ".env.example", ".gitignore"];

/** Primitives that only exist on one platform family. */
const POSIX_PRIMITIVES = ["fcntl", "termios", "os.setsid", "osascript", "/proc/", "apt-get", "systemctl"];

/** The only values `platforms:` may take. */
const ALLOWED_PLATFORMS = ["linux", "macos", "windows", "darwin"];

/** Metadata keys every skill's frontmatter is expected to carry. */
const EXPECTED_METADATA = ["visibility", "version", "author", "license"];

/** Below this many issue references a body is not an incident log. */
const INCIDENT_REF_MIN = 4;

/** Below this reference density a body is not an incident log either. */
const INCIDENT_REF_PER_KCHAR = 0.5;

/** Above this many non-`_` reference documents the directory is sprawling. */
const MAX_REFERENCE_FILES = 60;

/** The support directories a body may point into. */
const SUPPORT_DIRS = ["references", "templates", "assets"];

/** A `## When to Use` heading, at any deeper level and in either case. */
const WHEN_TO_USE_RE = /^#{2,}\s+when to use\s*$/im;

/** A fenced code block, which is not prose and must not be read as such. */
const FENCED_CODE_RE = /```[\s\S]*?```/g;

/** One inline code span, whose contents are the only place a tool name is a tool name. */
const CODE_SPAN_RE = /`([^`\n]+)`/g;

/** A PR/issue reference such as `#1234`. */
const INCIDENT_REF_RE = /#\d+/g;

/** A path a body points at inside one of the support directories. */
const SUPPORT_PATH_RE = new RegExp(`(?:${SUPPORT_DIRS.join("|")})/[^\\s\`)\\]"'>;,]+`, "g");

/**
 * Lint one skill document.
 *
 * Total by design: malformed frontmatter, empty content and a throwing
 * `dirExists` all come back as findings (or an empty list), never as an
 * exception.
 * @param input - the document, its directory identity, parsed frontmatter and probe.
 * @returns every advisory finding, in rule order; an empty array for a clean skill.
 */
export function lintSkill(input: LintInput): LintFinding[] {
	const findings: LintFinding[] = [];
	try {
		const content = typeof input?.content === "string" ? input.content : "";
		const frontmatter = isRecord(input?.frontmatter) ? input.frontmatter : {};
		const skillName = typeof input?.skillName === "string" ? input.skillName : "";
		const dirExists = typeof input?.dirExists === "function" ? input.dirExists : undefined;
		const body = bodyOf(content);

		checkNameFormat(findings, frontmatter);
		checkNameDirMismatch(findings, frontmatter, skillName);
		checkDescription(findings, frontmatter);
		checkSections(findings, body);
		checkIncidentLogShape(findings, body);
		checkDanglingReferences(findings, body, dirExists);
		checkPlatformsValue(findings, frontmatter);
		checkPlatformsGating(findings, frontmatter, content);
		checkForbiddenFiles(findings, dirExists);
		checkReferencesSprawl(findings, body);
		checkShellUtilities(findings, body);
		checkMetadata(findings, frontmatter);
	} catch {
		// Total by contract: a broken probe or mocked frontmatter is a caller
		// bug, not a reason to fail the tool call that asked for advice.
	}
	return findings;
}

/**
 * Rule `name-format`: the frontmatter name must satisfy DSH's grammar.
 * @param findings - the accumulator.
 * @param frontmatter - the parsed frontmatter.
 */
function checkNameFormat(findings: LintFinding[], frontmatter: Record<string, unknown>): void {
	const name = frontmatter["name"];
	if (typeof name !== "string" || name.trim() === "") {
		findings.push({ severity: "error", rule: "name-format", message: "frontmatter is missing 'name'" });
		return;
	}
	const error = validateSkillName(name);
	if (error !== undefined) findings.push({ severity: "error", rule: "name-format", message: error });
}

/**
 * Rule `name-dir-mismatch`: the frontmatter name must equal the directory name.
 * @param findings - the accumulator.
 * @param frontmatter - the parsed frontmatter.
 * @param skillName - the skill directory's own name.
 */
function checkNameDirMismatch(findings: LintFinding[], frontmatter: Record<string, unknown>, skillName: string): void {
	const name = frontmatter["name"];
	if (typeof name !== "string" || name === "" || skillName === "" || name === skillName) return;
	findings.push({
		severity: "error",
		rule: "name-dir-mismatch",
		message: `frontmatter name '${name}' does not match directory '${skillName}'`,
	});
}

/**
 * Rules `description-length` and `description-marketing`.
 * @param findings - the accumulator.
 * @param frontmatter - the parsed frontmatter.
 */
function checkDescription(findings: LintFinding[], frontmatter: Record<string, unknown>): void {
	const description = frontmatter["description"];
	if (typeof description !== "string") return;
	if (description.length > SKILL_CREATE_DESC_LIMIT) {
		findings.push({
			severity: "warning",
			rule: "description-length",
			message: `description is ${description.length} chars; the create limit is ${SKILL_CREATE_DESC_LIMIT}`,
		});
	}
	const lower = description.toLowerCase();
	const hits = MARKETING_WORDS.filter((word) => lower.includes(word));
	if (hits.length > 0) {
		findings.push({
			severity: "warning",
			rule: "description-marketing",
			message: `description uses marketing language: ${hits.map((word) => `'${word}'`).join(", ")}`,
		});
	}
}

/**
 * Rule `missing-section`: the body must carry a `## When to Use` heading.
 * @param findings - the accumulator.
 * @param body - the document text without its frontmatter.
 */
function checkSections(findings: LintFinding[], body: string): void {
	if (WHEN_TO_USE_RE.test(body)) return;
	findings.push({
		severity: "warning",
		rule: "missing-section",
		message: "body has no '## When to Use' heading",
	});
}

/**
 * Rule `incident-log-shape`: issue references alone are a history, not a skill.
 *
 * Fenced code blocks are stripped first, because a reference inside an example
 * is part of the example, not of the prose that will be read as guidance.
 * @param findings - the accumulator.
 * @param body - the document text without its frontmatter.
 */
function checkIncidentLogShape(findings: LintFinding[], body: string): void {
	const stripped = body.replace(FENCED_CODE_RE, "");
	const refs = stripped.match(INCIDENT_REF_RE)?.length ?? 0;
	if (refs < INCIDENT_REF_MIN) return;
	const perKchar = stripped.length === 0 ? 0 : refs / (stripped.length / 1000);
	if (perKchar < INCIDENT_REF_PER_KCHAR) return;
	findings.push({
		severity: "warning",
		rule: "incident-log-shape",
		message: `body reads like an incident log: ${refs} issue references over ${stripped.length} chars (${perKchar.toFixed(2)} per 1000)`,
	});
}

/**
 * Rule `dangling-reference`: a support path the body names must exist.
 * @param findings - the accumulator.
 * @param body - the document text without its frontmatter.
 * @param dirExists - the injected probe, or `undefined` to stay silent.
 */
function checkDanglingReferences(
	findings: LintFinding[],
	body: string,
	dirExists: ((rel: string) => boolean) | undefined,
): void {
	if (dirExists === undefined) return;
	for (const rel of supportPaths(body)) {
		if (dirExists(rel)) continue;
		findings.push({
			severity: "warning",
			rule: "dangling-reference",
			message: `body references '${rel}', which does not exist`,
		});
	}
}

/**
 * Rule `platforms-value`: every declared platform must be a known one.
 * @param findings - the accumulator.
 * @param frontmatter - the parsed frontmatter.
 */
function checkPlatformsValue(findings: LintFinding[], frontmatter: Record<string, unknown>): void {
	const raw = frontmatter["platforms"];
	if (raw === undefined || raw === null) return;
	const values = (Array.isArray(raw) ? raw : String(raw).split(","))
		.map((value) => (typeof value === "string" ? value.trim() : value))
		.filter((value) => value !== "");
	for (const value of values) {
		if (typeof value === "string" && ALLOWED_PLATFORMS.includes(value)) continue;
		findings.push({
			severity: "warning",
			rule: "platforms-value",
			message: `platforms value '${String(value)}' is not one of ${ALLOWED_PLATFORMS.join(", ")}`,
		});
	}
}

/**
 * Rule `platforms-gating`: a POSIX-only primitive needs `platforms:` declared.
 *
 * The linter only ever sees the document text, so the primitive is looked for
 * there — which is also where a skill's shell snippets actually live.
 * @param findings - the accumulator.
 * @param frontmatter - the parsed frontmatter.
 * @param content - the complete document.
 */
function checkPlatformsGating(findings: LintFinding[], frontmatter: Record<string, unknown>, content: string): void {
	if (hasPlatforms(frontmatter)) return;
	const hits = POSIX_PRIMITIVES.filter((primitive) => content.includes(primitive));
	if (hits.length === 0) return;
	findings.push({
		severity: "warning",
		rule: "platforms-gating",
		message: `document uses POSIX-only ${hits.map((hit) => `'${hit}'`).join(", ")} without declaring 'platforms:'`,
	});
}

/**
 * Rule `forbidden-file`: a skill directory must not carry these files.
 * @param findings - the accumulator.
 * @param dirExists - the injected probe, or `undefined` to stay silent.
 */
function checkForbiddenFiles(findings: LintFinding[], dirExists: ((rel: string) => boolean) | undefined): void {
	if (dirExists === undefined) return;
	for (const name of FORBIDDEN_FILES) {
		if (!dirExists(name)) continue;
		findings.push({
			severity: "warning",
			rule: "forbidden-file",
			message: `skill carries '${name}', which is not part of a skill`,
		});
	}
}

/**
 * Rule `references-sprawl`: the reference set must stay browsable.
 *
 * A probe that only answers "does this path exist" cannot enumerate a
 * directory, so the count is taken over the non-private `.md` reference paths
 * the body points at — the readable proxy for the same sprawl.
 * @param findings - the accumulator.
 * @param body - the document text without its frontmatter.
 */
function checkReferencesSprawl(findings: LintFinding[], body: string): void {
	let count = 0;
	for (const rel of supportPaths(body)) {
		const segments = rel.split("/");
		if (segments[0] !== "references") continue;
		const base = segments[segments.length - 1] ?? "";
		if (!base.endsWith(".md") || base.startsWith("_")) continue;
		count += 1;
	}
	if (count <= MAX_REFERENCE_FILES) return;
	findings.push({
		severity: "warning",
		rule: "references-sprawl",
		message: `body points at ${count} reference documents; keep 'references/' under ${MAX_REFERENCE_FILES}`,
	});
}

/**
 * Rule `shell-utility-reference`: a shell utility must be named as DSH's tool.
 *
 * Only inline code spans count, so English words like "find", "head" or "tail"
 * in ordinary prose do not turn into findings. All hits travel in one finding,
 * because a caller showing advice wants the whole mapping at once.
 * @param findings - the accumulator.
 * @param body - the document text without its frontmatter.
 */
function checkShellUtilities(findings: LintFinding[], body: string): void {
	const used = new Set<string>();
	for (const match of body.matchAll(CODE_SPAN_RE)) {
		const span = (match[1] ?? "").trim();
		if (Object.prototype.hasOwnProperty.call(SHELL_UTIL_TO_TOOL, span)) used.add(span);
	}
	if (used.size === 0) return;
	const pairs = [...used].map((utility) => `\`${utility}\` → \`${SHELL_UTIL_TO_TOOL[utility] ?? utility}\``);
	findings.push({
		severity: "warning",
		rule: "shell-utility-reference",
		message: `body names shell utilities where a DSH tool exists: ${pairs.join(", ")}`,
	});
}

/**
 * Rule `missing-metadata`: Buddy's own metadata convention must be declared.
 * @param findings - the accumulator.
 * @param frontmatter - the parsed frontmatter.
 */
function checkMetadata(findings: LintFinding[], frontmatter: Record<string, unknown>): void {
	const missing = EXPECTED_METADATA.filter((key) => {
		const value = frontmatter[key];
		return typeof value !== "string" || value.trim() === "";
	});
	if (missing.length === 0) return;
	findings.push({
		severity: "warning",
		rule: "missing-metadata",
		message: `frontmatter is missing: ${missing.join(", ")}`,
	});
}

/**
 * Whether `platforms:` is declared with at least one value.
 * @param frontmatter - the parsed frontmatter.
 * @returns true when the declaration is present and non-empty.
 */
function hasPlatforms(frontmatter: Record<string, unknown>): boolean {
	const raw = frontmatter["platforms"];
	if (Array.isArray(raw)) return raw.some((value) => typeof value === "string" && value.trim() !== "");
	return typeof raw === "string" && raw.trim() !== "";
}

/**
 * Every distinct support path the body points at, in order of appearance.
 * @param body - the document text without its frontmatter.
 * @returns the relative paths, with sentence punctuation trimmed off the end.
 */
function supportPaths(body: string): string[] {
	const paths: string[] = [];
	const seen = new Set<string>();
	// `matchAll` needs a fresh cursor; the shared regex is global.
	SUPPORT_PATH_RE.lastIndex = 0;
	for (const match of body.matchAll(SUPPORT_PATH_RE)) {
		const rel = match[0].replace(/[.,;:!?]+$/, "");
		const base = rel.slice(rel.lastIndexOf("/") + 1);
		// A bare directory mention (`references/`) names no file to resolve.
		if (rel === "" || base === "" || !base.includes(".")) continue;
		if (seen.has(rel)) continue;
		seen.add(rel);
		paths.push(rel);
	}
	return paths;
}

/**
 * The document body with any leading frontmatter block removed.
 *
 * Task 3's parser is deliberately strict because it guards a write; this is a
 * read path, so the fences are stripped leniently instead of parsed — a
 * hand-written skill whose frontmatter the write path would refuse must still
 * be lintable, and its frontmatter text must not be read as body prose.
 * @param content - the complete document.
 * @returns the body, or the whole document when there is no frontmatter block.
 */
function bodyOf(content: string): string {
	const text = content.startsWith("\uFEFF") ? content.slice(1) : content;
	const lines = text.split("\n");
	if ((lines[0] ?? "").trim() !== "---") return text;
	for (let index = 1; index < lines.length; index += 1) {
		if ((lines[index] ?? "").trim() === "---") return lines.slice(index + 1).join("\n");
	}
	return text;
}

/**
 * Whether a value is a plain object fit for frontmatter access.
 * @param value - any value.
 * @returns true for a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
