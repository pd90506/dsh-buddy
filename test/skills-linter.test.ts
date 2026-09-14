import assert from "node:assert/strict";
import { test } from "node:test";
import { lintSkill, type LintInput } from "../src/skills/linter.ts";

/** One rule under test per call, on top of a document every rule accepts. */
type SkillOverrides = {
	body?: string;
	frontmatter?: Record<string, unknown>;
	skillName?: string;
	content?: string;
	dirExists?: (rel: string) => boolean;
};

/**
 * Assemble the input `lintSkill` receives, with valid defaults.
 *
 * `content` is built from the same body the caller overrides, so rules that
 * read the document text and rules that read the parsed frontmatter always see
 * one consistent skill.
 * @param overrides - body, frontmatter, directory name, raw content, or probe.
 * @returns the input for one linter call.
 */
function skill(overrides: SkillOverrides = {}): LintInput {
	const skillName = overrides.skillName ?? "demo-skill";
	const body = overrides.body ?? "## When to Use\nUse this skill when a demo is needed.\n";
	const frontmatter: Record<string, unknown> = {
		name: skillName,
		description: "A demo skill for tests.",
		visibility: "public",
		version: "1.0.0",
		author: "Buddy",
		license: "MIT",
		...overrides.frontmatter,
	};
	const content = overrides.content ?? `---\nname: ${skillName}\n---\n${body}`;
	const input: LintInput = { content, skillDir: `/skills/${skillName}`, skillName, frontmatter };
	if (overrides.dirExists !== undefined) input.dirExists = overrides.dirExists;
	return input;
}

test("a well-formed skill produces no findings at all", () => {
	assert.deepEqual(lintSkill(skill()), []);
});

test("name-format enforces DSH's kebab-case grammar as an error", () => {
	const findings = lintSkill(skill({ frontmatter: { name: "Bad_Name" } }));
	const rule = findings.find((f) => f.rule === "name-format");
	assert.ok(rule);
	assert.equal(rule.severity, "error");
	assert.equal(lintSkill(skill()).some((f) => f.rule === "name-format"), false);
});

test("name-dir-mismatch compares the frontmatter name with the directory name", () => {
	const findings = lintSkill(skill({ frontmatter: { name: "other-skill" } }));
	const rule = findings.find((f) => f.rule === "name-dir-mismatch");
	assert.ok(rule);
	assert.equal(rule.severity, "error");
	assert.match(rule.message, /other-skill/);
	assert.match(rule.message, /demo-skill/);
	assert.equal(lintSkill(skill()).some((f) => f.rule === "name-dir-mismatch"), false);
});

test("description-length warns only above the 60-char create limit", () => {
	const atLimit = lintSkill(skill({ frontmatter: { description: "x".repeat(60) } }));
	assert.equal(atLimit.some((f) => f.rule === "description-length"), false);
	const findings = lintSkill(skill({ frontmatter: { description: "x".repeat(61) } }));
	const rule = findings.find((f) => f.rule === "description-length");
	assert.ok(rule);
	assert.equal(rule.severity, "warning");
});

test("description-marketing flags sales words", () => {
	const findings = lintSkill(skill({ frontmatter: { description: "A powerful and robust tool." } }));
	const rule = findings.find((f) => f.rule === "description-marketing");
	assert.ok(rule);
	assert.equal(rule.severity, "warning");
	assert.match(rule.message, /powerful/);
	assert.equal(lintSkill(skill()).some((f) => f.rule === "description-marketing"), false);
});

test("missing-section warns when there is no '## When to Use' heading", () => {
	const findings = lintSkill(skill({ body: "Just prose, no heading.\n" }));
	const rule = findings.find((f) => f.rule === "missing-section");
	assert.ok(rule);
	assert.equal(rule.severity, "warning");
	assert.equal(lintSkill(skill()).some((f) => f.rule === "missing-section"), false);
});

test("incident-log-shape fires only at >=4 refs AND >=0.5 per 1k chars", () => {
	const dense = "## When to Use\n" + "see #1234 #1235 #1236 #1237 for why.\n".repeat(20);
	assert.ok(lintSkill(skill({ body: dense })).some((f) => f.rule === "incident-log-shape"));
	const one = "## When to Use\nfixed in #1234.\n" + "prose ".repeat(400);
	assert.ok(!lintSkill(skill({ body: one })).some((f) => f.rule === "incident-log-shape"));
});

