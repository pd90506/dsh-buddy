/**
 * Command parsing: Telegram appends `@botname` to commands in groups, and an
 * unrecognized token must not be mistaken for one.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { MODEL_CALLBACK, parseModelCallback } from "../../src/telegram/model.ts";
import { COMMANDS, parseCommand } from "../../src/telegram/runtime.ts";

test("a bare command parses with no arguments", () => {
	assert.deepEqual(parseCommand("/start"), { name: "start", args: "" });
});

test("the @botname suffix is stripped", () => {
	assert.deepEqual(parseCommand("/help@my_bot"), { name: "help", args: "" });
});

test("arguments survive, including spaces", () => {
	assert.deepEqual(parseCommand("/model deepseek-chat extra"), { name: "model", args: "deepseek-chat extra" });
});

test("surrounding whitespace is tolerated", () => {
	assert.deepEqual(parseCommand("  /stop  "), { name: "stop", args: "" });
});

test("ordinary text is not a command", () => {
	assert.equal(parseCommand("hello"), undefined);
	assert.equal(parseCommand("/"), undefined);
	assert.equal(parseCommand(""), undefined);
});

test("command names are lowercased and every published command parses", () => {
	assert.deepEqual(parseCommand("/HELP"), { name: "help", args: "" });
	for (const { command } of COMMANDS) {
		assert.deepEqual(parseCommand(`/${command}`), { name: command, args: "" });
	}
});

test("the model menu's callback grammar round-trips", () => {
	assert.deepEqual(parseModelCallback(MODEL_CALLBACK.provider(3)), { kind: "provider", providerIndex: 3 });
	assert.deepEqual(parseModelCallback(MODEL_CALLBACK.model(1, 7)), { kind: "model", providerIndex: 1, modelIndex: 7 });
	assert.deepEqual(parseModelCallback(MODEL_CALLBACK.back), { kind: "back" });
});

test("foreign or malformed callback data is refused", () => {
	assert.equal(parseModelCallback("ap:y:abc"), undefined);
	assert.equal(parseModelCallback("md:p:notanumber"), undefined);
	assert.equal(parseModelCallback("md:m:1"), undefined);
	assert.equal(parseModelCallback("md"), undefined);
	assert.equal(parseModelCallback(""), undefined);
});
