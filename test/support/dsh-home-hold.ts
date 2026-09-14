/**
 * Hold the real `$DSH_HOME` back for the whole life of a test file.
 *
 * The store row's boot resolves `dshHomePath()` and then runs
 * `syncPreset(presetTargetDir(dshHomePath()), …)` (`src/store/index.ts`). That
 * boot is asynchronous and can outlive the test that started it: `until()` in
 * these suites gives up after ~1s while the boot's settings barrier counts down
 * for 2s, and a test can simply return before its row publishes. On a machine
 * where `$DSH_HOME` is ambient — the real harness sets it — a boot that resumes
 * after a per-test restore reads the REAL home, and since Task 10b an unmarked
 * directory whose bytes this plugin published is CLAIMED and rewritten. The only
 * trace is a `.catch`ed `console.error`, which under the `web` profile reaches
 * nowhere.
 *
 * So the ambient value is captured when the file loads, the file runs against a
 * throwaway home, and one file-scope `after()` hook puts the real value back —
 * **after** disposing every row {@link DshHomeHold.track} was handed, because
 * cordis awaits a pending effect body before `dispose()` resolves, so by then no
 * boot can still be on its way to `syncPreset`. The hook also asserts the hold
 * survived the file, so an early restore added later fails loudly instead of
 * quietly reopening the hole.
 *
 * A per-test restore is not merely untidy here: it is the failure path. The
 * restore runs in a `finally` even when the awaited observation threw, which is
 * exactly when a boot is most likely to still be parked.
 * @module test/support/dsh-home-hold
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

/** A mounted row, as far as this hold cares. */
interface Disposable {
	dispose(): Promise<void>;
}

/** What a file gets from {@link holdDshHome}. */
export interface DshHomeHold {
	/**
	 * Point `$DSH_HOME` at a fresh throwaway directory.
	 * @returns that directory, absolute.
	 */
	scratch(): string;
	/**
	 * Stop pointing `$DSH_HOME` at the current scratch home.
	 *
	 * Back to the file's own hold home — never the captured ambient one: a boot
	 * this test started may still be parked, and it reads `dshHomePath()` when
	 * it resumes.
	 * @returns nothing.
	 */
	release(): void;
	/**
	 * Remember a mounted row, so the file's teardown disposes it before the real
	 * home goes back.
	 * @param fiber - the fiber `ctx.plugin()` returned.
	 * @returns the same fiber, for inline use.
	 */
	track<T extends Disposable>(fiber: T): T;
}

/** How long a stuck boot may hold the file's teardown before the home goes back. */
const DISPOSE_BOUND_MS = 3_000;

/**
 * Hold the ambient `$DSH_HOME` back until the calling test file is over.
 *
 * Call once at the file's module scope; the `after()` hook it registers belongs
 * to that file.
 * @returns the file's scratch-home allocator, row tracker and release.
 */
export function holdDshHome(): DshHomeHold {
	const ambient = process.env["DSH_HOME"];
	const holdHome = mkdtempSync(join(tmpdir(), "dsh-buddy-dsh-hold-"));
	// Ambient from the very first line: a row mounted before any test calls
	// `scratch()` must not read the real home either.
	process.env["DSH_HOME"] = holdHome;
	const fibers: Disposable[] = [];
	after(async () => {
		// Checked BEFORE the restore below, and before the real home can come
		// back: if something put it back mid-file, a boot may already have run
		// against it, and that is a failure of this file rather than a nuisance.
		const ambientIsBack =
			ambient === undefined ? !("DSH_HOME" in process.env) : process.env["DSH_HOME"] === ambient;
		try {
			assert.equal(
				ambientIsBack,
				false,
				"the ambient $DSH_HOME came back before this file was over; a store row's boot may have run against the real home",
			);
		} finally {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					// `dispose()` is awaited by cordis only after the pending effect
					// body settles, which is what makes this the safe moment to
					// restore. Bounded, because a boot parked on a gate no test will
					// release must not hang the whole file.
					Promise.allSettled(fibers.map(async (fiber) => await fiber.dispose())),
					new Promise<void>((resolve) => {
						timer = setTimeout(resolve, DISPOSE_BOUND_MS);
					}),
				]);
			} finally {
				if (timer !== undefined) clearTimeout(timer);
			}
			if (ambient === undefined) delete process.env["DSH_HOME"];
			else process.env["DSH_HOME"] = ambient;
		}
	});
	return {
		scratch: () => {
			const home = mkdtempSync(join(tmpdir(), "dsh-buddy-dsh-"));
			process.env["DSH_HOME"] = home;
			return home;
		},
		release: () => {
			process.env["DSH_HOME"] = holdHome;
		},
		track: (fiber) => {
			fibers.push(fiber);
			return fiber;
		},
	};
}
