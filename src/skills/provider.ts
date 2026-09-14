/**
 * The two-tier `ctx.skills` providers: a buddy-private layer and a
 * human-promoted layer.
 *
 * Both tiers read the same directory (`<home>/main/skills/<name>/SKILL.md`) and
 * differ in exactly one thing: which `visibility` values they contribute, and
 * for `project:` skills whether the caller's `cwd` falls inside the declared
 * path. That split is the third leg of the isolation contract — a skill a human
 * promotes with `visibility: global` reaches ordinary coding sessions *only*
 * through {@link createPromotedProvider}, and a buddy skill never reaches them
 * at all, because this directory is not any default scan root.
 *
 * - **Read-path tolerance.** `visibility` is parsed with Task 3's
 *   {@link parseFrontmatter}, which never throws. A document whose frontmatter
 *   cannot be parsed is treated as `visibility: buddy` — the least-exposed tier
 *   — so a hand-written skill cannot vanish from the catalog because of a parse
 *   quirk. An absent, empty, malformed (`project:` with no path, a relative
 *   path) or unknown value also resolves to buddy: an unreadable declaration
 *   never *widens* exposure.
 * - **Discovery is one level.** `list` reads `<skillsRoot>/*\/SKILL.md`, skips
 *   anything that is not a directory, skips a directory without a readable
 *   `SKILL.md`, and never recurses. A missing or unreadable root is an empty
 *   catalog, not an exception: the provider runs during first-boot discovery.
 * - **`get` returns the body, not the document.** Frontmatter is removed by
 *   `parseFrontmatter`; when parsing failed the raw text is returned instead
 *   (there is deliberately no second, lenient parser here). The visibility rule
 *   is re-applied at load time, so a file rewritten between `list` and `get`
 *   cannot leak through a stale candidate. A file that is gone resolves to
 *   `undefined`.
 * - **No cordis context.** Dependencies are one plain object so a test can build
 *   them from a temp directory; this module registers nothing (Task 14 does).
 *
 * The types below are declared locally rather than imported: `dsh-skill` is not
 * in this package's `dependencies ∪ peerDependencies`, and `build.mjs` derives
 * its externals from exactly those, so a bare import could neither resolve nor
 * bundle. They are copied field-for-field from `@deepseek-ai/dsh-skill`'s
 * `lib/types/index.d.ts`, so these providers remain structurally assignable to
 * the registry's own `SkillProvider` when a preset row registers them.
 * @module dsh-buddy/skills/provider
 */
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseFrontmatter, SKILL_NAME_RE } from "./validate.ts";

/** The provider name of the buddy-private tier. */
export const BUDDY_SKILL_PROVIDER_NAME = "buddy-skills";

/** The provider name of the human-promoted tier. */
export const PROMOTED_SKILL_PROVIDER_NAME = "buddy-promoted";

/** The file every skill directory must carry. */
export const SKILL_FILE_NAME = "SKILL.md";

/**
 * Rank for a buddy skill: `400`, the same rung `dsh-skill-filesystem` gives a
 * user-level skill, so a duplicate name loses to a project skill and beats a
 * bundled one exactly as a user skill would. `dsh-skill` does not export
 * `USER_DSH_RANK`, so the documented literal is re-declared here.
 */
export const USER_DSH_RANK = 400;

/**
 * Source bucket. `dsh-skill`'s own vocabulary has no "buddy" member, and a
 * skill living under the buddy home is functionally a user-level skill, so
 * `user-dsh` is the closest fit; both tiers use it.
 */
export const BUDDY_SKILL_SOURCE: SkillSource = "user-dsh";

/**
 * The invocation policy of a Buddy-authored skill. Buddy skills are ordinary
 * loadable skills: both the model catalog and a human-facing command catalog
 * may use them. Frontmatter invocation overrides (`disable-model-invocation`
 * and friends) are deliberately **not** read in this layer — the buddy write
 * path never writes them, and a promoted skill's override is the promoting
 * human's business, not this provider's.
 */
export const DEFAULT_INVOCATION: SkillInvocationPolicy = Object.freeze({
	modelInvocable: true,
	userInvocable: true,
});

/** The `visibility:` prefix that scopes a skill to one project path. */
const PROJECT_PREFIX = "project:";

/** A bucket a skill body may be discovered from, as `dsh-skill` types it. */
export type SkillSource =
	| "project-dsh"
	| "project-agents"
	| "runtime"
	| "user-dsh"
	| "user-agents"
	| "custom"
	| "bundled"
	| (string & {});

/** Optional provider-specific base used by loaded skill bodies to resolve relative resources. */
export type SkillResourceBase =
	| { readonly kind: "directory"; readonly path: string }
	| { readonly kind: "url"; readonly url: string }
	| { readonly kind: "opaque"; readonly description: string };

