/**
 * Task 11: the cheap-model review digest and the review prompt literals.
 *
 * Both modules are pure, so this file has no filesystem, no temp directory and
 * no clock: `digestHistory` is a total function over an owned message shape and
 * `prompt.ts` is string literals only.
 *
 * The digest numbers are load-bearing and come from spec §7.1 (which copies
 * `$H:agent/background_review.py:264-294`): tail 24, user truncation 300,
 * assistant truncation 200, tool results dropped, older turns collapsed into
 * exactly ONE synthetic `user` message whose text starts with
 * `[Earlier conversation digest`. The truncation assertions below are exact
 * (300 present, 301 absent) because a friendlier length is a silent behaviour
 * change: the digest is what bounds the aux model's cold-write cost.
 *
 * The one place this port deliberately diverges from the reference is the
 * message shape: the reference reads `tool_calls[].function.name` off a raw
 * transcript dict, while {@link DigestMessage} carries an already-extracted
 * `toolNames` array, so no live harness object is ever serialized.
 *
 * The prompt literals are pinned **twice**: by the semantic assertions at the
 * bottom, and by a sha256 of the exact string. The hash exists so that editing a
 * model-facing prompt is a deliberate act; when it fails, read the diff of the
 * literal and decide whether the change is wanted before updating the hash.
 * @module test/skills-digest
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ASSISTANT_CHARS, digestHistory, TAIL, USER_CHARS, type DigestMessage } from "../src/skills/digest.ts";
import { REFINE_FOCUS_SUFFIX, REVIEW_TOOL_CLAUSE, SKILL_REVIEW_PROMPT } from "../src/skills/prompt.ts";

/** Build a message without ever setting `toolNames` to `undefined` (`exactOptionalPropertyTypes`). */
function message(role: DigestMessage["role"], text: string, toolNames?: readonly string[]): DigestMessage {
	return toolNames === undefined ? { role, text } : { role, text, toolNames };
}

/** The content hash a prompt pin compares against. */
function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

test("the digest constants are the reference implementation's numbers", () => {
	assert.equal(TAIL, 24);
	assert.equal(USER_CHARS, 300);
	assert.equal(ASSISTANT_CHARS, 200);
});

test("a short history is returned unchanged", () => {
	const short = Array.from({ length: 24 }, (_, i) => message("user", `m${i}`));
	assert.deepEqual(digestHistory(short), short);
});

test("a history at exactly the tail length is returned unchanged", () => {
	const exact = Array.from({ length: 24 }, (_, i) => message(i % 2 === 0 ? "user" : "assistant", `m${i}`));
	assert.deepEqual(digestHistory(exact), exact);
});

test("an empty history is returned unchanged rather than throwing", () => {
	assert.deepEqual(digestHistory([]), []);
});

test("the kept tail never starts on a tool result", () => {
	const messages = [
		...Array.from({ length: 35 }, (_, i) => message("user", `old${i}`)),
		message("tool", "result"),
		message("assistant", "answer", ["read"]),
	];
	const out = digestHistory(messages);
	assert.notEqual(out[1]!.role, "tool"); // out[0] is the synthetic digest
});

