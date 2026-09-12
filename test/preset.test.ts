/**
 * A regression guard for the exact defect a prior fix corrected: a second
 * `@deepseek-ai/dsh-persona` row in the frozen `buddy` preset template.
 * `@deepseek-ai/dsh-persona` always registers under the fixed section names
 * `PERSONA_PREFIX_SECTION`/`PERSONA_SUFFIX_SECTION`, and every un-isolated row
 * in one preset's standing mount shares one scope — so a second such row
 * throws `prompt section "…" is already registered in this scope` at mount,
 * not at authoring time. The composition's own comment says "the agent will
 * eventually edit this file itself," so this is anticipated drift, not a
 * hypothetical.
 *
 * This repo declares no YAML parser (`package.json` has none, direct or
 * transitive), and a committed test must never reach into the machine-local
 * dsh install that supplied one for manual validation — that path is
 * machine-specific and the test would be unrunnable anywhere else. So this
 * reads the frozen template as text.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PRESET_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "preset", "agent.cordis.yml");

/** One row's extracted `config:` map, as raw single-quoted-scalar text (quotes stripped). */
type RowConfig = Record<string, string>;

/**
 * Extract every top-level `@deepseek-ai/dsh-persona` row's `config` from the
 * composition text, WITHOUT a YAML parser.
 *
 * This is not a YAML parser and does not try to be one: it recognises
 * exactly one row shape — a zero-indent `- id: <id>` line opening a row, an
 * exactly-matching two-space `name: '@deepseek-ai/dsh-persona'` line, and
 * (optionally) a two-space `config:` line followed by four-space
 * `key: 'value'` lines with single-quoted scalars.
 *
 * Fail-closed by construction: every regex here is anchored to one exact
 * literal shape and none has a fallback branch that accepts "close enough".
 * A row this function does not recognise — double quotes instead of single,
 * a flow mapping (`{ name: ..., config: ... }`), a reworded key, reflowed
 * indentation — is simply invisible to it: it contributes nothing to the
 * returned array, or contributes a config missing the key it could not
 * match. It is the caller's assertions (an exact count, an exact config
 * shape) that turn that invisibility into a loud test failure — this
 * function itself never decides "close enough, call it a match".
 */
function personaRowConfigs(source: string): RowConfig[] {
	const lines = source.split("\n");
	const rowStarts: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (/^- id: \S+\s*$/.test(lines[i] ?? "")) rowStarts.push(i);
	}
	const configs: RowConfig[] = [];
	for (let r = 0; r < rowStarts.length; r++) {
		const start = rowStarts[r] ?? 0;
		const end = r + 1 < rowStarts.length ? (rowStarts[r + 1] ?? lines.length) : lines.length;
		const block = lines.slice(start, end);
		const isPersonaRow = block.some((line) => line === "  name: '@deepseek-ai/dsh-persona'");
		if (!isPersonaRow) continue;
		const config: RowConfig = {};
		const configIndex = block.findIndex((line) => line === "  config:");
		if (configIndex !== -1) {
			for (let i = configIndex + 1; i < block.length; i++) {
				const line = block[i] ?? "";
				if (line === "") continue;
				const match = /^ {4}([A-Za-z][A-Za-z0-9]*): '([^']*)'$/.exec(line);
				if (match === null) break; // dedent, or a shape this function refuses to interpret: stop, do not guess.
				const key = match[1] ?? "";
				const value = match[2] ?? "";
				config[key] = value;
			}
		}
		configs.push(config);
	}
	return configs;
}

/** The persona package's own npm name. Cannot appear in the composition's YAML content except as a `name:` value — the one place it appears in this file's prose (the "identity" section's comment) is excluded before counting, below. */
const PERSONA_PACKAGE_NAME = "@deepseek-ai/dsh-persona";

/**
 * Count occurrences of {@link PERSONA_PACKAGE_NAME} in the file's non-comment
 * lines, by plain substring search — format-agnostic on purpose, unlike
 * {@link personaRowConfigs}'s exact-shape row matching.
 *
 * This exists to close the gap that a purely structural extractor leaves
 * open: `personaRowConfigs` only ever recognises rows in the one shape it
 * parses, so a second persona row added in an unrecognised shape (double
 * quotes, a flow mapping, extra spacing) is invisible to it — it contributes
 * nothing to `personaRowConfigs`'s result, so a naive "exactly one row"
 * assertion against that result alone stays green while the file actually
 * carries two rows the real loader will both mount. A plain, format-blind
 * substring count cannot be fooled by a quoting or spacing change the same
 * way, because it does not parse structure at all — it only requires that
 * the exact package name string is present. Comparing the two counts is what
 * catches "recognised-shape count disagrees with raw-text count", which is
 * exactly the signature of an unrecognised-but-present row.
 *
 * Comment lines are excluded (a line whose trimmed content starts with `#`)
 * because this composition's own "identity" section comment names
 * `@deepseek-ai/dsh-persona` in prose — counting that occurrence would make
 * even the correct, single-row file disagree with the structured count.
 * Excluding comments does not reopen the gap this function exists to close:
 * a name mentioned only in a comment registers no row with the real loader
 * either, so correctly not counting it costs nothing.
 */
function personaPackageNameOccurrences(source: string): number {
	const codeOnly = source
		.split("\n")
		.filter((line) => !line.trim().startsWith("#"))
		.join("\n");
	return codeOnly.split(PERSONA_PACKAGE_NAME).length - 1;
}

test("the frozen buddy preset carries exactly one dsh-persona row, prefix-only and referencing buddySoul", () => {
	const source = readFileSync(PRESET_PATH, "utf8");
	const personaRows = personaRowConfigs(source);
	const rawOccurrences = personaPackageNameOccurrences(source);
	assert.equal(
		rawOccurrences,
		personaRows.length,
		`found ${String(rawOccurrences)} occurrence(s) of "${PERSONA_PACKAGE_NAME}" outside comments, but the structured extractor recognised only ${String(personaRows.length)} row(s) — a persona row exists in a shape the extractor cannot parse`,
	);
	assert.equal(personaRows.length, 1, `expected exactly one @deepseek-ai/dsh-persona row, found ${String(personaRows.length)}`);
	assert.deepEqual(personaRows[0], { prefix: "{{buddySoul}}" });
});