/** Invocation controls shared by skill discovery consumers. */
export interface SkillInvocationPolicy {
	/** Whether model-facing catalogs and loaders include this skill. */
	readonly modelInvocable: boolean;
	/** Whether human-facing command catalogs and loaders include this skill. */
	readonly userInvocable: boolean;
}

/** Invocation-neutral skill metadata returned by the registry. */
export interface SkillSummary {
	/** Kebab-case identifier used to address the skill. */
	readonly name: string;
	/** Short routing description shown by discovery consumers. */
	readonly description: string;
	/** Optional extra routing guidance. */
	readonly whenToUse?: string;
	/** Resolved model and user invocation controls. */
	readonly invocation: SkillInvocationPolicy;
	/** Discovery source that produced this winning skill. */
	readonly source: SkillSource;
	/** Provider that owns this skill body. */
	readonly provider: string;
	/** Provider-specific base for relative resources. */
	readonly resourceBase?: SkillResourceBase;
}

/** Provider catalog entry used by the registry to merge and later load skills. */
export interface SkillCandidate extends SkillSummary {
	/** Lower ranks win duplicate skill names before provider registration order is considered. */
	readonly rank: number;
	/** Opaque provider-owned handle passed back to `provider.get()`. */
	readonly locator: unknown;
	/** Absolute file path when the provider has one. */
	readonly path?: string;
	/** Parsed optional metadata object from provider-specific skill frontmatter. */
	readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Complete parsed skill definition, including the body loaded by the registry. */
export interface SkillDefinition extends SkillSummary {
	/** Markdown instruction body after any provider-specific metadata removal. */
	readonly content: string;
	/** Absolute file path when the skill came from disk. */
	readonly path?: string;
	/** Parsed optional metadata object from frontmatter. */
	readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Caller context used for cwd-sensitive and abortable provider work. */
export interface SkillLookupOptions {
	/** Workspace selector for the current lookup. */
	readonly cwd?: string | undefined;
	/** Abort discovery or loading work for the current caller. */
	readonly signal?: AbortSignal | undefined;
}

/** Provider candidates plus whether the current discovery is authoritative. */
export interface SkillProviderObservation {
	/** Candidates available from the current provider discovery. */
	readonly candidates: readonly SkillCandidate[];
	/** Whether discovery completed and these candidates may be cached. */
	readonly complete: boolean;
}

/** Provider interface for one source of skills. */
export interface SkillProvider {
	/** Unique provider name in the `ctx.skills` registry. */
	readonly name: string;
	/** List available skill candidates for the current lookup context. */
	readonly list: (options: SkillLookupOptions) => Promise<readonly SkillCandidate[] | SkillProviderObservation>;
	/** Load a complete skill body for a previously listed candidate. */
	readonly get: (candidate: SkillCandidate, options: SkillLookupOptions) => Promise<SkillDefinition | undefined>;
}

/**
 * A {@link SkillProvider} whose `list` always resolves to the complete-array
 * shorthand rather than a {@link SkillProviderObservation}.
 *
 * Every read here is a local directory listing, so discovery is either complete
 * or empty — never partial — and the narrowed return type lets a caller read
 * candidates without an `Array.isArray` guard. It is a strict subtype of
 * {@link SkillProvider}, so the registry accepts it unchanged.
 */
export interface CompleteSkillProvider extends SkillProvider {
	/** List every candidate the current lookup may see; always the full array. */
	readonly list: (options: SkillLookupOptions) => Promise<readonly SkillCandidate[]>;
}

/** What a provider actually needs: one absolute skills root. */
export interface ProviderDeps {
	/**
	 * Absolute path to the skills root, i.e. `<buddy home>/main/skills` from
	 * `resolveBuddyPaths`. It need not exist yet.
	 */
	readonly skillsRoot: string;
}

/** Where a discovered skill declares it may be seen. */
export type SkillVisibility =
	| { readonly kind: "buddy" }
	| { readonly kind: "global" }
	| { readonly kind: "project"; readonly path: string };

/** The opaque handle a candidate carries back into `get`. */
interface SkillLocator {
	/** Absolute path of the skill's `SKILL.md`. */
	readonly path: string;
	/** Absolute skill directory, used as the resource base. */
	readonly directory: string;
	/** The directory entry name, the fallback skill name. */
	readonly name: string;
}

/** One skill directory as read from disk. */
interface DiscoveredSkill {
	/** Where the text came from. */
	readonly locator: SkillLocator;
	/** The parsed mapping, or `undefined` when the frontmatter did not parse. */
	readonly frontmatter: Readonly<Record<string, unknown>> | undefined;
	/** The body with frontmatter removed; the raw text when parsing failed. */
	readonly body: string;
	/** This skill's resolved tier. */
	readonly visibility: SkillVisibility;
}

/**
 * Build the buddy-private provider: it contributes `visibility: buddy` skills
 * and skills with no `visibility` field, and nothing else.
 * @param deps - the skills root to discover under.
 * @returns the provider, ready for the registry.
 */
export function createBuddyProvider(deps: ProviderDeps): CompleteSkillProvider {
	return createProvider(deps, BUDDY_SKILL_PROVIDER_NAME, (visibility) => visibility.kind === "buddy");
}

/**
 * Build the human-promoted provider: it contributes `visibility: global`
 * skills always, and `visibility: project: <path>` skills only when the
 * caller's `cwd` is that path or inside it.
 * @param deps - the skills root to discover under.
 * @returns the provider, ready for the registry.
 */
export function createPromotedProvider(deps: ProviderDeps): CompleteSkillProvider {
	return createProvider(deps, PROMOTED_SKILL_PROVIDER_NAME, (visibility, cwd) => {
		if (visibility.kind === "global") return true;
		if (visibility.kind !== "project") return false;
		return cwd !== undefined && isInside(visibility.path, cwd);
	});
}

/**
 * Build one provider around a visibility predicate.
 *
 * The two tiers share every other behaviour — discovery, parsing, the candidate
 * and definition shapes — so that the only difference between them stays the
 * predicate, which is the invariant the isolation contract rests on.
 * @param deps - the skills root to discover under.
 * @param name - this provider's registry name.
 * @param visible - whether a tier-holder with this cwd may see that skill.
 * @returns the provider.
 */
function createProvider(
	deps: ProviderDeps,
	name: string,
	visible: (visibility: SkillVisibility, cwd: string | undefined) => boolean,
): CompleteSkillProvider {
	return {
		name,
		async list(options) {
			// `options.signal` is accepted for contract conformance but never
			// consulted: every read is one local file read with nothing remote to
			// await, so there is no long operation an abort could shorten.
			const skills = await discover(deps.skillsRoot);
			return skills
				.filter((skill) => visible(skill.visibility, options.cwd))
				.map((skill) => toCandidate(name, skill));
		},
		async get(candidate, options) {
			const locator = readLocator(candidate);
			if (locator === undefined) return undefined;
			const skill = await readSkill(locator);
			if (skill === undefined) return undefined;
			// Re-apply the rule at load time: a file rewritten between `list` and
			// `get` must not leak through the stale candidate that was merged.
			if (!visible(skill.visibility, options.cwd)) return undefined;
			return toDefinition(name, skill);
		},
	};
}

/**
 * Read one level under a skills root.
 *
 * A root that does not exist or cannot be read — first boot, a home that was
 * never created — is an empty catalog rather than a failure, because this runs
 * during provider discovery.
 * @param root - the absolute skills root.
 * @returns every readable skill directory, in name order.
 */
async function discover(root: string): Promise<DiscoveredSkill[]> {
	let entries: Dirent[];
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch {
		return [];
	}
	const skills: DiscoveredSkill[] = [];
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		// One level only: a nested `SKILL.md` under an umbrella directory is not
		// a skill of its own, and a symlink is skipped rather than followed.
		if (!entry.isDirectory()) continue;
		const directory = join(root, entry.name);
		const skill = await readSkill({ path: join(directory, SKILL_FILE_NAME), directory, name: entry.name });
		if (skill !== undefined) skills.push(skill);
	}
	return skills;
}

/**
 * Read and interpret one `SKILL.md`.
 * @param locator - the file and its directory.
 * @returns the skill, or `undefined` when the file is not readable.
 */
async function readSkill(locator: SkillLocator): Promise<DiscoveredSkill | undefined> {
	let raw: string;
	try {
		raw = await readFile(locator.path, "utf8");
	} catch {
		// Missing, a directory, or unreadable: the entry is simply not a skill.
		return undefined;
	}
	const parsed = parseFrontmatter(raw);
	if ("error" in parsed) {
		// Read-path tolerance: an unparsable declaration is treated as buddy, and
		// the raw text is the content because there is no second, lenient parser
		// to guess where the frontmatter ended.
		return { locator, frontmatter: undefined, body: raw, visibility: { kind: "buddy" } };
	}
	return {
		locator,
		frontmatter: parsed.frontmatter,
		body: parsed.body,
		visibility: resolveVisibility(parsed.frontmatter),
	};
}

/**
 * Resolve a parsed frontmatter's `visibility` declaration.
 * @param frontmatter - the parsed mapping; `undefined` when parsing failed.
 * @returns the declared tier, defaulting to buddy for every unreadable value.
 */
function resolveVisibility(frontmatter: Readonly<Record<string, unknown>> | undefined): SkillVisibility {
	if (frontmatter === undefined) return { kind: "buddy" };
	const raw = frontmatter["visibility"];
	// Absent, or not a scalar: buddy.
	if (typeof raw !== "string") return { kind: "buddy" };
	const value = raw.trim();
	// Absent (empty) or explicitly buddy.
	if (value === "" || value === "buddy") return { kind: "buddy" };
	if (value === "global") return { kind: "global" };
	if (value.startsWith(PROJECT_PREFIX)) {
		const path = value.slice(PROJECT_PREFIX.length).trim();
		// A `project:` with no absolute path cannot be scoped honestly: resolving
		// a relative one against the process cwd would silently pick a directory
		// the author never named, so it falls back to the private tier.
		if (path !== "" && isAbsolute(path)) return { kind: "project", path };
	}
	// Unknown value: the safe direction is the least-exposed tier.
	return { kind: "buddy" };
}

/**
 * Whether a `cwd` is a project path or lives inside it.
 * @param root - the declared absolute project path.
 * @param cwd - the caller's workspace.
 * @returns whether `cwd` is inside `root`.
 */
function isInside(root: string, cwd: string): boolean {
	const rel = relative(resolve(root), resolve(cwd));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * The skill's addressable name.
 *
 * The frontmatter name wins when it is a valid DSH kebab-case name, matching
 * the filesystem provider; otherwise the directory name is used, so a
 * hand-written file with no `name:` is still addressable by its directory.
 * @param skill - the discovered skill.
 * @returns the candidate name.
 */
function skillName(skill: DiscoveredSkill): string {
	const declared = skill.frontmatter?.["name"];
	if (typeof declared === "string" && SKILL_NAME_RE.test(declared)) return declared;
	return skill.locator.name;
}

/**
 * The description shown by discovery consumers.
 * @param skill - the discovered skill.
 * @param name - the resolved skill name.
 * @returns the declared description, or the name when nothing usable is declared.
 */
function skillDescription(skill: DiscoveredSkill, name: string): string {
	const declared = skill.frontmatter?.["description"];
	if (typeof declared === "string" && declared.trim() !== "") return declared;
	return name;
}

/**
 * The optional routing hint, read from frontmatter key `whenToUse` — the same
 * key `dsh-skill-filesystem` reads.
 * @param skill - the discovered skill.
 * @returns the hint, or `undefined` when absent.
 */
function skillWhenToUse(skill: DiscoveredSkill): string | undefined {
	const declared = skill.frontmatter?.["whenToUse"];
	if (typeof declared !== "string" || declared.trim() === "") return undefined;
	return declared;
}

/**
 * Build the invocation-neutral half of a summary.
 * @param provider - this provider's name.
 * @param skill - the discovered skill.
 * @returns the summary fields both a candidate and a definition carry.
 */
function toSummary(provider: string, skill: DiscoveredSkill): SkillSummary {
	const name = skillName(skill);
	const whenToUse = skillWhenToUse(skill);
	return {
		name,
		description: skillDescription(skill, name),
		// `exactOptionalPropertyTypes`: omit rather than pass `undefined`.
		...(whenToUse === undefined ? {} : { whenToUse }),
		invocation: DEFAULT_INVOCATION,
		source: BUDDY_SKILL_SOURCE,
		provider,
		resourceBase: { kind: "directory", path: skill.locator.directory },
	};
}

/**
 * Build a candidate for one discovered skill.
 * @param provider - this provider's name.
 * @param skill - the discovered skill.
 * @returns the catalog entry.
 */
function toCandidate(provider: string, skill: DiscoveredSkill): SkillCandidate {
	return {
		...toSummary(provider, skill),
		rank: USER_DSH_RANK,
		locator: skill.locator,
		path: skill.locator.path,
	};
}

/**
 * Build a loadable definition for one discovered skill.
 * @param provider - this provider's name.
 * @param skill - the discovered skill.
 * @returns the definition, with the body's frontmatter removed.
 */
function toDefinition(provider: string, skill: DiscoveredSkill): SkillDefinition {
	return {
		...toSummary(provider, skill),
		content: skill.body,
		path: skill.locator.path,
	};
}

/**
 * Recover this provider's locator from a candidate.
 *
 * `locator` is typed `unknown` by the contract and only this provider's own
 * locator is expected here; anything else resolves to `undefined` rather than
 * being trusted as a path.
 * @param candidate - the candidate passed back to `get`.
 * @returns the locator, or `undefined` when it is not ours.
 */
function readLocator(candidate: SkillCandidate): SkillLocator | undefined {
	const locator = candidate.locator;
	if (typeof locator !== "object" || locator === null) return undefined;
	const record = locator as Record<string, unknown>;
	const path = record["path"];
	const directory = record["directory"];
	const name = record["name"];
	if (typeof path !== "string" || typeof directory !== "string" || typeof name !== "string") return undefined;
	return { path, directory, name };
}
