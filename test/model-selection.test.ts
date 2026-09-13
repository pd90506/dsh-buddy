import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveModelSelection, selectionFromDefault } from "../src/model-selection.ts";

const chat = { provider: "chat-p", model: "chat-m" };
const buddy = { provider: "buddy-p", model: "buddy-m", reasoningEffort: "high" };
const global = { provider: "global-p", model: "global-m" };

test("a chat-local choice wins over everything", () => {
	assert.deepEqual(resolveModelSelection(chat, buddy, global), chat);
});

test("the buddy default wins over the global default", () => {
	assert.deepEqual(resolveModelSelection(undefined, buddy, global), buddy);
});

test("the global default applies when nothing else is set", () => {
	assert.deepEqual(resolveModelSelection(undefined, undefined, global), global);
	assert.equal(resolveModelSelection(undefined, undefined, undefined), undefined);
});

test("an incomplete buddy default is no default", () => {
	assert.equal(selectionFromDefault({ provider: "", model: "", reasoningEffort: "" }), undefined);
	assert.equal(selectionFromDefault({ provider: "p", model: "", reasoningEffort: "high" }), undefined);
	assert.equal(selectionFromDefault({ provider: "", model: "m", reasoningEffort: "" }), undefined);
});

test("an empty reasoning effort is omitted, not sent as an empty string", () => {
	assert.deepEqual(selectionFromDefault({ provider: "p", model: "m", reasoningEffort: "" }), { provider: "p", model: "m" });
	assert.deepEqual(selectionFromDefault({ provider: "p", model: "m", reasoningEffort: "low" }), {
		provider: "p",
		model: "m",
		reasoningEffort: "low",
	});
});
