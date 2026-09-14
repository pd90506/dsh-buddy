/**
 * Task 5: content-addressed snapshots, the mutation ledger, and rollback.
 *
 * Two failure semantics are the whole point of this file, and they are opposite:
 * the **atomicity** snapshot gates a batch (no snapshot, no atomicity) while the
 * **audit** ledger is best effort (a capture failure must never block a write).
 * `rollbackEntry` is the single fail-closed operation, so it gets the most
 * coverage here: a missing blob, an escaping ledger row, and a pre-rollback
 * entry that cannot be written must all abort with nothing changed.
 *
 * Every filesystem test uses a real temp directory — the point is the real
 * `fs` behaviour, not a mock — and tears it down in `finally`.
 * @module test/skills-ledger
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { KvTable } from "@deepseek-ai/dsh-storage-domain";
import { captureBefore, listEntries, recordMutation, rollbackEntry, type LedgerDeps } from "../src/skills/ledger.ts";
import { atomicSnapshot, readBlob, snapshotPaths, storeBlob } from "../src/skills/snapshot.ts";
import type { SkillLedgerRecord } from "../src/store/domain.ts";
import { tableStub } from "./support/domain-tables.ts";

/** One file in a `before`/`after` manifest. */
type Manifest = { path: string; sha256: string }[];

/** A temp buddy home plus the ledger handles a test drives through it. */
interface Fixture {
	/** The temp buddy home root. */
	readonly home: string;
	/** `<home>/main/skills/.snapshots`. */
	readonly snapshotsDir: string;
	/** `<home>/main/skills/a-b`, the skill most tests mutate. */
	readonly skill: string;
	/** The dependencies under test. */
	readonly deps: LedgerDeps;
	/** Remove the temp home. */
	cleanup(): Promise<void>;
}

/**
 * Create one temp buddy home with an empty ledger.
 * @returns the fixture; the caller must `cleanup()` it in a `finally`.
 */
async function fixture(): Promise<Fixture> {
	const home = await mkdtemp(join(tmpdir(), "buddy-ledger-"));
	const snapshotsDir = join(home, "main", "skills", ".snapshots");
	const skill = join(home, "main", "skills", "a-b");
	await mkdir(skill, { recursive: true });
	return {
		home,
		snapshotsDir,
		skill,
		deps: { home, snapshotsDir, ledger: tableStub<SkillLedgerRecord>() },
		cleanup: () => rm(home, { recursive: true, force: true }),
	};
}

/** The fields a seeded ledger row may override. */
interface SeedInput {
	id: string;
	action: SkillLedgerRecord["action"];
	skill?: string | undefined;
	actor?: SkillLedgerRecord["actor"] | undefined;
	before?: Manifest | undefined;
	after?: Manifest | undefined;
	/** How far in the past the row's `ts` sits; larger means older. */
	ageMs?: number | undefined;
}

/**
 * Write one ledger row with a timestamp safely in the past, so a row written
 * during the test always sorts ahead of it.
 * @param deps - the fixture's dependencies.
 * @param input - the row, with sensible defaults for everything but the id.
 */
async function seed(deps: LedgerDeps, input: SeedInput): Promise<void> {
	const ts = new Date(Date.now() - (input.ageMs ?? 60_000)).toISOString();
	await deps.ledger.put(input.id, {
		id: input.id,
		ts,
		actor: input.actor ?? "curator",
		action: input.action,
		skill: input.skill ?? "a-b",
		evidence: {},
		before: input.before ?? [],
		after: input.after ?? [],
	});
}

/**
 * Wrap one table so further writes reject while its reads keep working.
 * @param table - the fixture's populated table.
 * @returns a table whose `put` always throws.
 */
function unwritable(table: KvTable<string, SkillLedgerRecord>): KvTable<string, SkillLedgerRecord> {
	return {
		...table,
		put: async () => {
			throw new Error("storage is read-only");
		},
	};
}

/**
 * A sha256 of the bytes a test just wrote, so a seeded hash can be real.
 * @param text - the file content.
 * @returns its lowercase hex digest.
 */
