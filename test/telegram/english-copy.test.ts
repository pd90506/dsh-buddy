/**
 * The bot speaks English. Comments may be in any language; code may not carry a
 * CJK character, because every string literal in `src/telegram` can reach a chat.
 *
 * CJK-bearing tokens are found with the real TypeScript parser rather than a
 * regex strip of `//` and `/* *\/` comments: a regex strip truncates a line at
 * a `//` that occurs inside a string or URL (e.g. `https://…`), silently
 * hiding anything after it on that line. The parser also gets template
 * literals (including nested ones) and regex literals right, which a
 * hand-rolled scanner loop cannot do without reproducing a chunk of the
 * TypeScript scanner's own division/regex disambiguation.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

const ROOT = fileURLToPath(new URL("../../src/telegram", import.meta.url));
const CJK = /[　-鿿＀-￯]/;

function sources(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) return sources(path);
		return path.endsWith(".ts") ? [path] : [];
	});
}

/** One leaf token whose own text (comments and whitespace excluded) carries a CJK character. */
interface CjkToken {
	readonly text: string;
	readonly line: number;
}

/**
 * Parse `code` as TypeScript and return every leaf token (identifiers, string
 * literals, template-literal parts, regex literals, keywords, punctuation…)
 * whose text contains a CJK character. Comments are trivia in the TypeScript
 * AST — they never become part of any node's span — so they are excluded
 * without any separate stripping step, and correctly, however a `//` or `/*`
 * is embedded inside a string or template literal elsewhere in the file.
 */
function cjkTokens(code: string): CjkToken[] {
	const sourceFile = ts.createSourceFile("scan.ts", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const offenders: CjkToken[] = [];
	const visit = (node: ts.Node): void => {
		let hasChild = false;
		ts.forEachChild(node, (child) => {
			hasChild = true;
			visit(child);
		});
		if (hasChild) return;
		const start = node.getStart(sourceFile);
		const text = code.slice(start, node.getEnd());
		if (CJK.test(text)) offenders.push({ text, line: sourceFile.getLineAndCharacterOfPosition(start).line + 1 });
	};
	visit(sourceFile);
	return offenders;
}

test("no CJK character survives outside comments in the telegram row", () => {
	const offenders: string[] = [];
	for (const file of sources(ROOT)) {
		const code = readFileSync(file, "utf8");
		const lines = code.split("\n");
		const offendingLines = [...new Set(cjkTokens(code).map((token) => token.line))].sort((a, b) => a - b);
		for (const line of offendingLines) offenders.push(`${file}:${String(line)}: ${(lines[line - 1] ?? "").trim()}`);
	}
	assert.deepEqual(offenders, []);
});

test("a CJK literal after a // inside an earlier string is not hidden (regex-strip bypass)", () => {
	// A `.replace(/\/\/[^\n]*/g, "")` comment-strip would truncate this line at the
	// `//` inside the URL, hiding the CJK literal that follows on the same line.
	const offenders = cjkTokens('const u = "https://x.test/" + "中文";');
	assert.equal(offenders.length, 1);
	assert.match(offenders[0]?.text ?? "", /中文/);
});

test("CJK confined to a comment is not reported", () => {
	const offenders = cjkTokens("// 中文 only in a comment\nconst z = 1;");
	assert.deepEqual(offenders, []);
});
