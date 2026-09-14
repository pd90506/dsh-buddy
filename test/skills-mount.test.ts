/**
 * Task 13: the buddy-skills host row inside a real cordis app.
 *
 * The row is where every half of the phase meets: the store's three tables, the
 * review coordinator's seam, the write path's jurisdiction guard, and the
 * panel's wire surface. A hand-written stub of `ctx` cannot show that any of it
 * is wired — reading a service as a plain property works there and throws under
 * cordis's inject Guard — and a missing hard dependency is only observable when
 * the row is left *waiting* instead of mounting.
 *
 * Three claims here can only fail for their own reason:
 *
 * 1. **The row waits for the store.** With no store sibling at all, the row must
 *    publish nothing and must not throw during mount — which is what makes the
 *    hard-dependency declaration real rather than decorative.
 * 2. **Every endpoint answers through a proxy.** Cordis hands a service out as a
 *    traceable proxy and the api-gateway dispatches with `Reflect.apply`, so a
 *    `#`-private field would pass every offline call and throw on the first live
 *    one. Every panel call below goes through the proxy.
 * 3. **`setVisibility` is the only way a skill's scope is raised.** It patches
 *    the frontmatter, so the providers really see the new tier, and it is
 *    deliberately *not* reachable through `skill_manage`'s operation set — the
 *    one hard guarantee that a habit learned in Buddy cannot leak into ordinary
 *    coding sessions.
 *
 * The heartbeat bound is ten seconds of wall clock, which no suite should wait
 * out. The harness therefore captures the timer where the row arms it (an
 * ordinary `setTimeout` at the documented delay, with every other delay still
 * going to the real scheduler) and `fireHeartbeat` invokes that captured
 * callback — so what the tests observe is the real registration, not a
 * test-only seam into the service.
 * @module test/skills-mount
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import * as storeRow from "../src/store/index.ts";
import * as skillsRow from "../src/skills/index.ts";
import { BUDDY_SKILLS_SERVICE } from "../src/skills/gateway.ts";
import { createBuddyProvider, createPromotedProvider } from "../src/skills/provider.ts";
import { FALLBACK_CONFIG, type BuddyConfig } from "../src/config.ts";
import { REFINE_FOCUS_SUFFIX } from "../src/skills/prompt.ts";
import type { ReviewUsageRecord, SkillLedgerRecord, SkillUsageRecord } from "../src/store/domain.ts";
import { tableStub } from "./support/domain-tables.ts";

/** A service as consumers reach it: a traceable proxy, never the instance. */
type ServiceProxy = Record<string, (...args: unknown[]) => unknown>;

/** The slice of a cordis `Context` this test drives. */
interface Host {
	get(name: string): unknown;
	plugin(plugin: unknown): unknown;
}

/** One recorded `subagents.start` call. */
interface Started {
	readonly name: string;
	readonly prompt: readonly { readonly type: string; readonly text: string }[];
	readonly toolFilter: unknown;
	readonly agentOptions: unknown;
	readonly parent: unknown;
}

/** The run handle a test drives to settle one review. */
interface RunHandle {
	/** The id `start` answered with, as the row knows it. */
	readonly childSessionId: string;
	/** Settle the run, as a finished review does. */
	finish(): void;
}

/** What one mount hands back to its tests. */
interface Mounted {
	/** The buddy home the store row resolved. */
	readonly home: string;
	/** The skills root under that home. */
	readonly skillsRoot: string;
	/** The `buddySkills` service, or `undefined` while the row is waiting. */
	skills(): ServiceProxy | undefined;
	/** Every contribution handed to `typert.register`. */
	readonly contributions: unknown[];
	/** Every `subagents.start` call, in order. */
	readonly started: Started[];
	/** Every `subagents.interrupt` call, in order. */
	readonly interrupted: string[];
	/** Every run the row started, so a test can settle one. */
	readonly runs: RunHandle[];
	/** The `subagents.interrupt` authority arguments, in order. */
	readonly authorities: unknown[];
	/** The `skill_usage` table the row writes through. */
	readonly usage: Map<string, SkillUsageRecord>;
	/** The `skill_ledger` table the row reads and rolls back through. */
	readonly ledger: Map<string, SkillLedgerRecord>;
	/** The `review_usage` table the coordinator writes. */
	readonly reviews: Map<string, ReviewUsageRecord>;
	/** The delays of every timer the heartbeat arm registered, in order. */
	readonly heartbeatDelays: number[];
	/** Invoke the heartbeat bound's callback, as ten seconds passing would. */
	fireHeartbeat(): void;
	/** Unmount the whole graph, the way a plugin reload does. */
	dispose(): Promise<void>;
}

