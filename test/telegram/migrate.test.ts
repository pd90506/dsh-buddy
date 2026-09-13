import assert from "node:assert/strict";
import { test } from "node:test";
import { migrateLegacySettings, type MigrationSettings } from "../../src/telegram/migrate.ts";

function settings(descriptors: { ns: string; user?: unknown }[]): MigrationSettings & { writes: { ns: string; patch: unknown }[] } {
	const writes: { ns: string; patch: unknown }[] = [];
	return {
		writes,
		describe: () => descriptors,
		update: async (ns, patch) => {
			writes.push({ ns, patch });
		},
	};
}

test("user-set legacy fields are copied and the switch is written off", async () => {
	const plane = settings([
		{ ns: "telegram", user: { enabled: true, ownerUserId: "1000000000", defaultCwd: "~/dsh-telegram", junk: 1 } },
		{ ns: "buddy-telegram" },
	]);
	assert.equal(await migrateLegacySettings(plane, "buddy-telegram"), "migrated");
	assert.deepEqual(plane.writes, [
		{ ns: "buddy-telegram", patch: { enabled: false, ownerUserId: "1000000000", defaultCwd: "~/dsh-telegram" } },
	]);
});

test("an existing buddy-telegram section is never overwritten", async () => {
	const plane = settings([
		{ ns: "telegram", user: { ownerUserId: "1" } },
		{ ns: "buddy-telegram", user: { ownerUserId: "2" } },
	]);
	assert.equal(await migrateLegacySettings(plane, "buddy-telegram"), "present");
	assert.deepEqual(plane.writes, []);
});

test("nothing is written when the legacy section is absent or only defaulted", async () => {
	for (const descriptors of [[{ ns: "buddy-telegram" }], [{ ns: "telegram" }, { ns: "buddy-telegram" }]]) {
		const plane = settings(descriptors);
		assert.equal(await migrateLegacySettings(plane, "buddy-telegram"), "no-legacy");
		assert.deepEqual(plane.writes, []);
	}
});

test("the legacy section is only read", async () => {
	const legacy = { ownerUserId: "1", renderMarkdown: false, mediaDelivery: "presented", permissionPreset: "read-only" };
	const plane = settings([{ ns: "telegram", user: legacy }, { ns: "buddy-telegram" }]);
	await migrateLegacySettings(plane, "buddy-telegram");
	assert.ok(plane.writes.every((write) => write.ns !== "telegram"));
	assert.deepEqual(plane.writes[0]?.patch, { enabled: false, ...legacy });
});
