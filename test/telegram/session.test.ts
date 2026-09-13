/**
 * Turn attribution: the reply sent to Telegram must be the turn that Telegram's
 * own message started — not whatever else the session produced meanwhile.
 *
 * This is the "GUI typed into the same session" case (acceptance criterion
 * AC-13), and it is why the fold keys on the turn that opened after the baseline
 * rather than on "everything since".
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { foldTurnOutput, foldTurnParts, messageText, type SessionEventLike } from "../../src/telegram/session.ts";

/** One log event, in the shape `snapshotEvents` returns. */
function event(seq: number, type: string, data: unknown): SessionEventLike {
	return { seq, type, data };
}

/** An assistant message event carrying a single text block. */
function assistant(seq: number, turn: number, text: string): SessionEventLike {
	return event(seq, "assistant/message", { turn, message: { content: [{ type: "text", text }] } });
}

test("messageText concatenates text blocks and ignores the rest", () => {
	assert.equal(
		messageText({ content: [{ type: "text", text: "a" }, { type: "tool-call", id: "x" }, { type: "text", text: "b" }] }),
		"ab",
	);
	assert.equal(messageText(undefined), "");
	assert.equal(messageText({}), "");
});

test("foldTurnOutput takes the first turn that opened at or after the baseline", () => {
	const events = [
		event(10, "turn/start", { turn: 7 }),
		assistant(11, 7, "the turn we started"),
		event(12, "turn/end", { turn: 7, reason: "completed" }),
		// A GUI message queued behind ours: a later turn, same session.
		event(13, "turn/start", { turn: 8 }),
		assistant(14, 8, "the GUI's answer"),
	];
	assert.equal(foldTurnOutput(events, 10), "the turn we started");
});

test("foldTurnOutput joins several assistant messages of the owned turn", () => {
	const events = [
		event(5, "turn/start", { turn: 3 }),
		assistant(6, 3, "first"),
		assistant(7, 3, "second"),
	];
	assert.equal(foldTurnOutput(events, 5), "first\n\nsecond");
});

test("foldTurnOutput ignores a turn that started before the baseline", () => {
	const events = [
		event(1, "turn/start", { turn: 1 }),
		assistant(2, 1, "earlier turn"),
		event(3, "turn/start", { turn: 2 }),
		assistant(4, 2, "our turn"),
	];
	assert.equal(foldTurnOutput(events, 3), "our turn");
});

test("foldTurnOutput falls back to the last non-empty message when the owned turn has no text", () => {
	const events = [
		event(4, "turn/start", { turn: 2 }),
		assistant(5, 2, "   "),
		assistant(6, 2, "actual words"),
	];
	assert.equal(foldTurnOutput(events, 4), "actual words");
});

test("foldTurnOutput returns empty text when there is nothing to send", () => {
	assert.equal(foldTurnOutput([], 0), "");
	assert.equal(foldTurnOutput([event(1, "turn/start", { turn: 1 })], 1), "");
});

/** A `present` tool result declaration. */
function presented(seq: number, turn: number, path: string, description?: string): SessionEventLike {
	return event(seq, "deliverables/presented", {
		turn,
		callId: `call-${String(seq)}`,
		files: [description === undefined ? { path } : { path, description }],
	});
}

/** A tool call, so the folder can name the tool behind a result. */
function toolCall(seq: number, turn: number, callId: string, name: string): SessionEventLike {
	return event(seq, "tool/call", { turn, step: 1, callId, name, arguments: "{}" });
}

/** A tool result carrying an image block (the shape the image tool emits). */
function toolImage(
	seq: number,
	turn: number,
	callId: string,
	image: { attachmentId: string; mediaType: string; bytes: number; width?: number; height?: number; name?: string },
): SessionEventLike {
	return event(seq, "tool/result", {
		turn,
		step: 1,
		message: {
			source: { kind: "tool", callId },
			role: "user",
			content: [
				{
					type: "tool-result",
					toolCallId: callId,
					content: [{ type: "text", text: "generated" }, { type: "image", attachment: image }],
					isError: false,
				},
			],
		},
	});
}

test("foldTurnParts keeps the reading order of text, delivered files and tool images", () => {
	const events = [
		event(10, "turn/start", { turn: 4 }),
		assistant(11, 4, "看图："),
		toolCall(12, 4, "call-1", "codex_image_generate"),
		toolImage(13, 4, "call-1", {
			attachmentId: "sha256:aa",
			mediaType: "image/png",
			bytes: 2048,
			width: 40,
			height: 20,
			name: "chart.png",
		}),
		presented(14, 4, "reports/summary.md", "本周汇总"),
		assistant(15, 4, "以上。"),
	];

	assert.deepEqual(foldTurnParts(events, 10), [
		{ kind: "text", text: "看图：" },
		{
			kind: "media",
			via: "tool",
			source: {
				kind: "attachment",
				attachment: {
					attachmentId: "sha256:aa",
					mediaType: "image/png",
					bytes: 2048,
					width: 40,
					height: 20,
					name: "chart.png",
				},
			},
			caption: "chart.png",
		},
		{ kind: "media", via: "presented", source: { kind: "path", path: "reports/summary.md" }, caption: "本周汇总" },
		{ kind: "text", text: "以上。" },
	]);
});

test("foldTurnParts never forwards an image the agent only looked at", () => {
	const events = [
		event(1, "turn/start", { turn: 1 }),
		toolCall(2, 1, "call-read", "read_image"),
		toolImage(3, 1, "call-read", { attachmentId: "sha256:read", mediaType: "image/png", bytes: 10 }),
		assistant(4, 1, "看过了"),
	];
	assert.deepEqual(foldTurnParts(events, 1), [{ kind: "text", text: "看过了" }]);
});

test("foldTurnParts ignores media and text belonging to another turn", () => {
	const events = [
		event(1, "turn/start", { turn: 1 }),
		assistant(2, 1, "ours"),
		event(3, "turn/start", { turn: 2 }),
		presented(4, 2, "other.md"),
		assistant(5, 2, "theirs"),
	];
	assert.deepEqual(foldTurnParts(events, 1), [{ kind: "text", text: "ours" }]);
});

test("foldTurnParts survives malformed events and empty declarations", () => {
	const events = [
		event(1, "turn/start", { turn: 1 }),
		event(2, "tool/result", { turn: 1, message: { content: [{ type: "image" }] } }),
		event(3, "deliverables/presented", { turn: 1, files: [{ path: "" }, { nope: true }] }),
		event(4, "tool/result", { turn: 1, message: null }),
		assistant(5, 1, "still here"),
	];
	assert.deepEqual(foldTurnParts(events, 1), [{ kind: "text", text: "still here" }]);
});

test("foldTurnParts does not duplicate a file that is both produced and presented", () => {
	// Deduplication belongs to the delivery budget (it knows the byte sizes), so
	// the folder reports both and the ledger decides — this pins the contract.
	const events = [
		event(1, "turn/start", { turn: 1 }),
		toolCall(2, 1, "call-1", "codex_image_generate"),
		toolImage(3, 1, "call-1", { attachmentId: "sha256:aa", mediaType: "image/png", bytes: 100 }),
		presented(4, 1, "/tmp/w/downloads/chart.png"),
	];
	const parts = foldTurnParts(events, 1);
	assert.equal(parts.length, 2);
	assert.deepEqual(
		parts.map((part) => part.kind),
		["media", "media"],
	);
});