test("a tool result on the tail boundary expands the kept run", () => {
	// Index 6 is exactly `length - tail`, so the naive 24-message tail would
	// start on a tool result; the kept run must grow to 25 and start at index 5.
	const messages = [
		...Array.from({ length: 6 }, (_, i) => message("user", `old${i}`)),
		message("tool", "result"),
		...Array.from({ length: 23 }, (_, i) => message("assistant", `recent${i}`)),
	];
	const out = digestHistory(messages);
	assert.equal(messages.length, 30);
	assert.equal(out.length, 26);
	assert.equal(out[0]!.role, "user");
	assert.match(out[0]!.text, /^\[Earlier conversation digest/);
	assert.notEqual(out[1]!.role, "tool");
	assert.deepEqual(out[1], messages[5]);
	assert.deepEqual(out[25], messages[29]);
});

test("a tool result that would consume the whole history returns it unchanged", () => {
	// Every position reachable by growing the tail is a tool result, so the loop
	// runs out of room and the input comes back as-is (the reference's `else`).
	const messages = [message("user", "old"), ...Array.from({ length: 24 }, () => message("tool", "result"))];
	assert.deepEqual(digestHistory(messages), messages);
});

test("older turns collapse into ONE synthetic user message with the exact truncations", () => {
	const longUser = "u".repeat(400);
	const messages = [
		...Array.from({ length: 30 }, (_, i) => message("user", `${longUser}${i}`)),
		...Array.from({ length: 24 }, () => message("assistant", "recent")),
	];
	const out = digestHistory(messages);
	assert.equal(out.length, 25);
	assert.equal(out[0]!.role, "user");
	assert.match(out[0]!.text, /^\[Earlier conversation digest/);
	assert.ok(out[0]!.text.includes(`USER: ${"u".repeat(300)}`));
	assert.ok(!out[0]!.text.includes("u".repeat(301)));
});

test("tool results are dropped from the digest", () => {
	const messages = [
		...Array.from({ length: 30 }, (_, i) => message("tool", `dropped${i}`)),
		...Array.from({ length: 24 }, () => message("assistant", "recent")),
	];
	assert.ok(!digestHistory(messages)[0]!.text.includes("dropped"));
});

test("an assistant turn lists its tool names and truncates its text at 200", () => {
	const longAssistant = "a".repeat(400);
	const messages = [
		message("user", "hello"),
		message("assistant", longAssistant, ["read", "grep"]),
		...Array.from({ length: 24 }, (_, i) => message("user", `tail${i}`)),
	];
	assert.equal(messages.length, 26); // two past the tail, so index 1 is earlier
	const digest = digestHistory(messages)[0]!.text;
	assert.ok(digest.includes("ASSISTANT[tools: read, grep]"));
	assert.ok(digest.includes(`ASSISTANT: ${"a".repeat(200)}`));
	assert.ok(!digest.includes("a".repeat(201)));
});

test("an assistant turn with no tool names and no text contributes nothing", () => {
	const messages = [
		message("assistant", ""),
		...Array.from({ length: 24 }, (_, i) => message("user", `tail${i}`)),
	];
	assert.equal(messages.length, 25);
	const digest = digestHistory(messages)[0]!.text;
	assert.ok(!digest.includes("ASSISTANT"));
});

test("empty user text contributes no USER line", () => {
	const messages = [message("user", ""), ...Array.from({ length: 24 }, (_, i) => message("user", `tail${i}`))];
	assert.equal(messages.length, 25);
	assert.ok(!digestHistory(messages)[0]!.text.includes("USER:"));
});

test("newlines inside a summarized turn become spaces", () => {
	const messages = [
		message("user", "line one\nline two"),
		message("assistant", "para one\n\npara two"),
		...Array.from({ length: 24 }, (_, i) => message("user", `tail${i}`)),
	];
	assert.equal(messages.length, 26);
	const digest = digestHistory(messages)[0]!.text;
	assert.ok(digest.includes("USER: line one line two"));
	assert.ok(digest.includes("ASSISTANT: para one  para two"));
	assert.ok(!digest.includes("line one\nline two"));
	assert.ok(!digest.includes("para one\n\npara two"));
});

test("the digest is one synthetic message followed by the verbatim tail", () => {
	const messages = Array.from({ length: 30 }, (_, i) =>
		i % 3 === 0 ? message("user", `u${i}`) : i % 3 === 1 ? message("assistant", `a${i}`) : message("tool", `t${i}`),
	);
	const out = digestHistory(messages);
	assert.equal(out.length, 25);
	for (let i = 0; i < 24; i += 1) {
		assert.deepEqual(out[i + 1], messages[6 + i]);
	}
});

test("the kept tail is copied, never re-processed by the digest rules", () => {
	// A long tail turn with a newline: if the tail were run through the digest's
	// flatten/truncate rules it would lose the newline or the 400th character.
	const longTail = `keep this verbatim\n${"x".repeat(400)}`;
	const messages = [
		...Array.from({ length: 6 }, (_, i) => message("user", `old${i}`)),
		message("user", longTail),
		...Array.from({ length: 23 }, (_, i) => message("assistant", `recent${i}`)),
	];
	assert.equal(messages.length, 30);
	const out = digestHistory(messages);
	assert.equal(out.length, 25);
	assert.equal(out[1], messages[6]); // same object, not a rebuilt message
	assert.ok(out[1]!.text.startsWith("keep this verbatim\n"));
	assert.ok(out[1]!.text.includes("\n"));
	assert.ok(out[1]!.text.includes("x".repeat(400)));
	assert.ok(!out[0]!.text.includes("keep this verbatim"));
});

test("the tool clause is the exact mandated sentence", () => {
	assert.equal(
		REVIEW_TOOL_CLAUSE,
		"\n\nYou can only call skill management tools. Other tools will be denied at runtime — do not attempt them.",
	);
});

test("the refine focus suffix interpolates the focus verbatim", () => {
	assert.equal(
		REFINE_FOCUS_SUFFIX("tighten the review loop"),
		"\n\nThe user explicitly requested this review with the following focus — prioritize it over the general instructions above:\ntighten the review loop",
	);
	assert.ok(REFINE_FOCUS_SUFFIX("x").endsWith("\nx"));
});

test("the skill review prompt carries the three semantic blocks", () => {
	assert.match(SKILL_REVIEW_PROMPT, /Preference order/);
	assert.match(SKILL_REVIEW_PROMPT, /CLASS-LEVEL/);
	assert.match(SKILL_REVIEW_PROMPT, /Read-before-write/);
	assert.match(SKILL_REVIEW_PROMPT, /Protected skills/);
	assert.match(SKILL_REVIEW_PROMPT, /Nothing to save\./);
	assert.match(SKILL_REVIEW_PROMPT, /curator-managed/);
	assert.match(SKILL_REVIEW_PROMPT, /references\//);
});

test("the review prompt speaks DSH's vocabulary, not the reference implementation's", () => {
	assert.doesNotMatch(SKILL_REVIEW_PROMPT, /skill_view|skills_list/);
	assert.doesNotMatch(SKILL_REVIEW_PROMPT, /[Hh]ermes/);
	assert.match(SKILL_REVIEW_PROMPT, /skill_manage/);
});

/**
 * Content-hash pins for the model-facing literals.
 *
 * These hashes exist so that editing a model-facing prompt is a deliberate act:
 * a silent one-character change to 4KB of instructions is invisible by
 * construction, and the reference snapshot these were ported from lives in
 * `/tmp`, which is ephemeral. **If one of these fails, read the diff of the
 * literal and decide whether the change is wanted — then update the hash. Do not
 * update it reflexively.**
 */
test("the prompt literals are pinned by content hash", () => {
	assert.equal(sha256(SKILL_REVIEW_PROMPT), "4ccd432de844470b63df4d08bd052371d19b65d2de849d8a7d84dc990e7dc314");
	assert.equal(sha256(REVIEW_TOOL_CLAUSE), "1e9af5d5104bc896545dc51acbfb6e185dd8961a89ab2409c0de67ffbfc709c8");
	assert.equal(
		sha256(REFINE_FOCUS_SUFFIX("tighten the review loop")),
		"e2f80572b6abdea67124381475a7aeaaccf5e85f52e4a394d2fb4c78b646bc79",
	);
});
