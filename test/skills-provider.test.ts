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
 * be parsed still appears — as a buddy skill — rather than vanishing from the
 * catalog, and `get` still returns its body. Every filesystem test uses a real
 * temp directory and tears it down in `finally`; no test writes into `~/.dsh`.
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
	type ProviderDeps,
} from "../src/skills/provider.ts";

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
async function names(provider: ReturnType<typeof createBuddyProvider>, cwd?: string): Promise<string[]> {
	const listed = await provider.list(cwd === undefined ? {} : { cwd });
	return listed.map((candidate) => candidate.name).sort();
}

test("the buddy layer sees buddy-visibility skills and nothing else", async () => {
	const { deps, writeSkill, cleanup } = await fixture();
	try {
		await writeSkill("only-buddy", "visibility: buddy");
		await writeSkill("promoted", "visibility: global");
		await writeSkill("no-field", "");
		const names = (await createBuddyProvider(deps).list({})).map((c) => c.name).sort();
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
		const inside = (await provider.list({ cwd: "/work/alpha/sub" })).map((c) => c.name);
		const outside = (await provider.list({ cwd: "/work/beta" })).map((c) => c.name);
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
		const [candidate] = await provider.list({});
		const loaded = await provider.get(candidate!, {});
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

test("an unparsable document stays in the buddy catalog and still loads", async () => {
	const { deps, writeRaw, cleanup } = await fixture();
	try {
		// A nested mapping is outside the flat subset `parseFrontmatter` accepts,
		// which is exactly the hand-written quirk this tolerance is for.
		const raw =
			"---\nname: hand-written\ndescription: written by hand\nmetadata:\n  tags: [a, b]\n---\n\nHand-written body.\n";
		const path = await writeRaw("main/skills/hand-written/SKILL.md", raw);
		const provider = createBuddyProvider(deps);
		assert.deepEqual(await names(provider), ["hand-written"]);
		const [candidate] = await provider.list({});
		// Parsing failed, so there is no declaration to read: the description
		// falls back to the directory name like the name does.
		assert.equal(candidate?.description, "hand-written");
		const loaded = await provider.get(candidate!, {});
		assert.equal(loaded?.name, "hand-written");
		// The documented fallback: with no parseable fence there is no body to
		// separate, so the raw text is the content and the skill stays loadable.
		assert.equal(loaded?.content, raw);
		assert.equal(loaded?.path, path);
	} finally {
		await cleanup();
	}
});

test("a plain markdown file with no frontmatter is addressable by its directory name", async () => {
	const { deps, writeRaw, cleanup } = await fixture();
	try {
		const raw = "# Plain note\n\nJust prose, no fence at all.\n";
		await writeRaw("main/skills/plain-note/SKILL.md", raw);
		const provider = createBuddyProvider(deps);
		assert.deepEqual(await names(provider), ["plain-note"]);
		const [candidate] = await provider.list({});
		// No usable name or description to read, so both fall back to the
		// directory name rather than dropping the entry.
		assert.equal(candidate?.name, "plain-note");
		assert.equal(candidate?.description, "plain-note");
		const loaded = await provider.get(candidate!, {});
		assert.equal(loaded?.content, raw);
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
		const [candidate] = await buddy.list({});
		// The same directory name, now promoted: the stale candidate must not
		// load through the buddy tier.
		await writeSkill("changed-its-mind", "visibility: global");
		assert.equal(await buddy.get(candidate!, {}), undefined);
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
		const [candidate] = await promoted.list({ cwd: "/work/alpha/sub" });
		assert.ok(candidate !== undefined);
		assert.equal((await promoted.get(candidate, { cwd: "/work/alpha/sub" }))?.name, "for-project");
		assert.equal(await promoted.get(candidate, { cwd: "/work/beta" }), undefined);
		assert.equal(await promoted.get(candidate, {}), undefined);
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
		const [candidate] = await provider.list({});
		const loaded = await provider.get(candidate!, {});
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
		const [candidate] = await provider.list({});
		await rm(join(deps.skillsRoot, "only-buddy"), { recursive: true, force: true });
		assert.equal(await provider.get(candidate!, {}), undefined);
	} finally {
		await cleanup();
	}
});

test("a missing or unreadable skills root yields an empty list", async () => {
	const home = await mkdtemp(join(tmpdir(), "buddy-skills-provider-"));
	try {
		const deps: ProviderDeps = { skillsRoot: join(home, "not", "there") };
		assert.deepEqual(await createBuddyProvider(deps).list({}), []);
		assert.deepEqual(await createPromotedProvider(deps).list({}), []);
		// A file where the root should be is unreadable as a directory too.
		await writeFile(join(home, "afile"), "not a directory");
		assert.deepEqual(await createBuddyProvider({ skillsRoot: join(home, "afile") }).list({}), []);
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