/** How one mount differs from the default. */
interface MountOptions {
	/** Mount the store row beside the skills row; default `true`. */
	readonly withStore?: boolean;
	/** Mount a `subagents` plane; default `true`. */
	readonly withSubagents?: boolean;
	/** Mount a `sessionQuery` plane; default `false` (the soft-absent case). */
	readonly withSessionQuery?: boolean;
	/** Skills settings merged over the shipped defaults. */
	readonly skills?: Partial<BuddyConfig["skills"]>;
	/**
	 * Leave each started run unsettled until the test calls `finish()`, so a test
	 * can observe one while it is genuinely in flight; default `false`, which
	 * settles each run on a microtask.
	 */
	readonly holdRuns?: boolean;
	/** What `sessionQuery.readSurface` answers, per session id. */
	readonly surfaces?: Readonly<Record<string, readonly unknown[]>>;
}

/**
 * Call one endpoint the way the api-gateway does: look the method up on the
 * proxy and `Reflect.apply` it *with that proxy as `this`*.
 * @param service - the service as `ctx.get` returns it.
 * @param method - the endpoint name.
 * @param args - positional arguments.
 * @returns the endpoint's result.
 */
function dispatch(service: ServiceProxy, method: string, args: unknown[]): unknown {
	const found = service[method];
	if (typeof found !== "function") assert.fail(`${method} must be callable on the proxy`);
	return Reflect.apply(found, service, args);
}

/**
 * Spin the event loop until `predicate` holds, so a test never depends on a
 * fixed sleep for cordis's asynchronous activation.
 * @param predicate - the condition to wait for.
 * @param attempts - how many 5ms polls to spend before giving up.
 * @returns resolution once it holds.
 * @throws when it never holds.
 */
async function until(predicate: () => boolean, attempts = 200): Promise<void> {
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.fail("condition never held");
}

/**
 * Give cordis and any pending microtask chain ample room to run.
 * @returns resolution after several event-loop turns.
 */
