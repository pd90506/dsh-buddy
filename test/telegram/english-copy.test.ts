/**
 * The bot speaks English. Comments may be in any language; code may not carry a
 * CJK character, because every string literal in `src/telegram` can reach a chat.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../src/telegram", import.meta.url));
const CJK = /[　-鿿＀-￯]/;

function sources(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) return sources(path);
		return path.endsWith(".ts") ? [path] : [];
	});
}

test("no CJK character survives outside comments in the telegram row", () => {
	const offenders: string[] = [];
	for (const file of sources(ROOT)) {
		const code = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
		code.split("\n").forEach((line, index) => {
			if (CJK.test(line)) offenders.push(`${file}:${String(index + 1)}: ${line.trim()}`);
		});
	}
	assert.deepEqual(offenders, []);
});
