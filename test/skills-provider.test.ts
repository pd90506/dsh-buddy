/**
 * Task 9: the two-tier skill providers.
 *
 * The visibility split is the whole point of this layer, so the tests assert
 * it from both sides: the buddy provider must not leak a skill a human promoted
 * (`global` / `project:`) into ordinary Buddy sessions, and the promoted
 * provider must not leak a buddy-only skill into the global layer. A `project:`
 * skill is scoped by the caller's `cwd`, and an absent or unreadable
 * `skillsRoot` yields an empty catalog instead of an exception, because the
 * provider runs during first-boot discovery.
 *
 * Read-path tolerance is asserted directly: a document whose frontmatter cannot
 * be parsed still appears — as a buddy skill, with its summary scalars salvaged
 * — rather than vanishing from the catalog, and `get` still returns its body.
 *
 * The registry-precondition guard is asserted from the other side: a skill
 * whose name is not kebab-case or that declares no usable description is
 * **skipped**, and a valid sibling in the same root must still be listed. That
 * proves the skip is scoped — `dsh-skill`'s candidate validation throws outside
 * its own `try`, so passing one bad entry through would abort discovery for the
 * whole layer.
 *
 * Every candidate `list()` returns and every definition `get()` returns in this
 * suite passes through {@link listChecked} / {@link getChecked}, which assert
 * the whole registry contract on it — not just the fields a test happens to
 * look at. `provider === provider.name`, a finite `rank`, a string `source`,
 * boolean invocation flags, a kebab-case name, a non-empty description and a
 * string `path` are correct *by construction* in `provider.ts`; this is what
 * fails if a later refactor perturbs one.
 *
 * Every filesystem test uses a real temp directory and tears it down in
 * `finally`; no test writes into `~/.dsh`.
 * @module test/skills-provider
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	BUDDY_SKILL_PROVIDER_NAME,
	PROMOTED_SKILL_PROVIDER_NAME,
	createBuddyProvider,
	createPromotedProvider,
	type CompleteSkillProvider,
	type ProviderDeps,
	type SkillCandidate,
	type SkillDefinition,
	type SkillLookupOptions,
} from "../src/skills/provider.ts";

/**
 * The registry's own skill-name grammar, deliberately inlined instead of
 * imported from `src/skills/validate.ts`: the point of this copy is to catch a
 * drift between what this provider emits and what `dsh-skill` accepts, and
 * reusing the provider's own constant would hide exactly that drift. Literal
 * copied from `@deepseek-ai/dsh-skill/lib/index.js:17`.
 */
const REGISTRY_SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A temp buddy home plus the handles a test drives through it. */
interface Fixture {
	/** The dependencies under test: one `skillsRoot` inside the temp home. */
	readonly deps: ProviderDeps;
	/**
	 * Write `<skillsRoot>/<name>/SKILL.md` with a generated description and body.
	 * @param name - the skill directory name.
	 * @param frontmatter - extra frontmatter lines, without their newline.
	 * @returns the absolute skill directory.
	 */
	writeSkill(name: string, frontmatter?: string): Promise<string>;
	/**
	 * Write an arbitrary file, creating parent directories.
	 * @param rel - a path relative to the temp home.
	 * @param content - the exact file text.
	 * @returns the absolute file path.
	 */
	writeRaw(rel: string, content: string): Promise<string>;
	/** Remove the temp home. */
	cleanup(): Promise<void>;
}

/**
 * Assert every precondition `dsh-skill` checks on a summary it is handed.
 *
 * The registry validates each entry with a **throw**, and for candidates that
 * throw sits outside the `try` that wraps `provider.list()`
 * (`dsh-skill/lib/index.js:359-360`, validator at `:452`), so one perturbed
 * field is a catalog-wide failure rather than a skipped skill. These properties
 * hold by construction in `provider.ts`; this helper is the tripwire.
 * @param provider - the provider that produced the entry; its own `name` is the
 *   value the `provider` field must equal.
 * @param entry - the candidate or definition to check.
 */
