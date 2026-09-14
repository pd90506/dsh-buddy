import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ALLOWED_SUBDIRS,
	MAX_SKILL_FILE_BYTES,
	parseFrontmatter,
	validateSkillDocument,
	validateSkillName,
	validateSupportBytes,
	validateSupportPath,
} from "../src/skills/validate.ts";

test("the DSH skill-name grammar is enforced, not hermes' looser one", () => {
	assert.equal(validateSkillName("pdf-merge"), undefined);
	assert.match(String(validateSkillName("pdf_merge")), /lowercase letters, digits and hyphens/);
	assert.match(String(validateSkillName("pdf.merge")), /lowercase letters/);
	assert.match(String(validateSkillName("")), /required/);
});

test("frontmatter must be a closed YAML mapping with name and description", () => {
	const missing = validateSkillDocument({ name: "a-b", content: "# no fence\n", creating: true });
	assert.equal(missing.ok, false);
	const noDesc = validateSkillDocument({
		name: "a-b",
		content: "---\nname: a-b\n---\nbody\n",
		creating: true,
	});
	assert.equal(noDesc.ok, false);
	if (!noDesc.ok) assert.match(noDesc.error, /description/);
});

test("create caps the description at 60 chars, later writes at 1024", () => {
	const long = "x".repeat(80);
	const content = `---\nname: a-b\ndescription: ${long}\n---\nbody\n`;
	assert.equal(validateSkillDocument({ name: "a-b", content, creating: true }).ok, false);
	assert.equal(validateSkillDocument({ name: "a-b", content, creating: false }).ok, true);
});

test("a support file must live under an allowed subdir and fit the byte cap", () => {
	assert.equal(validateSupportPath("references/a.md"), undefined);
	assert.match(String(validateSupportPath("notes/a.md")), /references/);
	assert.match(String(validateSupportBytes("references/a.md", MAX_SKILL_FILE_BYTES + 1)), /1048576/);
});

test("an accepted document returns the body without the frontmatter fence", () => {
	const result = validateSkillDocument({
		name: "pdf-merge",
		content: '---\nname: pdf-merge\ndescription: "merge PDFs"\n---\n\n## When to Use\nwhen merging\n',
		creating: true,
	});
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.frontmatter["description"], "merge PDFs");
	assert.equal(result.body, "\n## When to Use\nwhen merging\n");
});

test("frontmatter name must equal the directory name", () => {
	const result = validateSkillDocument({
		name: "a-b",
		content: "---\nname: other\ndescription: x\n---\nbody\n",
		creating: true,
	});
	assert.equal(result.ok, false);
	if (!result.ok) assert.match(result.error, /does not match directory/);
});

test("an empty body is refused", () => {
	const result = validateSkillDocument({
		name: "a-b",
		content: "---\nname: a-b\ndescription: x\n---\n\n\n",
		creating: true,
	});
	assert.equal(result.ok, false);
	if (!result.ok) assert.match(result.error, /body is empty/);
});

test("frontmatter carries inline and block lists, comments and quoted scalars", () => {
	const parsed = parseFrontmatter(
		[
			"---",
			"# a comment",
			"",
			"name: 'a-b'",
			'description: "quoted: value"',
			"platforms: [linux, macos]",
			"tags:",
			"  - one",
			"  - two",
			"---",
			"body",
		].join("\n"),
	);
	assert.ok(!("error" in parsed));
	if ("error" in parsed) return;
	assert.equal(parsed.frontmatter["name"], "a-b");
	assert.equal(parsed.frontmatter["description"], "quoted: value");
	assert.deepEqual(parsed.frontmatter["platforms"], ["linux", "macos"]);
	assert.deepEqual(parsed.frontmatter["tags"], ["one", "two"]);
	assert.equal(parsed.body, "body");
});

test("parseFrontmatter reports a missing or unclosed fence instead of throwing", () => {
	const missing = parseFrontmatter("# not frontmatter\n");
	assert.ok("error" in missing);
	const unclosed = parseFrontmatter("---\nname: a-b\n");
	assert.ok("error" in unclosed);
});

test("parseFrontmatter refuses a non-mapping frontmatter", () => {
	const parsed = parseFrontmatter("---\n- one\n- two\n---\nbody\n");
	assert.ok("error" in parsed);
	if ("error" in parsed) assert.match(parsed.error, /key: value/);
});

test("parseFrontmatter never throws for hostile input", () => {
	const inputs = ["", "---", "---\n---", "---\n:\n---\n", "---\nkey\n---\n", "\uFEFF---\nname: a-b\n---\nb\n"];
	for (const input of inputs) {
		assert.doesNotThrow(() => parseFrontmatter(input));
	}
});

test("a support path outside the allowed subdirs, or one that escapes, is refused", () => {
	assert.equal(validateSupportPath("templates/report.md"), undefined);
	assert.equal(validateSupportPath("scripts/run.sh"), undefined);
	assert.equal(validateSupportPath("references/nested/deep.md"), undefined);
	assert.match(String(validateSupportPath("references/../SKILL.md")), /\.\./);
	assert.match(String(validateSupportPath("/etc/passwd")), /relative/);
	assert.match(String(validateSupportPath("references")), /file/);
	assert.deepEqual([...ALLOWED_SUBDIRS], ["references", "templates", "scripts", "assets"]);
});

test("the byte cap accepts the limit itself and refuses anything above it", () => {
	assert.equal(validateSupportBytes("references/a.md", MAX_SKILL_FILE_BYTES), undefined);
	assert.equal(validateSupportBytes("references/a.md", 0), undefined);
	assert.match(String(validateSupportBytes("references/a.md", -1)), /non-negative/);
	assert.match(String(validateSupportBytes("references/a.md", Number.NaN)), /finite/);
	assert.match(String(validateSupportBytes("references/a.md", MAX_SKILL_FILE_BYTES + 1)), /1048576/);
});