async function settle(): Promise<void> {
	for (let turn = 0; turn < 8; turn += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

/**
 * One skill document, optionally carrying a visibility tier.
 * @param name - the skill name.
 * @param visibility - the frontmatter value, or nothing for the default tier.
 * @returns the SKILL.md text.
 */
function skillDocument(name: string, visibility?: string): string {
	const tier = visibility === undefined ? "" : `visibility: ${visibility}\n`;
	return `---\nname: ${name}\ndescription: Use when ${name} matters.\n${tier}---\n\n# ${name}\n\nBody.\n`;
}

/**
 * Mount the skills row beside sibling service plugins on a real context.
 * @param options - how this mount differs from the default.
 * @returns everything the test observes from outside the plugins.
 */
async function mountSkills(options: MountOptions = {}): Promise<Mounted> {
	const home = await mkdtemp(join(tmpdir(), "dsh-buddy-skills-"));
	// The store row installs the shipped preset under the *harness* home, which
	// `dshHomePath()` resolves from `$DSH_HOME` at call time. Left unset it would
	// reach the real `~/.dsh`, so every mount in this suite is hermetic.
	const previousDshHome = process.env["DSH_HOME"];
	const dshHome = await mkdtemp(join(tmpdir(), "dsh-buddy-skills-dsh-"));
	process.env["DSH_HOME"] = dshHome;
	// A complete config, the way the settings plane resolves the schema: the rows
	// read `ctx.buddyStore.config()` whole, so a partial object would make the
	// coordinator read `undefined` where a number belongs.
	const config: BuddyConfig = {
		...FALLBACK_CONFIG,
		home,
		skills: { ...FALLBACK_CONFIG.skills, ...(options.skills ?? {}) },
	};

	// The heartbeat bound is a real ten-second timer, so it is captured where the
	// row arms it: every other timeout still goes to the real scheduler (the
	// harness's own polls depend on it), and only the bound is held.
	const realSetTimeout = globalThis.setTimeout;
	const heartbeatCallbacks: (() => void)[] = [];
	const heartbeatDelays: number[] = [];

	try {
		globalThis.setTimeout = ((callback: () => void, delay?: number) => {
			if (delay !== 10_000) return realSetTimeout(callback, delay);
			heartbeatCallbacks.push(callback);
			heartbeatDelays.push(delay);
			return realSetTimeout(() => undefined, 0);
		}) as typeof setTimeout;
		const root = new Context() as unknown as Host;
		/** Every mounted fiber, so `dispose` tears the graph down the way a reload does. */
		const fibers: { dispose(): Promise<void> }[] = [];
		const contributions: unknown[] = [];
		const started: Started[] = [];
		const interrupted: string[] = [];
		const authorities: unknown[] = [];
		const runs: RunHandle[] = [];
		const usageTable = tableStub<SkillUsageRecord>();
		const ledgerTable = tableStub<SkillLedgerRecord>();
		const reviewTable = tableStub<ReviewUsageRecord>();
		const surfaces = new Map<string, readonly unknown[]>(Object.entries(options.surfaces ?? {}));
		let global: Record<string, unknown> = {};

		const sibling = (pluginName: string, provide: (ctx: unknown) => void): void => {
			fibers.push(root.plugin({ name: pluginName, apply: (ctx: unknown) => provide(ctx) }) as never);
		};
		const give = (ctx: unknown, key: string, value: unknown): void => {
			(ctx as { reflect: { provide(name: string, value: unknown): void } }).reflect.provide(key, value);
		};

		sibling("fake-typert", (ctx) =>
			give(ctx, "typert", {
				register: (contribution: unknown) => {
					contributions.push(contribution);
					return () => undefined;
				},
			}),
		);
		sibling("fake-storage", (ctx) =>
			give(ctx, "storageDomain", {
				open: async () => ({
					name: "buddy",
					global: {
						get: () => global,
						set: async (next: Record<string, unknown>) => {
							global = next;
						},
					},
					table: (tableName: string) => {
						if (tableName === "skill_usage") return usageTable;
						if (tableName === "skill_ledger") return ledgerTable;
						return reviewTable;
					},
					close: async () => undefined,
				}),
				get: () => undefined,
			}),
		);
		sibling("fake-settings", (ctx) =>
			give(ctx, "settings", {
				installSection: (
					_owner: unknown,
					_ns: string,
					_schema: unknown,
					_entry: unknown,
					hooks: { setSource(source: () => BuddyConfig): void; onChange(): void },
				) => {
					hooks.setSource(() => config);
				},
			}),
		);
		// The real agent registry is a soft dependency: the row only asks it for
		// the live Agent a session id belongs to, to hand `subagents.start` its
		// `parent`.
		sibling("fake-agents", (ctx) =>
			give(ctx, "agents", {
				get: (sessionId: string) => ({ id: sessionId }),
			}),
		);
		if (options.withSubagents !== false) {
			sibling("fake-subagents", (ctx) =>
				give(ctx, "subagents", {
					start: async (name: string, request: Record<string, unknown>) => {
						started.push({
							name,
							prompt: request["prompt"] as Started["prompt"],
							toolFilter: request["toolFilter"],
							agentOptions: request["agentOptions"],
							parent: request["parent"],
						});
						const childSessionId = `child-${started.length}`;
						let finishRun: () => void = () => undefined;
						const result = new Promise<unknown>((resolve) => {
							finishRun = () => resolve({ stopReason: "completed" });
						});
						// A test that only asserts the *start* must not leave the
						// coordinator waiting on a run nothing will settle, so the
						// run finishes on its own microtask unless the test asked to
						// keep it alive with `holdRuns`.
						if (options.holdRuns !== true) queueMicrotask(() => finishRun());
						runs.push({ childSessionId, finish: () => finishRun() });
						// A run's disposal settles its result, exactly as the
						// in-process driver does by cancelling the child.
						return { id: childSessionId, result, dispose: async () => finishRun() };
					},
					interrupt: (childSessionId: string, authority: unknown) => {
						interrupted.push(childSessionId);
						authorities.push(authority);
					},
				}),
			);
		}
		if (options.withSessionQuery === true) {
			sibling("fake-session-query", (ctx) =>
				give(ctx, "sessionQuery", {
					readSurface: async (sessionId: string) => ({ events: surfaces.get(sessionId) ?? [] }),
					listSessions: async () => [],
					readTitle: async () => undefined,
				}),
			);
		}

		const mountRow = (row: { name: string; inject: string[]; apply: (ctx: never) => void }): void => {
			fibers.push(root.plugin({ name: row.name, inject: row.inject, apply: row.apply }) as never);
		};
		if (options.withStore !== false) mountRow(storeRow as never);
		mountRow(skillsRow as never);

		const service = (): ServiceProxy | undefined => root.get(BUDDY_SKILLS_SERVICE) as ServiceProxy | undefined;
		if (options.withStore !== false) {
			await until(() => service() !== undefined);
		}
		await settle();

		return {
			home,
			skillsRoot: join(home, "main", "skills"),
			skills: service,
			contributions,
			started,
			interrupted,
			authorities,
			runs,
			usage: usageTable.rows,
			ledger: ledgerTable.rows,
			reviews: reviewTable.rows,
			heartbeatDelays,
			fireHeartbeat: () => {
				for (const fire of [...heartbeatCallbacks]) fire();
			},
			// Reverse mount order: the skills row is unloaded before the store it
			// depends on, which is what a real reload does.
			dispose: async () => {
				for (const fiber of [...fibers].reverse()) await fiber.dispose();
			},
		};
	} finally {
		// Restore whatever happened: the patched scheduler must never outlive one
		// mount, or a later test's polling would depend on this one's capture. The
		// bound has already been armed by the time the harness returns, so the
		// restore costs the capture nothing.
		globalThis.setTimeout = realSetTimeout;
		if (previousDshHome === undefined) delete process.env["DSH_HOME"];
		else process.env["DSH_HOME"] = previousDshHome;
	}
}

/**
 * Write one skill directory under a mount's skills root.
 * @param mounted - the mount to write into.
 * @param name - the skill name.
 * @param visibility - the frontmatter tier, or nothing for the default.
 * @returns resolution once the file exists.
 */
async function writeSkill(mounted: Mounted, name: string, visibility?: string): Promise<void> {
	const dir = join(mounted.skillsRoot, name);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "SKILL.md"), skillDocument(name, visibility), "utf8");
}