function assertRegistryShape(provider: CompleteSkillProvider, entry: SkillCandidate | SkillDefinition): void {
	assert.equal(entry.provider, provider.name, `'${entry.name}' must report provider '${provider.name}'`);
	assert.equal(typeof entry.source, "string", `'${entry.name}' must have a string source`);
	assert.equal(
		typeof entry.invocation.modelInvocable,
		"boolean",
		`'${entry.name}' must have a boolean invocation.modelInvocable`,
	);
	assert.equal(
		typeof entry.invocation.userInvocable,
		"boolean",
		`'${entry.name}' must have a boolean invocation.userInvocable`,
	);
	assert.ok(REGISTRY_SKILL_NAME.test(entry.name), `'${entry.name}' must match the registry's name grammar`);
	assert.ok(entry.description.length > 0, `'${entry.name}' must carry a non-empty description`);
	if (entry.path !== undefined) assert.equal(typeof entry.path, "string", `'${entry.name}' must have a string path`);
}

/**
 * List through a provider, asserting the registry contract on every candidate.
 * @param provider - the provider to list.
 * @param options - the lookup options to pass through.
 * @returns exactly what the provider returned.
 */
async function listChecked(
	provider: CompleteSkillProvider,
	options: SkillLookupOptions = {},
): Promise<readonly SkillCandidate[]> {
	const candidates = await provider.list(options);
	for (const candidate of candidates) {
		assertRegistryShape(provider, candidate);
		assert.ok(Number.isFinite(candidate.rank), `'${candidate.name}' must have a finite rank`);
	}
	return candidates;
}

/**
 * Load through a provider, asserting the registry contract on any definition.
 * @param provider - the provider to load through.
 * @param candidate - the candidate returned by that provider's `list`.
 * @param options - the lookup options to pass through.
 * @returns exactly what the provider returned.
 */
async function getChecked(
	provider: CompleteSkillProvider,
	candidate: SkillCandidate,
	options: SkillLookupOptions = {},
): Promise<SkillDefinition | undefined> {
	const definition = await provider.get(candidate, options);
	if (definition !== undefined) assertRegistryShape(provider, definition);
	return definition;
}

/**
 * Create one temp buddy home with an existing (empty) skills root, mirroring
 * the layout `resolveBuddyPaths` produces (`<home>/main/skills`).
 * @returns the fixture; the caller must `cleanup()` it in a `finally`.
 */
async function fixture(): Promise<Fixture> {
	const home = await mkdtemp(join(tmpdir(), "buddy-skills-provider-"));
	const skillsRoot = join(home, "main", "skills");
	await mkdir(skillsRoot, { recursive: true });
	return {
		deps: { skillsRoot },
		async writeSkill(name, frontmatter = "") {
			const dir = join(skillsRoot, name);
			await mkdir(dir, { recursive: true });
			const extra = frontmatter === "" ? "" : `${frontmatter}\n`;
			await writeFile(
				join(dir, "SKILL.md"),
				`---\nname: ${name}\ndescription: helps with ${name}\n${extra}---\n\n## When to Use\n\nUse this for ${name}.\n`,
			);
			return dir;
		},
		async writeRaw(rel, content) {
			const path = join(home, rel);
			await mkdir(join(path, ".."), { recursive: true });
			await writeFile(path, content);
			return path;
		},
		cleanup: () => rm(home, { recursive: true, force: true }),
	};
}

/**
 * @param provider - the provider to list.
 * @param cwd - the optional caller workspace.
 * @returns the sorted candidate names.
 */
async function names(provider: CompleteSkillProvider, cwd?: string): Promise<string[]> {
	const listed = await listChecked(provider, cwd === undefined ? {} : { cwd });
	return listed.map((candidate) => candidate.name).sort();
}

test("the buddy layer sees buddy-visibility skills and nothing else", async () => {
	const { deps, writeSkill, cleanup } = await fixture();
	try {
		await writeSkill("only-buddy", "visibility: buddy");
		await writeSkill("promoted", "visibility: global");
		await writeSkill("no-field", "");
		const names = (await listChecked(createBuddyProvider(deps), {})).map((c) => c.name).sort();
		assert.deepEqual(names, ["no-field", "only-buddy"]);
	} finally {
		await cleanup();
	}
});

test("the promoted provider honours project scoping through cwd", async () => {
	const { deps, writeSkill, cleanup } = await fixture();
	try {
		await writeSkill("for-project", "visibility: project: /work/alpha");
		const provider = createPromotedProvider(deps);
		const inside = (await listChecked(provider, { cwd: "/work/alpha/sub" })).map((c) => c.name);
		const outside = (await listChecked(provider, { cwd: "/work/beta" })).map((c) => c.name);
		assert.deepEqual(inside, ["for-project"]);
		assert.deepEqual(outside, []);
	} finally {
		await cleanup();
	}
});

