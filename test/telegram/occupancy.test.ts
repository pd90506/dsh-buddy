import assert from "node:assert/strict";
import { test } from "node:test";
import { legacyBotActive } from "../../src/telegram/occupancy.ts";

function world(options: { rows: { name: string; disabled: boolean }[] | undefined; legacyEnabled: unknown }): (name: string) => unknown {
	return (name) => {
		if (name === "loader") {
			return options.rows === undefined
				? undefined
				: { entries: () => options.rows!.map((row) => ({ options: { name: row.name }, disabled: row.disabled })) };
		}
		if (name === "settings") return { get: (ns: string) => (ns === "telegram" ? { enabled: options.legacyEnabled } : undefined) };
		return undefined;
	};
}

test("a mounted, enabled dsh-telegram occupies the bot", () => {
	assert.equal(legacyBotActive(world({ rows: [{ name: "dsh-telegram", disabled: false }], legacyEnabled: true })), true);
});

test("a disabled row, a switched-off legacy bot, or no row at all does not", () => {
	assert.equal(legacyBotActive(world({ rows: [{ name: "dsh-telegram", disabled: true }], legacyEnabled: true })), false);
	assert.equal(legacyBotActive(world({ rows: [{ name: "dsh-telegram", disabled: false }], legacyEnabled: false })), false);
	assert.equal(legacyBotActive(world({ rows: [{ name: "dsh-buddy/telegram", disabled: false }], legacyEnabled: true })), false);
});

test("without a loader service nothing is assumed to occupy the bot", () => {
	assert.equal(legacyBotActive(world({ rows: undefined, legacyEnabled: true })), false);
});