/** @returns the mounted service, failing the test when the row never published it. */
function serviceOf(mounted: Mounted): ServiceProxy {
	const service = mounted.skills();
	if (service === undefined) assert.fail("the skills row must publish buddySkills");
	return service;
}

/** The actor one foreground call claims to be. */
const FOREGROUND = { id: "session-1" };

test("the skills row names itself and declares its one hard dependency", () => {
	assert.equal(skillsRow.name, "dsh-buddy-skills");
	// Only `buddyStore` is hard: a profile without a subagent plane, a session
	// query, a typert registry or an agent registry must still mount this row, so
	// every one of those is read with `ctx.get`.
	assert.deepEqual(skillsRow.inject, ["buddyStore"]);
});

test("without the store the row waits instead of throwing", async () => {
	const failure = await mountSkills({ withStore: false });
	assert.equal(failure.skills(), undefined, "a missing hard dependency must leave the row waiting");
});

test("the row mounts on the store and publishes ctx.buddySkills", async () => {
	const service = serviceOf(await mountSkills());
	for (const method of [
		"noteStep",
		"noteSkillManageCalled",
		"onTurnEnd",
		"noteChildEvent",
		"noteAgentRowMounted",
		"presetSynced",
		"refine",
		"manage",
		"listSkills",
		"usage",
		"rollback",
		"adopt",
		"setPinned",
		"setVisibility",
		"list",
		"pin",
	]) {
		assert.equal(typeof service[method], "function", `${method} must be callable through the service`);
	}
});

test("the row mounts without a subagent plane, a session query or an agent registry", async () => {
	// Every one of those is soft. A review is skipped with one log line rather
	// than throwing out of the turn-end path.
	const service = serviceOf(await mountSkills({ withSessionQuery: false, withSubagents: false }));
	assert.equal(typeof service["onTurnEnd"], "function");
	await dispatch(service, "noteStep", ["s1"]);
	await dispatch(service, "onTurnEnd", [{ sessionId: "s1", reason: { kind: "completed" }, route: config0Route() }]);
});

/** @returns the all-empty route a session with no pin runs on. */
function config0Route(): { provider: string; model: string } {
	return { provider: FALLBACK_CONFIG.model.provider, model: FALLBACK_CONFIG.model.model };
}

test("the agent row's heartbeat is what clears the not-synced notice", async () => {
	const service = serviceOf(await mountSkills());
	assert.equal(await dispatch(service, "presetSynced", []), false, "no heartbeat has arrived yet");
	dispatch(service, "noteAgentRowMounted", []);
	assert.equal(await dispatch(service, "presetSynced", []), true);
});

test("the heartbeat bound fires the not-synced state after ten seconds", async () => {
	// The bound is 10s of wall clock, which no suite should wait out. The harness
	// captures the timer where the row registers it — an ordinary `setTimeout` at
	// the documented delay — and `fireHeartbeat` invokes that captured callback,
	// so the observation is the real registration rather than a test-only seam.
	const mounted = await mountSkills();
	const service = serviceOf(mounted);
	assert.equal(mounted.heartbeatDelays.includes(10_000), true, "the row must arm a 10s bound");
	assert.equal(await dispatch(service, "presetSyncMissed", []), false, "nothing is decided before it fires");

	mounted.fireHeartbeat();
	assert.equal(await dispatch(service, "presetSyncMissed", []), true);
	assert.equal(await dispatch(service, "presetSynced", []), false);
});