test("a candidate is loadable and carries a directory resource base", async () => {
	const { deps, writeSkill, cleanup } = await fixture();
	try {
		const dir = await writeSkill("only-buddy", "visibility: buddy");
		const provider = createBuddyProvider(deps);
		const [candidate] = await listChecked(provider, {});
		const loaded = await getChecked(provider, candidate!, {});
		assert.equal(loaded?.name, candidate!.name);
		assert.equal(loaded?.resourceBase?.kind, "directory");
		assert.equal(loaded?.resourceBase?.kind === "directory" ? loaded.resourceBase.path : undefined, dir);
		assert.equal(loaded?.path, join(dir, "SKILL.md"));
	} finally {
		await cleanup();
	}
});

test("the promoted layer contributes global skills and hides buddy skills", async () => {
	const { deps, writeSkill, cleanup } = await fixture();
	try {
		await writeSkill("only-buddy", "visibility: buddy");
		await writeSkill("no-field", "");
		await writeSkill("shared-name", "visibility: global");
		const provider = createPromotedProvider(deps);
		assert.deepEqual(await names(provider), ["shared-name"]);
		assert.equal(provider.name, PROMOTED_SKILL_PROVIDER_NAME);
		assert.equal(createBuddyProvider(deps).name, BUDDY_SKILL_PROVIDER_NAME);
	} finally {
		await cleanup();
	}
});

test("a project skill needs a cwd inside its path, and cwd prefixes do not count", async () => {
	const { deps, writeSkill, cleanup } = await fixture();
	try {
		await writeSkill("for-project", "visibility: project: /work/alpha");
		const provider = createPromotedProvider(deps);
		assert.deepEqual(await names(provider), []);
		assert.deepEqual(await names(provider, "/work/alpha"), ["for-project"]);
		assert.deepEqual(await names(provider, "/work/alpha/"), ["for-project"]);
		assert.deepEqual(await names(provider, "/work/alpha2"), []);
		assert.deepEqual(await names(provider, "/work/alph"), []);
	} finally {
		await cleanup();
	}
});

test("an unparsable document is salvaged into the buddy catalog and still loads", async () => {
	const { deps, writeRaw, cleanup } = await fixture();
	try {
		// A nested mapping is outside the flat subset `parseFrontmatter` accepts,
		// which is exactly the hand-written quirk this tolerance is for. The
		// summary scalars are still readable, so the skill survives instead of
		// breaking discovery or vanishing.
		const raw =
			"---\nname: hand-written\ndescription: written by hand\nmetadata:\n  tags: [a, b]\n---\n\nHand-written body.\n";
		const path = await writeRaw("main/skills/hand-written/SKILL.md", raw);
		const provider = createBuddyProvider(deps);
		assert.deepEqual(await names(provider), ["hand-written"]);
		const [candidate] = await listChecked(provider, {});
		assert.equal(candidate?.description, "written by hand");
		const loaded = await getChecked(provider, candidate!, {});
		assert.equal(loaded?.name, "hand-written");
		// The documented fallback: with no parseable fence there is no body to
		// separate, so the raw text is the content and the skill stays loadable.
		assert.equal(loaded?.content, raw);
		assert.equal(loaded?.path, path);
	} finally {
		await cleanup();
	}
});

test("salvage never reads visibility, so a malformed file cannot promote itself", async () => {
	const { deps, writeSkill, writeRaw, cleanup } = await fixture();
	try {
		// The nested `metadata:` breaks the parse; the `visibility: global` line
		// is real frontmatter, but a declaration that could not be parsed must
		// never widen exposure.
		await writeRaw(
			"main/skills/sneaky/SKILL.md",
			"---\nname: sneaky\ndescription: tries to promote itself\nvisibility: global\nmetadata:\n  tags: [a]\n---\n\nbody\n",
		);
		await writeSkill("good-skill", "visibility: buddy");
		assert.deepEqual(await names(createBuddyProvider(deps)), ["good-skill", "sneaky"]);
		assert.deepEqual(await names(createPromotedProvider(deps)), []);
	} finally {
		await cleanup();
	}
});