function sha256Of(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

test("storeBlob names the blob by its lowercase hex sha256 and dedupes", async () => {
	const f = await fixture();
	try {
		const bytes = new TextEncoder().encode("hello");
		const sha = await storeBlob(f.snapshotsDir, bytes);
		assert.equal(sha, createHash("sha256").update(bytes).digest("hex"));
		assert.match(sha, /^[0-9a-f]{64}$/);
		const first = await stat(join(f.snapshotsDir, sha));
		await storeBlob(f.snapshotsDir, bytes);
		const second = await stat(join(f.snapshotsDir, sha));
		// A rewrite would land through a new inode; refusing to rewrite keeps it.
		assert.equal(second.ino, first.ino);
		assert.deepEqual(await readdir(f.snapshotsDir), [sha]);
	} finally {
		await f.cleanup();
	}
});

test("readBlob round-trips a stored blob", async () => {
	const f = await fixture();
	try {
		const sha = await storeBlob(f.snapshotsDir, new TextEncoder().encode("hello"));
		const bytes = await readBlob(f.snapshotsDir, sha);
		assert.ok(bytes);
		assert.equal(Buffer.from(bytes).toString("utf8"), "hello");
	} finally {
		await f.cleanup();
	}
});

test("readBlob returns undefined for a missing blob and for a traversing name", async () => {
	const f = await fixture();
	try {
		assert.equal(await readBlob(f.snapshotsDir, "0".repeat(64)), undefined);
		assert.equal(await readBlob(f.snapshotsDir, "../escaped"), undefined);
	} finally {
		await f.cleanup();
	}
});

test("snapshotPaths hashes the whole subtree with absolute paths", async () => {
	const f = await fixture();
	try {
		await writeFile(join(f.skill, "SKILL.md"), "body");
		await mkdir(join(f.skill, "references"), { recursive: true });
		await writeFile(join(f.skill, "references", "extra.md"), "extra");
		const manifest = await snapshotPaths(f.skill);
		assert.deepEqual(manifest, [
			{ path: join(f.skill, "SKILL.md"), sha256: sha256Of("body") },
			{ path: join(f.skill, "references", "extra.md"), sha256: sha256Of("extra") },
		]);
	} finally {
		await f.cleanup();
	}
});

test("snapshotPaths throws for a root that does not exist", async () => {
	const f = await fixture();
	try {
		await assert.rejects(snapshotPaths(join(f.home, "absent")));
	} finally {
		await f.cleanup();
	}
});

test("atomicSnapshot copies the whole directory", async () => {
	const f = await fixture();
	try {
		await writeFile(join(f.skill, "SKILL.md"), "original");
		const dest = join(f.home, "batches", "a-b");
		assert.deepEqual(await atomicSnapshot(f.skill, dest), { ok: true });
		assert.equal(await readFile(join(dest, "SKILL.md"), "utf8"), "original");
	} finally {
		await f.cleanup();
	}
});

test("the atomicity snapshot DOES gate: an unreadable directory aborts the batch", async () => {
	const f = await fixture();
	try {
		const result = await atomicSnapshot(join(f.home, "does-not-exist"), join(f.home, "snap"));
		assert.equal(result.ok, false);
		assert.match(result.ok === false ? result.error : "", /no snapshot, no atomicity/);
	} finally {
		await f.cleanup();
	}
});

test("the audit snapshot is best-effort: a blob failure must NOT block the write", async () => {
	const f = await fixture();
	try {
		const errors: unknown[][] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => {
			errors.push(args);
		};
		try {
			const result = await captureBefore(f.deps, join(f.home, "does-not-exist"));
			assert.equal(result, undefined);
		} finally {
			console.error = original;
		}
		// The exact message shape is the contract; the second argument is the reason.
		assert.equal(errors.length, 1);
		assert.equal(errors[0]?.[0], "skill_ledger: before-capture failed (%s) — mutation unaffected");
		assert.ok(typeof errors[0]?.[1] === "string");
	} finally {
		await f.cleanup();
	}
});

test("captureBefore returns an empty manifest when there is nothing to capture", async () => {
	const f = await fixture();
	try {
		assert.deepEqual(await captureBefore(f.deps, undefined), []);
	} finally {
		await f.cleanup();
	}
});

test("captureBefore stores a blob per file and returns the manifest", async () => {
	const f = await fixture();
	try {
		await writeFile(join(f.skill, "SKILL.md"), "original");
		const manifest = await captureBefore(f.deps, f.skill);
		assert.deepEqual(manifest, [{ path: join(f.skill, "SKILL.md"), sha256: sha256Of("original") }]);
		const sha = manifest?.[0]?.sha256 ?? "";
		assert.equal(Buffer.from((await readBlob(f.snapshotsDir, sha)) ?? []).toString("utf8"), "original");
	} finally {
		await f.cleanup();
	}
});

test("a complete-package capture fails closed on an unreadable entry; a partial one skips it", async () => {
	const f = await fixture();
	try {
		await writeFile(join(f.skill, "SKILL.md"), "body");
		// A dangling symlink is the cheapest unreadable entry there is.
		await symlink(join(f.skill, "gone.md"), join(f.skill, "dangling.md"));
		const errors: unknown[][] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => {
			errors.push(args);
		};
		let complete: unknown;
		let partial: unknown;
		try {
			complete = await captureBefore(f.deps, f.skill, { completePackage: true });
			partial = await captureBefore(f.deps, f.skill);
		} finally {
			console.error = original;
		}
		// A baseline that silently misses a file is worse than no baseline.
		assert.equal(complete, undefined);
		assert.deepEqual(partial, [{ path: join(f.skill, "SKILL.md"), sha256: sha256Of("body") }]);
	} finally {
		await f.cleanup();
	}
});

test("recordMutation writes one well-formed entry and never throws", async () => {
	const f = await fixture();
	try {
		await writeFile(join(f.skill, "SKILL.md"), "original");
		const before = await captureBefore(f.deps, f.skill);
		assert.ok(before);
		await recordMutation(f.deps, {
			actor: "curator",
			action: "patch",
			skill: "a-b",
			evidence: { note: "tightened the trigger" },
			before,
			afterRoot: f.skill,
		});
		const entries = await listEntries(f.deps);
		assert.equal(entries.length, 1);
		const entry = entries[0];
		assert.ok(entry);
		assert.equal(entry.skill, "a-b");
		assert.equal(entry.action, "patch");
		assert.equal(entry.actor, "curator");
		assert.deepEqual(entry.evidence, { note: "tightened the trigger" });
		assert.deepEqual(entry.before, before);
		assert.deepEqual(entry.after, before);
	} finally {
		await f.cleanup();
	}
});

test("recordMutation swallows a ledger write failure", async () => {
	const f = await fixture();
	try {
		const deps: LedgerDeps = { ...f.deps, ledger: unwritable(f.deps.ledger) };
		await assert.doesNotReject(
			recordMutation(deps, { actor: "curator", action: "create", skill: "a-b", evidence: {}, before: [] }),
		);
	} finally {
		await f.cleanup();
	}
});

test("recordMutation swallows an after-capture failure and records the rest", async () => {
	const f = await fixture();
	try {
		const original = console.error;
		console.error = () => undefined;
		try {
			await recordMutation(f.deps, {
				actor: "user",
				action: "delete",
				skill: "a-b",
				evidence: {},
				before: [],
				afterRoot: join(f.home, "does-not-exist"),
			});
		} finally {
			console.error = original;
		}
		const entries = await listEntries(f.deps);
		assert.equal(entries.length, 1);
		assert.deepEqual(entries[0]?.after, []);
	} finally {
		await f.cleanup();
	}
});

test("listEntries returns newest first, skipping malformed rows", async () => {
	const f = await fixture();
	try {
		await seed(f.deps, { id: "old", action: "create", ageMs: 120_000 });
		await f.deps.ledger.put("broken", { id: "broken" } as unknown as SkillLedgerRecord);
		await seed(f.deps, { id: "new", action: "edit", skill: "other-skill", ageMs: 1_000 });
		const entries = await listEntries(f.deps);
		assert.deepEqual(
			entries.map((entry) => entry.id),
			["new", "old"],
		);
		assert.deepEqual(
			(await listEntries(f.deps, { skill: "a-b" })).map((entry) => entry.id),
			["old"],
		);
		assert.deepEqual(
			(await listEntries(f.deps, { limit: 1 })).map((entry) => entry.id),
			["new"],
		);
	} finally {
		await f.cleanup();
	}
});

test("rollback fails closed when a before-blob is missing and changes nothing", async () => {
	const f = await fixture();
	try {
		await writeFile(join(f.skill, "SKILL.md"), "current");
		await seed(f.deps, {
			id: "e1",
			action: "patch",
			before: [{ path: join(f.skill, "SKILL.md"), sha256: "deadbeef" }],
		});
		const result = await rollbackEntry(f.deps, "e1");
		assert.equal(result.ok, false);
		assert.match(result.message, /rollback aborted, nothing was changed/);
		assert.equal(await readFile(join(f.skill, "SKILL.md"), "utf8"), "current");
		// Nothing was written, not even the safety entry.
		assert.deepEqual(
			(await listEntries(f.deps)).map((entry) => entry.id),
			["e1"],
		);
	} finally {
		await f.cleanup();
	}
});

test("rollback reports an unknown entry rather than inventing one", async () => {
	const f = await fixture();
	try {
		const result = await rollbackEntry(f.deps, "absent");
		assert.equal(result.ok, false);
		assert.match(result.message, /no ledger entry 'absent'/);
	} finally {
		await f.cleanup();
	}
});

test("rollback writes a pre-rollback safety entry before restoring", async () => {
	const f = await fixture();
	try {
		await writeFile(join(f.skill, "SKILL.md"), "original");
		const before = await captureBefore(f.deps, f.skill);
		assert.ok(before);
		await seed(f.deps, { id: "e2", action: "patch", before });
		await writeFile(join(f.skill, "SKILL.md"), "changed");
		const result = await rollbackEntry(f.deps, "e2");
		assert.equal(result.ok, true);
		assert.equal(await readFile(join(f.skill, "SKILL.md"), "utf8"), "original");
		const entries = await listEntries(f.deps);
		assert.deepEqual(
			entries.map((entry) => entry.action),
			["rollback", "pre-rollback", "patch"],
		);
		// The safety entry records the state the rollback was about to overwrite.
		assert.deepEqual(entries[1]?.before, [{ path: join(f.skill, "SKILL.md"), sha256: sha256Of("changed") }]);
	} finally {
		await f.cleanup();
	}
});

test("rollback deletes files that appear only in after", async () => {
	const f = await fixture();
	try {
		await writeFile(join(f.skill, "SKILL.md"), "original");
		const before = await captureBefore(f.deps, f.skill);
		assert.ok(before);
		const added = join(f.skill, "references", "new.md");
		await mkdir(join(f.skill, "references"), { recursive: true });
		await writeFile(added, "brand new");
		const after = await snapshotPaths(f.skill);
		await seed(f.deps, { id: "e3", action: "write_file", before, after });
		const result = await rollbackEntry(f.deps, "e3");
		assert.equal(result.ok, true);
		assert.equal(await readFile(join(f.skill, "SKILL.md"), "utf8"), "original");
		await assert.rejects(readFile(added, "utf8"));
	} finally {
		await f.cleanup();
	}
});

test("rollback of a delete tops up before from the most recent full snapshot", async () => {
	const f = await fixture();
	try {
		await writeFile(join(f.skill, "SKILL.md"), "original");
		const full = await captureBefore(f.deps, f.skill);
		await seed(f.deps, { id: "older", action: "patch", before: full, ageMs: 120_000 });
		await seed(f.deps, { id: "deleted", action: "delete", before: [], ageMs: 60_000 });
		await rm(join(f.skill, "SKILL.md"));
		const result = await rollbackEntry(f.deps, "deleted");
		assert.equal(result.ok, true);
		assert.equal(await readFile(join(f.skill, "SKILL.md"), "utf8"), "original");
	} finally {
		await f.cleanup();
	}
});

test("rollback refuses a ledger entry whose paths escape the buddy home", async () => {
	const f = await fixture();
	try {
		const outside = join(f.home, "..", "escaped-skill", "SKILL.md");
		await seed(f.deps, {
			id: "escapes",
			action: "edit",
			before: [{ path: outside, sha256: sha256Of("original") }],
		});
		const result = await rollbackEntry(f.deps, "escapes");
		assert.equal(result.ok, false);
		assert.match(result.message, /outside the buddy home/);
		await assert.rejects(readFile(outside, "utf8"));
	} finally {
		await f.cleanup();
	}
});

test("rollback validates after-paths too", async () => {
	const f = await fixture();
	try {
		await seed(f.deps, {
			id: "escapes-after",
			action: "edit",
			after: [{ path: join(f.home, "..", "escaped-skill", "SKILL.md"), sha256: sha256Of("x") }],
		});
		const result = await rollbackEntry(f.deps, "escapes-after");
		assert.equal(result.ok, false);
		assert.match(result.message, /outside the buddy home/);
	} finally {
		await f.cleanup();
	}
});

test("rollback refuses to write through a symlink that leaves the buddy home", async () => {
	const f = await fixture();
	try {
		const outside = await mkdtemp(join(tmpdir(), "buddy-outside-"));
		try {
			const link = join(f.skill, "link");
			await symlink(outside, link);
			const target = join(link, "SKILL.md");
			await seed(f.deps, { id: "symlink", action: "patch", before: [{ path: target, sha256: sha256Of("x") }] });
			const result = await rollbackEntry(f.deps, "symlink");
			assert.equal(result.ok, false);
			assert.match(result.message, /outside the buddy home/);
		} finally {
			await rm(outside, { recursive: true, force: true });
		}
	} finally {
		await f.cleanup();
	}
});

test("rollback aborts with nothing changed when the safety entry cannot be written", async () => {
	const f = await fixture();
	try {
		await writeFile(join(f.skill, "SKILL.md"), "original");
		const before = await captureBefore(f.deps, f.skill);
		assert.ok(before);
		await seed(f.deps, { id: "e4", action: "patch", before });
		await writeFile(join(f.skill, "SKILL.md"), "changed");
		const deps: LedgerDeps = { ...f.deps, ledger: unwritable(f.deps.ledger) };
		const result = await rollbackEntry(deps, "e4");
		assert.equal(result.ok, false);
		assert.match(result.message, /rollback aborted, nothing was changed/);
		assert.equal(await readFile(join(f.skill, "SKILL.md"), "utf8"), "changed");
	} finally {
		await f.cleanup();
	}
});