test("a heartbeat that arrives late still clears the notice", async () => {
	// A preset that mounts after the bound must recover rather than latch: the
	// bound records a *miss*, it does not overrule a later report.
	const mounted = await mountSkills();
	const service = serviceOf(mounted);
	mounted.fireHeartbeat();
	dispatch(service, "noteAgentRowMounted", []);
	assert.equal(await dispatch(service, "presetSyncMissed", []), false);
	assert.equal(await dispatch(service, "presetSynced", []), true);
});

test("a heartbeat that arrived before the bound is never reported as a miss", async () => {
	const mounted = await mountSkills();
	const service = serviceOf(mounted);
	dispatch(service, "noteAgentRowMounted", []);
	mounted.fireHeartbeat();
	assert.equal(await dispatch(service, "presetSyncMissed", []), false);
	assert.equal(await dispatch(service, "presetSynced", []), true);
});

test("exactly one typert contribution carries every panel endpoint", async () => {
	const mounted = await mountSkills();
	assert.equal(mounted.contributions.length, 1, "a second registration of the package throws in production");
	const methods = (
		(mounted.contributions[0] as { invocations: readonly { method: string }[] }).invocations ?? []
	).map((entry) => entry.method);
	for (const method of ["list", "ledger", "manage", "rollback", "adopt", "pin", "visibility", "usage", "reviewUsage"]) {
		assert.ok(methods.includes(method), `${method} must be on the wire`);
	}
});

test("a turn end forks on the session's own route, never on buddy.model", async () => {
	// `buddy.model` is the all-empty default here, so a row that substituted it
	// for the session route would see "different" and spawn on the aux model.
	// With the review model equal to the *real* route the same-model path is a
	// fork, and a fork needs no agent options and no digest.
	const mounted = await mountSkills({ withSessionQuery: true, skills: { reviewProvider: "p", reviewModel: "m" } });
	const service = serviceOf(mounted);
	for (let step = 0; step < FALLBACK_CONFIG.skills.creationNudgeInterval; step += 1) {
		dispatch(service, "noteStep", ["s1"]);
	}
	await dispatch(service, "onTurnEnd", [
		{ sessionId: "s1", reason: { kind: "completed" }, route: { provider: "p", model: "m" } },
	]);
	assert.equal(mounted.started.length, 1);
	assert.equal(mounted.started[0]?.name, "fork");
	assert.equal(mounted.started[0]?.agentOptions, undefined);
	assert.ok(!mounted.started[0]?.prompt[0]?.text.includes("Earlier conversation digest"));
});

test("the cheap-model path spawns with the digest from the session surface", async () => {
	const mounted = await mountSkills({
		withSessionQuery: true,
		skills: { reviewProvider: "p", reviewModel: "cheap" },
		surfaces: {
			s1: [
				{ type: "user/message", content: [{ type: "text", text: "hello" }] },
				{ type: "assistant/message", content: [{ type: "text", text: "hi" }] },
			],
		},
	});
	const service = serviceOf(mounted);
	for (let step = 0; step < FALLBACK_CONFIG.skills.creationNudgeInterval; step += 1) {
		dispatch(service, "noteStep", ["s1"]);
	}
	await dispatch(service, "onTurnEnd", [
		{ sessionId: "s1", reason: { kind: "completed" }, route: { provider: "p", model: "expensive" } },
	]);
	assert.equal(mounted.started.length, 1);
	assert.equal(mounted.started[0]?.name, "spawn");
	assert.deepEqual(mounted.started[0]?.agentOptions, { provider: "p", model: "cheap" });
	assert.match(mounted.started[0]?.prompt[0]?.text ?? "", /^Earlier conversation digest/);
	// The whitelist is the review's capability boundary, and it travels as the
	// one visibility gate `toolFilter` really is.
	assert.deepEqual(mounted.started[0]?.toolFilter, { allow: ["skill", "skill_manage", "read", "grep", "glob"] });
	// The prompt must be ContentBlock[], never a bare string.
	assert.equal(Array.isArray(mounted.started[0]?.prompt), true);
	assert.equal((mounted.started[0]?.parent as { id?: string } | undefined)?.id, "s1");
});

test("refine starts a review addressed to the agent the command handed over", async () => {
	const mounted = await mountSkills({ skills: { reviewProvider: "p", reviewModel: "cheap" } });
	const service = serviceOf(mounted);
	await dispatch(service, "refine", [{ id: "agent-7" }, "house style"]);
	assert.equal(mounted.started.length, 1);
	assert.equal((mounted.started[0]?.parent as { id?: string } | undefined)?.id, "agent-7");
	assert.ok(
		(mounted.started[0]?.prompt[0]?.text ?? "").includes(REFINE_FOCUS_SUFFIX("house style")),
		"the focus must reach the review prompt",
	);
});