test("a file that declares no description is skipped, and a valid sibling survives", async () => {
	const { deps, writeSkill, writeRaw, cleanup } = await fixture();
	try {
		// No `description:` key at all.
		await writeRaw("main/skills/bare-skill/SKILL.md", "---\nname: bare-skill\n---\n\nbody\n");
		// An explicitly empty description, the shape the parser yields for a
		// bare `description:` key.
		await writeRaw("main/skills/empty-description/SKILL.md", "---\nname: empty-description\ndescription:\n---\n\nbody\n");
		// An empty quoted description.
		await writeRaw(
			"main/skills/quoted-empty/SKILL.md",
			'---\nname: quoted-empty\ndescription: ""\n---\n\nbody\n',
		);
		// Whitespace only: the registry accepts it, but it advertises nothing.
		await writeRaw(
			"main/skills/whitespace-only/SKILL.md",
			'---\nname: whitespace-only\ndescription: "   "\n---\n\nbody\n',
		);
		// A whole document with no fence: nothing to read, so nothing to say.
		await writeRaw("main/skills/plain-note/SKILL.md", "# Plain note\n\nJust prose, no fence at all.\n");
		await writeSkill("good-skill", "visibility: buddy");
		const provider = createBuddyProvider(deps);
		// The bad entries are absent; the good one is untouched, proving the skip
		// is scoped rather than fatal.
		assert.deepEqual(await names(provider), ["good-skill"]);
		const [candidate] = await listChecked(provider, {});
		assert.equal((await getChecked(provider, candidate!, {}))?.name, "good-skill");
	} finally {
		await cleanup();
	}
});

test("a directory whose name is not kebab-case is skipped, and a valid sibling survives", async () => {
	const { deps, writeSkill, writeRaw, cleanup } = await fixture();
	try {
		// The directory name is the name handed to the registry here, because the
		// frontmatter name fails the same grammar and falls back to the directory.
		await writeRaw(
			"main/skills/Not-Kebab/SKILL.md",
			"---\nname: Not-Kebab\ndescription: has a capital and another capital\n---\n\nbody\n",
		);
		await writeSkill("good-skill", "visibility: buddy");
		assert.deepEqual(await names(createBuddyProvider(deps)), ["good-skill"]);
		assert.deepEqual(await names(createPromotedProvider(deps)), []);
	} finally {
		await cleanup();
	}
});

test("an invalid frontmatter name falls back to the directory name", async () => {
	const { deps, writeRaw, cleanup } = await fixture();
	try {
		// The documented decision: the candidate name is whatever the registry
		// will actually check. An unusable declaration falls back to the
		// directory, which is valid here, so the skill stays addressable.
		await writeRaw(
			"main/skills/fine-name/SKILL.md",
			"---\nname: Not Kebab\ndescription: declares an unusable name\n---\n\nbody\n",
		);
		const provider = createBuddyProvider(deps);
		assert.deepEqual(await names(provider), ["fine-name"]);
		const [candidate] = await listChecked(provider, {});
		assert.equal(candidate?.name, "fine-name");
	} finally {
		await cleanup();
	}
});

test("a valid frontmatter name deliberately wins over the directory name", async () => {
	const { deps, writeRaw, cleanup } = await fixture();
	try {
		// Both names satisfy the grammar, so this is not a fallback: the declared
		// name is the addressable one. That mirrors the shipped filesystem
		// provider, which takes `parsed.name` from the frontmatter rather than the
		// directory (`dsh-skill-filesystem/lib/index.js:120`), and it is the case
		// a reader tends to assume goes the other way.
		await writeRaw(
			"main/skills/fine-name/SKILL.md",
			"---\nname: other-name\ndescription: declares a different name\n---\n\nbody\n",
		);
		const provider = createBuddyProvider(deps);
		assert.deepEqual(await names(provider), ["other-name"]);
		const [candidate] = await listChecked(provider, {});
		assert.equal(candidate?.name, "other-name");
		// `get` agrees, so the registry's `definition.name === candidate.name`
		// re-check cannot invalidate the entry.
		assert.equal((await getChecked(provider, candidate!, {}))?.name, "other-name");
	} finally {
		await cleanup();
	}
});

test("get refuses a candidate whose description disappeared after listing", async () => {
	const { deps, writeSkill, writeRaw, cleanup } = await fixture();
	try {
		await writeSkill("loses-its-description", "visibility: buddy");
		const provider = createBuddyProvider(deps);
		const [candidate] = await listChecked(provider, {});
		assert.ok(candidate !== undefined);
		await writeRaw("main/skills/loses-its-description/SKILL.md", "---\nname: loses-its-description\n---\n\nbody\n");
		// Returning a definition here would make the registry throw; `undefined`
		// is the contract's "no longer loadable".
		assert.equal(await getChecked(provider, candidate, {}), undefined);
	} finally {
		await cleanup();
	}
});