test("dangling-reference probes the injected predicate and never the real filesystem", () => {
	const body = "## When to Use\nSee `references/present.md` and `references/missing.md`.\n";
	const probed = lintSkill(skill({ body, dirExists: (rel) => rel === "references/present.md" }));
	const rules = probed.filter((f) => f.rule === "dangling-reference");
	assert.equal(rules.length, 1);
	const rule = rules[0];
	assert.ok(rule);
	assert.equal(rule.severity, "warning");
	assert.match(rule.message, /references\/missing\.md/);
	// Without a probe there is nothing to know, so the rule stays silent.
	assert.equal(lintSkill(skill({ body })).some((f) => f.rule === "dangling-reference"), false);
});

test("platforms-value rejects values outside the allowed set", () => {
	const findings = lintSkill(skill({ frontmatter: { platforms: "plan9" } }));
	const rule = findings.find((f) => f.rule === "platforms-value");
	assert.ok(rule);
	assert.equal(rule.severity, "warning");
	assert.match(rule.message, /plan9/);
	assert.ok(lintSkill(skill({ frontmatter: { platforms: ["linux", "beos"] } })).some((f) => f.rule === "platforms-value"));
	assert.equal(
		lintSkill(skill({ frontmatter: { platforms: ["linux", "darwin"] } })).some((f) => f.rule === "platforms-value"),
		false,
	);
});

test("platforms-gating wants platforms: when a POSIX-only primitive is used", () => {
	const body = "## When to Use\nRun `osascript` to script the app.\n";
	const ungated = lintSkill(skill({ body }));
	const rule = ungated.find((f) => f.rule === "platforms-gating");
	assert.ok(rule);
	assert.equal(rule.severity, "warning");
	assert.match(rule.message, /osascript/);
	const gated = lintSkill(skill({ body, frontmatter: { platforms: "darwin" } }));
	assert.equal(gated.some((f) => f.rule === "platforms-gating"), false);
});

test("forbidden-file reports each stray file the probe finds", () => {
	const carried = [".env", "README.md"];
	const findings = lintSkill(skill({ dirExists: (rel) => carried.includes(rel) }));
	const rules = findings.filter((f) => f.rule === "forbidden-file");
	assert.equal(rules.length, 2);
	assert.ok(rules.every((f) => f.severity === "warning"));
	assert.ok(rules.some((f) => f.message.includes("README.md")));
	assert.equal(lintSkill(skill()).some((f) => f.rule === "forbidden-file"), false);
});

test("references-sprawl warns above 60 non-underscore reference files", () => {
	const refs = (count: number, prefix = "r") =>
		"## When to Use\n" + Array.from({ length: count }, (_, i) => `- \`references/${prefix}${i}.md\``).join("\n") + "\n";
	assert.equal(lintSkill(skill({ body: refs(60) })).some((f) => f.rule === "references-sprawl"), false);
	const findings = lintSkill(skill({ body: refs(61) }));
	const rule = findings.find((f) => f.rule === "references-sprawl");
	assert.ok(rule);
	assert.equal(rule.severity, "warning");
	// An underscore prefix marks a private reference and does not count.
	assert.equal(lintSkill(skill({ body: refs(61, "_") })).some((f) => f.rule === "references-sprawl"), false);
});

test("shell-utility-reference names the DSH tool, not hermes'", () => {
	const findings = lintSkill(skill({ body: "先 `cat` 文件再用 `sed` 改。\n\n## When to Use\nx\n" }));
	const rule = findings.find((f) => f.rule === "shell-utility-reference");
	assert.ok(rule);
	assert.match(rule.message, /`read`/);
	assert.match(rule.message, /`edit`/);
	assert.doesNotMatch(rule.message, /read_file|patch/);
});

test("missing-metadata wants visibility, version, author and license", () => {
	const bare = { visibility: undefined, version: undefined, author: undefined, license: undefined };
	const findings = lintSkill(skill({ frontmatter: bare }));
	const rule = findings.find((f) => f.rule === "missing-metadata");
	assert.ok(rule);
	assert.equal(rule.severity, "warning");
	assert.match(rule.message, /visibility/);
	assert.match(rule.message, /license/);
	assert.equal(lintSkill(skill()).some((f) => f.rule === "missing-metadata"), false);
});

test("every finding is advisory and the caller is told so", () => {
	const findings = lintSkill(skill({ body: "no headings at all" }));
	assert.ok(findings.length > 0);
	assert.ok(findings.every((f) => f.severity === "error" || f.severity === "warning"));
	// 这条断言的存在就是"不阻断"的契约：linter 只返回发现，没有任何 throw 路径。
	assert.doesNotThrow(() => lintSkill(skill({ body: "" })));
});

test("lintSkill is total: malformed input still returns findings instead of throwing", () => {
	assert.doesNotThrow(() => lintSkill({ content: "---\nname: x\n", skillDir: "", skillName: "", frontmatter: {} }));
	assert.doesNotThrow(() => lintSkill(skill({ dirExists: () => { throw new Error("probe exploded"); } })));
});