test("a review that finishes still attributes its usage to the parent conversation", async () => {
	const mounted = await mountSkills({ skills: { reviewProvider: "p", reviewModel: "cheap" }, holdRuns: true });
	const service = serviceOf(mounted);
	void dispatch(service, "refine", [{ id: "agent-7" }, ""]);
	await settle();
	const run = mounted.runs[0];
	if (run === undefined) assert.fail("refine must start exactly one run");
	dispatch(service, "noteChildEvent", [run.childSessionId, { type: "step/end" }]);
	dispatch(service, "noteChildEvent", [
		run.childSessionId,
		{ type: "assistant/message", usage: { inputTokens: 7, cacheReadTokens: 900 } },
	]);
	run.finish();
	await until(() => mounted.reviews.size > 0);
	const row = [...mounted.reviews.values()][0];
	assert.equal(row?.parentSessionId, "agent-7");
	assert.equal(row?.cacheReadTokens, 900);
	assert.equal(row?.steps, 1);
});

test("unmounting the row interrupts every in-flight review", async () => {
	// The coordinator is the only thing enforcing a review's budgets and the
	// only thing recording its cost, so a disposed row must not leave one flying.
	const mounted = await mountSkills({ skills: { reviewProvider: "p", reviewModel: "cheap" }, holdRuns: true });
	const service = serviceOf(mounted);
	// Not awaited: with the run held open, `refine` settles only when the run
	// does, and this test's whole subject is the state *while* it is flying.
	void dispatch(service, "refine", [{ id: "agent-7" }, ""]);
	await settle();
	assert.equal(mounted.runs.length, 1);
	await mounted.dispose();
	assert.deepEqual(mounted.interrupted, ["child-1"]);
	// The ancestor authority is what spec §7.4 asks the interrupt to be scoped
	// under: the exact live parent Agent, not a bare id.
	assert.deepEqual(mounted.authorities, [{ kind: "ancestor", agent: { id: "agent-7" } }]);
});

test("listSkills merges what is on disk with what the usage table knows", async () => {
	const mounted = await mountSkills();
	await writeSkill(mounted, "alpha-skill");
	await writeSkill(mounted, "beta-skill", "global");
	await mounted.usage.set("alpha-skill", {
		created_by: "agent",
		use_count: 3,
		view_count: 3,
		last_used_at: "2026-09-13T10:00:00.000Z",
		last_viewed_at: "2026-09-13T10:00:00.000Z",
		patch_count: 1,
		patch_generation: 1,
		last_reused_patch_generation: 0,
		last_patched_at: null,
		created_at: "2026-09-13T09:00:00.000Z",
		state: "active",
		pinned: true,
		archived_at: null,
	});

	const skills = (await dispatch(serviceOf(mounted), "listSkills", [])) as Record<string, unknown>[];
	const alpha = skills.find((entry) => entry["name"] === "alpha-skill");
	const beta = skills.find((entry) => entry["name"] === "beta-skill");
	assert.equal(alpha?.["visibility"], "buddy");
	assert.equal(alpha?.["useCount"], 3);
	assert.equal(alpha?.["activityCount"], 7);
	assert.equal(alpha?.["latestActivityAt"], "2026-09-13T10:00:00.000Z");
	assert.equal(alpha?.["pinned"], true);
	assert.equal(alpha?.["curatorManaged"], true);
	assert.equal(beta?.["visibility"], "global");
	assert.equal(beta?.["useCount"], 0, "a skill with no row reads as never used, not as missing");
	assert.equal(beta?.["pinned"], false);
	// Owned objects only: no live session, no provider, no table handle escapes.
	assert.deepEqual(Object.keys(alpha ?? {}).sort(), [
		"activityCount",
		"curatorManaged",
		"description",
		"latestActivityAt",
		"name",
		"pinned",
		"useCount",
		"visibility",
	]);
});