test("get re-applies the visibility rule to a file rewritten after listing", async () => {
	const { deps, writeSkill, cleanup } = await fixture();
	try {
		await writeSkill("changed-its-mind", "visibility: buddy");
		const buddy = createBuddyProvider(deps);
		const promoted = createPromotedProvider(deps);
		const [candidate] = await listChecked(buddy, {});
		// The same directory name, now promoted: the stale candidate must not
		// load through the buddy tier.
		await writeSkill("changed-its-mind", "visibility: global");
		assert.equal(await getChecked(buddy, candidate!, {}), undefined);
		assert.deepEqual(await names(buddy), []);
		assert.deepEqual(await names(promoted), ["changed-its-mind"]);
	} finally {
		await cleanup();
	}
});

test("a project skill loads through the promoted tier only inside its cwd", async () => {
	const { deps, writeSkill, cleanup } = await fixture();
	try {
		await writeSkill("for-project", "visibility: project: /work/alpha");
		const promoted = createPromotedProvider(deps);
		const [candidate] = await listChecked(promoted, { cwd: "/work/alpha/sub" });
		assert.ok(candidate !== undefined);
		assert.equal((await getChecked(promoted, candidate, { cwd: "/work/alpha/sub" }))?.name, "for-project");
		assert.equal(await getChecked(promoted, candidate, { cwd: "/work/beta" }), undefined);
		assert.equal(await getChecked(promoted, candidate, {}), undefined);
	} finally {
		await cleanup();
	}
});

test("an unknown visibility value is treated as buddy", async () => {
	const { deps, writeSkill, cleanup } = await fixture();
	try {
		await writeSkill("odd-value", "visibility: public");
		assert.deepEqual(await names(createBuddyProvider(deps)), ["odd-value"]);
		assert.deepEqual(await names(createPromotedProvider(deps)), []);
	} finally {
		await cleanup();
	}
});

test("get returns the body with the frontmatter removed", async () => {
	const { deps, writeSkill, cleanup } = await fixture();
	try {
		await writeSkill("only-buddy", "visibility: buddy");
		const provider = createBuddyProvider(deps);
		const [candidate] = await listChecked(provider, {});
		const loaded = await getChecked(provider, candidate!, {});
		// `parseFrontmatter` returns everything after the closing fence, blank
		// separator line included; this layer does not re-trim it.
		assert.equal(loaded?.content, "\n## When to Use\n\nUse this for only-buddy.\n");
	} finally {
		await cleanup();
	}
});

test("get returns undefined once the file is gone", async () => {
	const { deps, writeSkill, cleanup } = await fixture();
	try {
		await writeSkill("only-buddy", "visibility: buddy");
		const provider = createBuddyProvider(deps);
		const [candidate] = await listChecked(provider, {});
		await rm(join(deps.skillsRoot, "only-buddy"), { recursive: true, force: true });
		assert.equal(await getChecked(provider, candidate!, {}), undefined);
	} finally {
		await cleanup();
	}
});

test("a missing or unreadable skills root yields an empty list", async () => {
	const home = await mkdtemp(join(tmpdir(), "buddy-skills-provider-"));
	try {
		const deps: ProviderDeps = { skillsRoot: join(home, "not", "there") };
		assert.deepEqual(await listChecked(createBuddyProvider(deps), {}), []);
		assert.deepEqual(await listChecked(createPromotedProvider(deps), {}), []);
		// A file where the root should be is unreadable as a directory too.
		await writeFile(join(home, "afile"), "not a directory");
		assert.deepEqual(await listChecked(createBuddyProvider({ skillsRoot: join(home, "afile") }), {}), []);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("discovery is one level deep and skips entries without a SKILL.md", async () => {
	const { deps, writeSkill, writeRaw, cleanup } = await fixture();
	try {
		await writeSkill("real-skill", "visibility: buddy");
		// A loose file at the root is not a skill.
		await writeRaw("main/skills/notes.md", "just a note\n");
		// A directory without SKILL.md is not a skill.
		await writeRaw("main/skills/empty-dir/README.md", "nothing here\n");
		// A nested skill is deliberately not discovered: the scan is one level.
		await writeRaw("main/skills/umbrella/nested/SKILL.md", "---\nname: nested\ndescription: nested\n---\n\nnested\n");
		assert.deepEqual(await names(createBuddyProvider(deps)), ["real-skill"]);
	} finally {
		await cleanup();
	}
});