test("the usage and reviewUsage endpoints report the tables as owned rows", async () => {
	const mounted = await mountSkills();
	await writeSkill(mounted, "alpha-skill");
	await mounted.usage.set("alpha-skill", {
		created_by: null,
		use_count: 1,
		view_count: 0,
		last_used_at: "2026-09-13T10:00:00.000Z",
		last_viewed_at: null,
		patch_count: 0,
		patch_generation: 0,
		last_reused_patch_generation: 0,
		last_patched_at: null,
		created_at: "2026-09-13T09:00:00.000Z",
		state: "active",
		pinned: false,
		archived_at: null,
	});
	await mounted.reviews.set("r1", {
		id: "r1",
		ts: "2026-09-13T11:00:00.000Z",
		parentSessionId: "s1",
		childSessionId: "c1",
		provider: "fork",
		model: "m",
		steps: 2,
		inputTokens: 10,
		outputTokens: 4,
		cacheReadTokens: 900,
		cacheWriteTokens: 0,
		outcome: "completed",
	});
	const service = serviceOf(mounted);
	const usage = (await dispatch(service, "usage", [])) as Record<string, unknown>[];
	const reviews = (await dispatch(service, "reviewUsage", [])) as Record<string, unknown>[];
	assert.deepEqual(usage, [
		{
			skill: "alpha-skill",
			createdBy: "human",
			useCount: 1,
			viewCount: 0,
			patchCount: 0,
			lastUsedAt: "2026-09-13T10:00:00.000Z",
			latestActivityAt: "2026-09-13T10:00:00.000Z",
			activityCount: 1,
			pinned: false,
			archived: false,
		},
	]);
	assert.deepEqual(reviews, [
		{
			id: "r1",
			ts: "2026-09-13T11:00:00.000Z",
			parentSessionId: "s1",
			childSessionId: "c1",
			provider: "fork",
			model: "m",
			steps: 2,
			inputTokens: 10,
			outputTokens: 4,
			cacheReadTokens: 900,
			outcome: "completed",
		},
	]);
});

test("pin, adopt and the ledger are reachable from the panel and land in the tables", async () => {
	const mounted = await mountSkills();
	const created = (await dispatch(serviceOf(mounted), "manage", [
		FOREGROUND,
		[{ action: "create", name: "alpha-skill", content: skillDocument("alpha-skill") }],
	])) as { success: boolean; message: string };
	assert.equal(created.success, true, created.message);
	assert.equal(mounted.usage.get("alpha-skill")?.created_by, null, "a foreground create is human provenance");

	const adopted = (await dispatch(serviceOf(mounted), "adopt", ["alpha-skill"])) as {
		success: boolean;
		message: string;
		skills: Record<string, unknown>[];
	};
	assert.equal(adopted.success, true, adopted.message);
	assert.equal(adopted.skills.find((entry) => entry["name"] === "alpha-skill")?.["curatorManaged"], true);
	assert.equal(mounted.usage.get("alpha-skill")?.created_by, "agent");
	const pinned = (await dispatch(serviceOf(mounted), "pin", ["alpha-skill", true])) as { success: boolean };
	assert.equal(pinned.success, true);
	assert.equal(mounted.usage.get("alpha-skill")?.pinned, true);
	// A pin cannot invent a record for a skill nobody created.
	const ghost = (await dispatch(serviceOf(mounted), "pin", ["ghost-skill", true])) as { success: boolean };
	assert.equal(ghost.success, false);

	const ledger = (await dispatch(serviceOf(mounted), "ledger", [])) as Record<string, unknown>[];
	assert.equal(ledger.length, 1);
	assert.equal(ledger[0]?.["action"], "create");
	assert.equal(ledger[0]?.["skill"], "alpha-skill");
	assert.equal(typeof ledger[0]?.["id"], "string");
});

test("a panel rollback restores the file and records the undo", async () => {
	const mounted = await mountSkills();
	const service = serviceOf(mounted);
	await dispatch(service, "manage", [
		FOREGROUND,
		[{ action: "create", name: "alpha-skill", content: skillDocument("alpha-skill") }],
	]);
	await dispatch(service, "manage", [
		FOREGROUND,
		[{ action: "patch", name: "alpha-skill", old_string: "# alpha-skill", new_string: "# changed" }],
	]);
	const file = join(mounted.skillsRoot, "alpha-skill", "SKILL.md");
	assert.match(await readFile(file, "utf8"), /# changed/);

	const entries = [...mounted.ledger.values()].sort((left, right) => (left.ts < right.ts ? -1 : 1));
	const patchEntry = entries.find((entry) => entry.action === "patch");
	if (patchEntry === undefined) assert.fail("the patch must be in the ledger");
	const result = (await dispatch(service, "rollback", [patchEntry.id])) as { success: boolean; message: string };
	assert.equal(result.success, true, result.message);
	assert.match(await readFile(file, "utf8"), /# alpha-skill/);
	assert.ok([...mounted.ledger.values()].some((entry) => entry.action === "rollback"));
});

test("setVisibility is the only way a skill's tier is raised, and the providers see it", async () => {
	const mounted = await mountSkills();
	await writeSkill(mounted, "alpha-skill");
	const service = serviceOf(mounted);

	// Invisible to the promoted provider while it is a buddy skill.
	const promoted = createPromotedProvider({ skillsRoot: mounted.skillsRoot });
	assert.deepEqual(await promoted.list({}), []);

	const result = (await dispatch(service, "visibility", ["alpha-skill", "global"])) as {
		success: boolean;
		message: string;
		skills: Record<string, unknown>[];
	};
	assert.equal(result.success, true, result.message);
	assert.match(await readFile(join(mounted.skillsRoot, "alpha-skill", "SKILL.md"), "utf8"), /^visibility: global$/m);
	// The promoted provider is the one ordinary coding sessions merge, so this is
	// the promotion being real rather than a panel-only flag.
	assert.deepEqual((await promoted.list({})).map((entry) => entry.name), ["alpha-skill"]);
	const buddy = createBuddyProvider({ skillsRoot: mounted.skillsRoot });
	assert.deepEqual(await buddy.list({}), [], "a promoted skill leaves the buddy-private tier");
	assert.equal(result.skills.find((entry) => entry["name"] === "alpha-skill")?.["visibility"], "global");
});

test("setVisibility refuses a tier it cannot write and touches nothing", async () => {
	const mounted = await mountSkills();
	await writeSkill(mounted, "alpha-skill");
	const service = serviceOf(mounted);
	const before = await readFile(join(mounted.skillsRoot, "alpha-skill", "SKILL.md"), "utf8");
	for (const tier of ["project", "nowhere", ""]) {
		const result = (await dispatch(service, "visibility", ["alpha-skill", tier])) as { success: boolean };
		assert.equal(result.success, false, `'${tier}' must be refused`);
	}
	assert.equal(await readFile(join(mounted.skillsRoot, "alpha-skill", "SKILL.md"), "utf8"), before);
});

test("skill_manage's operation set has no way to raise a skill's scope", async () => {
	// The write path accepts exactly the six mutating actions. A client that
	// invents a `visibility` operation must be refused *and must not touch the
	// file*, because `setVisibility` is the only sanctioned way to promote.
	const mounted = await mountSkills();
	await writeSkill(mounted, "alpha-skill");
	const before = await readFile(join(mounted.skillsRoot, "alpha-skill", "SKILL.md"), "utf8");
	const outcome = (await dispatch(serviceOf(mounted), "manage", [
		FOREGROUND,
		[{ action: "visibility", name: "alpha-skill", content: "global" }],
	])) as { success: boolean; error?: string };
	assert.equal(outcome.success, false);
	assert.equal(await readFile(join(mounted.skillsRoot, "alpha-skill", "SKILL.md"), "utf8"), before);
	// And the action list the tool publishes is exactly the six.
	assert.deepEqual([...skillsRow.SKILL_MANAGE_ACTIONS].sort(), [
		"create",
		"delete",
		"edit",
		"patch",
		"remove_file",
		"write_file",
	]);
});

test("a malformed wire batch is refused without opening a batch", async () => {
	const service = serviceOf(await mountSkills());
	assert.equal(((await dispatch(service, "manage", [FOREGROUND, "nonsense"])) as { success: boolean }).success, false);
	assert.equal(((await dispatch(service, "manage", [FOREGROUND, []])) as { success: boolean }).success, false);
	assert.equal(((await dispatch(service, "manage", [FOREGROUND, [null]])) as { success: boolean }).success, false);
});

test("a review session's write is judged by jurisdiction, not by the tool that sent it", async () => {
	// The row is what knows which sessions it started: a `skill_manage` call from
	// one of them is the automatic review and is held to read-before-write, while
	// the same call from the foreground is free.
	const mounted = await mountSkills({ skills: { reviewProvider: "p", reviewModel: "cheap" }, holdRuns: true });
	const service = serviceOf(mounted);
	await dispatch(service, "manage", [
		FOREGROUND,
		[{ action: "create", name: "human-skill", content: skillDocument("human-skill") }],
	]);
	// A human skill is not the review's to rewrite.
	void dispatch(service, "refine", [{ id: "agent-7" }, ""]);
	await settle();
	const reviewChild = mounted.runs[0]?.childSessionId ?? assert.fail("a review must be flying");
	const refused = (await dispatch(service, "manage", [
		{ id: reviewChild },
		[{ action: "patch", name: "human-skill", old_string: "Body.", new_string: "Tampered." }],
	])) as { success: boolean; message: string; error?: string };
	assert.equal(refused.success, false);
	// The batch's own reason rides on `message` (that is the shape the panel
	// shows); `error` is the service-level batch outcome, which is not exposed.
	assert.match(refused.message, /not curator-managed/);
});
