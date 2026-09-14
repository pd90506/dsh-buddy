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
import { holdDshHome } from "./support/dsh-home-hold.ts";

/**
 * The file's `$DSH_HOME` hold.
 *
 * See `./support/dsh-home-hold.ts` for why the ambient home is held for the
 * whole file rather than put back when a mount returns.
 */
const dshHomeHold = holdDshHome();

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
	/** The real cordis root context, so a test can resolve a service the way the gateway does. */
	readonly root: Host & { get(name: string): unknown };
	/** The numeric state of the skills row's own fiber (`0` waiting, `2` active). */
	skillsRowState(): number;
	/** Mount the store row after the fact, releasing a waiting skills row. */
	provideStore(): void;
	/** Let a `holdStart` mount's pending `subagents.start` resolve. */
	releaseStart(): void;
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
	/**
	 * The effective stop, as the harness observed it.
	 *
	 * `interrupt` is a documented no-op for a one-shot run, so a suite that
	 * asserted only on it would stay green with the abort and the disposal
	 * deleted — and the amended §7.4 mechanism would go unverified.
	 */
	readonly witness: {
		/** Every started review's request signal, in order, keeping its live state. */
		readonly signals: AbortSignal[];
		/** How many runs had `dispose()` called, in order of the calls. */
		readonly disposed: string[];
	};
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
	/** Every line the row sent to `console.error`, which is its log sink. */
	readonly logLines: string[];
	/**
	 * Reinstall the real `console.error`.
	 *
	 * The capture has to survive the mount itself (the degradation is logged as
	 * the row settles, e.g. on the first skipped review), so it is the test that
	 * releases it — `node:test` restores a clean console between files either way.
	 */
	restoreLogging(): void;
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
	/** Mount a `typert` registry; default `true`. */
	readonly withTypert?: boolean;
	/** Mount an `agents` registry; default `true`. */
	readonly withAgents?: boolean;
	/** Skills settings merged over the shipped defaults. */
	readonly skills?: Partial<BuddyConfig["skills"]>;
	/**
	 * Leave each started run unsettled until the test calls `finish()`, so a test
	 * can observe one while it is genuinely in flight; default `false`, which
	 * settles each run on a microtask.
	 */
	readonly holdRuns?: boolean;
	/**
	 * Leave `subagents.start` itself unresolved until `releaseStart()` is called,
	 * so a test can dispose the row inside the pre-registration window.
	 */
	readonly holdStart?: boolean;
	/** What `sessionQuery.readSurface` answers, per session id. */
	readonly surfaces?: Readonly<Record<string, readonly unknown[]>>;
	/**
	 * Each live agent's `AgentOptions`, keyed by session id.
	 *
	 * A session absent from this map has no live agent at all — the agents
	 * service answers `undefined`, exactly as the registry does.
	 */
	readonly agents?: Readonly<Record<string, { provider?: string; model?: string }>>;
	/**
	 * Occupy the preset id with a directory that is the USER's own preset,
	 * written under the temp `DSH_HOME` before any row mounts; default `false`.
	 *
	 * The store row's boot `syncPreset` then finds an unmarked, non-empty
	 * preset directory under it and returns `kept`, which is the state the
	 * panel has to be able to name — the whole point of the ownership field.
	 */
	readonly seedUserPreset?: boolean;
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
	// reach the real `~/.dsh`, so every mount in this suite is hermetic — and the
	// ambient value stays held for the whole file (`./support/dsh-home-hold.ts`),
	// because both the row's boot `syncPreset` and every later
	// `buddyStore.presetOwnership()` read it at call time, long after a mount
	// returns.
	const dshHome = dshHomeHold.scratch();
	// A complete config, the way the settings plane resolves the schema: the rows
	// read `ctx.buddyStore.config()` whole, so a partial object would make the
	// coordinator read `undefined` where a number belongs.
	const config: BuddyConfig = {
		...FALLBACK_CONFIG,
		home,
		skills: { ...FALLBACK_CONFIG.skills, ...(options.skills ?? {}) },
	};

	// Seeded BEFORE any row mounts: the store row's boot `syncPreset` is what
	// reads this directory, so a seed written afterwards would be observed by
	// nothing and the test would assert against the wrong state.
	if (options.seedUserPreset === true) {
		const presetDir = join(dshHome, ".agent-presets", "buddy");
		await mkdir(presetDir, { recursive: true });
		await writeFile(join(presetDir, "agent.cordis.yml"), "mine\n", "utf8");
	}

	// The heartbeat bound is a real ten-second timer, so it is captured where the
	// row arms it: every other timeout still goes to the real scheduler (the
	// harness's own polls depend on it), and only the bound is held.
	const realSetTimeout = globalThis.setTimeout;
	const realConsoleError = console.error;
	const heartbeatCallbacks: (() => void)[] = [];
	const heartbeatDelays: number[] = [];

	try {
		globalThis.setTimeout = ((callback: () => void, delay?: number) => {
			if (delay !== 10_000) return realSetTimeout(callback, delay);
			heartbeatCallbacks.push(callback);
			heartbeatDelays.push(delay);
			return realSetTimeout(() => undefined, 0);
		}) as typeof setTimeout;
		// The row logs through `console.error`; capturing it is what lets a test
	// assert that a degradation is *said out loud* rather than silent.
	const logLines: string[] = [];
	console.error = (...args: unknown[]) => {
		logLines.push(args.map((value) => String(value)).join(" "));
	};
	const root = new Context() as unknown as Host;
		/** Every mounted fiber, so `dispose` tears the graph down the way a reload does. */
		const fibers: { dispose(): Promise<void> }[] = [];
		const contributions: unknown[] = [];
		const started: Started[] = [];
		const interrupted: string[] = [];
		const authorities: unknown[] = [];
		const runs: RunHandle[] = [];
		const witness = { signals: [] as AbortSignal[], disposed: [] as string[] };
		const usageTable = tableStub<SkillUsageRecord>();
		const ledgerTable = tableStub<SkillLedgerRecord>();
		const reviewTable = tableStub<ReviewUsageRecord>();
		const surfaces = new Map<string, readonly unknown[]>(Object.entries(options.surfaces ?? {}));
		let global: Record<string, unknown> = {};
		/** Each live agent's `options`, keyed by session id. */
		const agents = new Map<string, { provider?: string; model?: string }>(Object.entries(options.agents ?? {}));
		let releaseStart: () => void = () => undefined;
		const startGate = {
			promise: new Promise<void>((resolve) => {
				releaseStart = resolve;
			}),
		};

		const sibling = (pluginName: string, provide: (ctx: unknown) => void): void => {
			const fiber = root.plugin({ name: pluginName, apply: (ctx: unknown) => provide(ctx) });
			fibers.push(fiber as never);
			dshHomeHold.track(fiber as { dispose(): Promise<void> });
		};
		const give = (ctx: unknown, key: string, value: unknown): void => {
			(ctx as { reflect: { provide(name: string, value: unknown): void } }).reflect.provide(key, value);
		};

		if (options.withTypert !== false) {
			sibling("fake-typert", (ctx) =>
				give(ctx, "typert", {
					register: (contribution: unknown) => {
						contributions.push(contribution);
						return () => undefined;
					},
				}),
			);
		}
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
		if (options.withAgents !== false) {
			// Exactly the verified shape and nothing more: `AgentRegistry.get`
			// (`dsh-agent/lib/types/index.d.ts`) answering a live Agent whose
			// `options: AgentOptions` is the documented runtime face
			// (`dsh-agent/lib/types/runtime-types.d.ts:139-141`). A test that reaches
			// for an accessor the harness does not really have therefore fails here
			// instead of being satisfied by an invented method — which is precisely
			// how a fictional `sessionQuery.readRoute` stayed invisible once before.
			sibling("fake-agents", (ctx) =>
				give(ctx, "agents", {
					get: (sessionId: string) =>
						agents.has(sessionId)
							? { id: sessionId, options: agents.get(sessionId) }
							: // No map was supplied: a bare live agent with no route, which is
								// what a session the deployment never pinned looks like.
								options.agents === undefined
								? { id: sessionId, options: {} }
								: undefined,
				}),
			);
		}
		if (options.withSubagents !== false) {
			sibling("fake-subagents", (ctx) =>
				give(ctx, "subagents", {
					start: async (name: string, request: Record<string, unknown>) => {
						if (options.holdStart === true) await startGate.promise;
						started.push({
							name,
							prompt: request["prompt"] as Started["prompt"],
							toolFilter: request["toolFilter"],
							agentOptions: request["agentOptions"],
							parent: request["parent"],
						});
						const childSessionId = `child-${started.length}`;
						witness.signals.push(request["signal"] as AbortSignal);
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
						return {
							id: childSessionId,
							result,
							dispose: async () => {
								witness.disposed.push(childSessionId);
								finishRun();
							},
						};
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
					// Only methods the shipped `SessionQueryEngine` really has.
					readSurface: async (sessionId: string) => ({ events: surfaces.get(sessionId) ?? [] }),
					listSessions: async () => [],
					readTitle: async () => undefined,
				}),
			);
		}

		const mountRow = (row: { name: string; inject: string[]; apply: (ctx: never) => void }): unknown => {
			const fiber = root.plugin({ name: row.name, inject: row.inject, apply: row.apply });
			fibers.push(fiber as never);
			// The file-scope teardown disposes these too, before the ambient
			// home returns — a mount a test never disposes must not be able to
			// resume its boot against the real `~/.dsh` afterwards.
			dshHomeHold.track(fiber as { dispose(): Promise<void> });
			return fiber;
		};
		if (options.withStore !== false) mountRow(storeRow as never);
		const skillsFiber = mountRow(skillsRow as never) as { state: number };

		const service = (): ServiceProxy | undefined => root.get(BUDDY_SKILLS_SERVICE) as ServiceProxy | undefined;
		if (options.withStore !== false) {
			await until(() => service() !== undefined);
		}
		await settle();

		return {
			home,
			root,
			skillsRowState: () => skillsFiber.state,
			provideStore: () => {
				if (options.withStore !== false) return;
				// This boot happens after the harness returned, and it must still
				// see THIS mount's scratch home: the file-scope hold keeps a
				// throwaway ambient for the whole file, and nothing in between
				// re-points it.
				mountRow(storeRow as never);
			},
			releaseStart: () => releaseStart(),
			skillsRoot: join(home, "main", "skills"),
			skills: service,
			contributions,
			started,
			interrupted,
			authorities,
			witness,
			runs,
			usage: usageTable.rows,
			ledger: ledgerTable.rows,
			reviews: reviewTable.rows,
			logLines,
			restoreLogging: () => {
				console.error = realConsoleError;
			},
			heartbeatDelays,
			fireHeartbeat: () => {
				for (const fire of [...heartbeatCallbacks]) fire();
			},
			// Reverse mount order: the skills row is unloaded before the store it
			// depends on, which is what a real reload does.
			dispose: async () => {
				for (const fiber of [...fibers].reverse()) await fiber.dispose();
				// Back to the file's hold home, never the ambient one. It is safe
				// unconditionally — unlike a captured "previous" value, a second
				// dispose cannot put the real home back under another live mount.
				dshHomeHold.release();
			},
		};
	} finally {
		// Restore whatever happened: the patched scheduler must never outlive one
		// mount, or a later test's polling would depend on this one's capture. The
		// bound has already been armed by the time the harness returns, so the
		// restore costs the capture nothing.
		globalThis.setTimeout = realSetTimeout;
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
	// "Unmounted" alone cannot tell a waiting row from a failed one: a throw out
	// of `apply` also publishes nothing. The fiber's own state is the difference.
	const failure = await mountSkills({ withStore: false });
	assert.equal(failure.skills(), undefined, "a missing hard dependency must leave the row waiting");
	// Cordis fiber states: 0 waiting on an inject, 2 active. A throw out of
	// `apply` leaves the fiber failed, which is the distinction that matters.
	assert.equal(failure.skillsRowState(), 0, "the row must be held pending its inject, not failed");
	// And it is genuinely waiting rather than inert: the moment the store appears
	// the same fiber finishes mounting.
	failure.provideStore();
	await until(() => failure.skills() !== undefined);
	assert.equal(failure.skillsRowState(), 2, "and it must finish mounting once its inject arrives");
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

test("a full interval with no subagent plane, session query or agent registry is a skipped review", async () => {
	// Every one of those planes is soft. The assertion is not "it did not throw"
	// but "it took the whole path and skipped the review": a full nudge interval
	// elapsed, the turn ended as completed, and the coordinator reached its spawn
	// seam with nowhere to start — one log line, no throw, no interrupt.
	const mounted = await mountSkills({ withSessionQuery: false, withSubagents: false });
	const service = serviceOf(mounted);
	for (let step = 0; step < FALLBACK_CONFIG.skills.creationNudgeInterval; step += 1) {
		dispatch(service, "noteStep", ["s1"]);
	}
	await dispatch(service, "onTurnEnd", [{ sessionId: "s1", reason: { kind: "completed" } }]);
	assert.equal(mounted.started.length, 0, "there is no plane to start a review on");
	assert.equal(mounted.interrupted.length, 0);
	assert.equal(mounted.witness.disposed.length, 0);
});

test("with no agent registry either, the turn end is still a skip rather than a throw", async () => {
	// The subagent plane exists here but no parent Agent can be resolved, which
	// is the other half of the same soft surface.
	const mounted = await mountSkills({ withAgents: false });
	const service = serviceOf(mounted);
	for (let step = 0; step < FALLBACK_CONFIG.skills.creationNudgeInterval; step += 1) {
		dispatch(service, "noteStep", ["s1"]);
	}
	await dispatch(service, "onTurnEnd", [{ sessionId: "s1", reason: { kind: "completed" } }]);
	assert.equal(mounted.started.length, 0);
});

test("the row mounts and serves without a typert registry, and says so", async () => {
	// `typert` is soft, like every other plane besides the store. A profile
	// without it must still get `ctx.buddySkills` — the preset row and the review
	// coordinator read that service — and pay only a log line for the missing
	// panel, never a failed mount.
	const mounted = await mountSkills({ withTypert: false });
	const service = mounted.skills();
	if (service === undefined) assert.fail("a missing typert registry must not take the row down");
	assert.deepEqual(mounted.contributions, [], "there is no registry to contribute to");
	assert.equal(typeof service["onTurnEnd"], "function");
	assert.equal((await dispatch(service, "status", [])) instanceof Object, true);
	// An unlogged degradation is the silent failure this phase exists to remove,
	// so the loss of the panel has to be observable in the log.
	assert.match(
		mounted.logLines.join("\n"),
		/typert registry is unavailable.*panel will have no endpoints/s,
	);
	mounted.restoreLogging();
});

test("a heartbeat before the bound flips the notice from the start", async () => {
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
	// The same fact on the wire, which is what a panel actually reads.
	assert.deepEqual(await dispatch(service, "status", []), { synced: false, missed: true, preset: "plugin" });
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
	assert.deepEqual(await dispatch(service, "status", []), { synced: true, missed: false, preset: "plugin" });
});

test("a preset id the user's own preset occupies is reported as the user's", async () => {
	// The mount's temp `DSH_HOME` holds a hand-written, unmarked preset, so the
	// store row's boot `syncPreset` keeps it. The panel must be able to say
	// that, because "your own preset is why the row never arrived" is the one
	// diagnosis a user can act on.
	const mounted = await mountSkills({ seedUserPreset: true });
	const service = serviceOf(mounted);
	assert.deepEqual(await dispatch(service, "status", []), { synced: false, missed: false, preset: "user" });
});

test("every endpoint names the service key that actually carries the typert binding", async () => {
	// The api-gateway resolves a strict descriptor as `ctx.get(descriptor.service)`
	// and then requires that service to expose a `typertRemote` binding whose
	// `serviceKey` **and** `namespace` agree with the descriptor
	// (`dsh-api-gateway/lib/index.js:1002-1005`). A descriptor that names the wire
	// namespace where the binding does not live is a dead endpoint: every call
	// fails `gateway/binding-invalid` at runtime while every offline test passes.
	// This test therefore resolves the descriptor the way the gateway does,
	// rather than trusting the two strings to look similar.
	const mounted = await mountSkills();
	const contribution = mounted.contributions[0] as {
		invocations: readonly { method: string; namespace: string; service: string }[];
	};
	for (const invocation of contribution.invocations) {
		assert.equal(invocation.namespace, "buddySkills", `${invocation.method} must be on the wire namespace`);
		const bound = (mounted.root.get(invocation.service) as { typertRemote?: unknown } | undefined)?.typertRemote as
			| { serviceKey?: string; namespace?: string }
			| undefined;
		assert.notEqual(bound, undefined, `${invocation.method}: ctx.get(${invocation.service}) carries no typert binding`);
		assert.equal(bound?.serviceKey, invocation.service, `${invocation.method}: the binding key must be the descriptor's service`);
		assert.equal(bound?.namespace, invocation.namespace, `${invocation.method}: the binding namespace must match`);
	}
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

test("refine reads the route off the live agent instead of falling back to buddy.model", async () => {
	// `buddy.model` is the shipped all-empty default. A refine that dropped the
	// route would compare the configured review model against that empty pair,
	// see "different", and spawn on the aux model — when the review model here
	// *equals* the route the live agent was composed for, so the same-model fork
	// is correct. The route comes from `AgentRegistry.get(id).options`, the only
	// real accessor: delete that read and this test spawns instead of forking.
	const mounted = await mountSkills({
		withSessionQuery: true,
		skills: { reviewProvider: "p", reviewModel: "m" },
		agents: { "agent-7": { provider: "p", model: "m" } },
	});
	await dispatch(serviceOf(mounted), "refine", [{ id: "agent-7" }, ""]);
	assert.equal(mounted.started.length, 1);
	assert.equal(mounted.started[0]?.name, "fork", "the live agent's route says the same model, so this must fork");
	assert.equal(mounted.started[0]?.agentOptions, undefined);
});

test("refine says out loud when the route cannot be resolved", async () => {
	// No live agent for the session: §7.1's decision has to fall back to
	// `buddy.model`, and the whole point is that the degradation is *visible*
	// rather than a silently wrong path choice.
	const mounted = await mountSkills({
		withSessionQuery: true,
		skills: { reviewProvider: "p", reviewModel: "cheap" },
		agents: {},
	});
	await dispatch(serviceOf(mounted), "refine", [{ id: "missing-session" }, ""]);
	assert.equal(mounted.started.length, 1, "the review still runs on the documented fallback");
	assert.match(mounted.logLines.join("\n"), /review route is unknown.*falls back to buddy\.model/s);
	mounted.restoreLogging();
});

test("refine carries the transcript, so an explicit review is not blind", async () => {
	const mounted = await mountSkills({
		withSessionQuery: true,
		skills: { reviewProvider: "p", reviewModel: "cheap" },
		agents: { "agent-7": { provider: "p", model: "expensive" } },
		surfaces: {
			"agent-7": [
				{ type: "user/message", content: [{ type: "text", text: "hello" }] },
				{ type: "assistant/message", content: [{ type: "text", text: "hi" }] },
			],
		},
	});
	await dispatch(serviceOf(mounted), "refine", [{ id: "agent-7" }, "house style"]);
	assert.equal(mounted.started.length, 1);
	assert.equal(mounted.started[0]?.name, "spawn");
	// A spawn has no seed, so without the digest the review reads nothing at all.
	assert.match(mounted.started[0]?.prompt[0]?.text ?? "", /Earlier conversation digest/);
	assert.match(mounted.started[0]?.prompt[0]?.text ?? "", /USER: hello/);
	assert.match(mounted.started[0]?.prompt[0]?.text ?? "", /house style/);
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
	assert.equal(mounted.witness.signals[0]?.aborted, false, "nothing has cancelled the review yet");
	await mounted.dispose();

	// The *effective* stop, not merely the declared one: `interrupt` is a
	// documented no-op for a one-shot run, so a suite asserting only on it would
	// stay green with the abort and the disposal deleted.
	assert.equal(mounted.witness.signals[0]?.aborted, true, "the request signal must be aborted");
	assert.deepEqual(mounted.witness.disposed, ["child-1"], "the run itself must be disposed");
	assert.deepEqual(mounted.interrupted, ["child-1"]);
	// The ancestor authority is what spec §7.4 asks the interrupt to be scoped
	// under: the exact live parent Agent, not a bare id.
	assert.deepEqual(mounted.authorities, [{ kind: "ancestor", agent: { id: "agent-7" } }]);
});

test("a review whose start is still in flight when the row unloads is stopped, not registered", async () => {
	// The pre-registration window: `subagents.start` has not resolved yet, so the
	// coordinator's `children` and the row's `liveReviews` are both still empty.
	// A dispose here must not leave the child to appear afterwards with nothing
	// enforcing its budgets or recording its cost.
	const mounted = await mountSkills({
		skills: { reviewProvider: "p", reviewModel: "cheap" },
		holdRuns: true,
		holdStart: true,
	});
	const service = serviceOf(mounted);
	void dispatch(service, "refine", [{ id: "agent-7" }, ""]);
	await settle();
	assert.equal(mounted.started.length, 0, "the start must still be in flight");

	await mounted.dispose();
	// Only now does the run come back — after the row was told to unload.
	mounted.releaseStart();
	await settle();
	assert.equal(mounted.witness.signals[0]?.aborted, true, "the late run must be cancelled");
	assert.deepEqual(mounted.witness.disposed, ["child-1"], "and disposed rather than registered");
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

test("a project promotion is reported as its own tier, not as global", async () => {
	// Both `global` and `project:<path>` skills are served by the promoted
	// provider, so a row that inferred the tier from the provider would answer
	// "global" for a project skill — contradicting the very message that says
	// "now visible to project:...". The tier comes from the document.
	const mounted = await mountSkills();
	await writeSkill(mounted, "path-skill", "project: /srv/app");
	await writeSkill(mounted, "open-skill", "global");
	const skills = (await dispatch(serviceOf(mounted), "listSkills", [])) as Record<string, unknown>[];
	assert.equal(skills.find((entry) => entry["name"] === "path-skill")?.["visibility"], "project: /srv/app");
	assert.equal(skills.find((entry) => entry["name"] === "open-skill")?.["visibility"], "global");
	// And a promotion really reports what it wrote.
	const promoted = (await dispatch(serviceOf(mounted), "visibility", ["path-skill", "project:/srv/other"])) as {
		success: boolean;
		message: string;
		skills: Record<string, unknown>[];
	};
	assert.equal(promoted.success, true, promoted.message);
	assert.equal(
		promoted.skills.find((entry) => entry["name"] === "path-skill")?.["visibility"],
		"project:/srv/other",
	);
});

test("an unknown tier or a malformed name in the document reads as buddy and the directory", async () => {
	// The panel is what a human acts on, so a listing row must agree with the
	// providers' own validation (Task 9) rather than echo whatever the document
	// says. An unrecognized tier is not a tier; a name the registry would reject
	// is not a name.
	const mounted = await mountSkills();
	await mkdir(join(mounted.skillsRoot, "dir-name"), { recursive: true });
	await writeFile(
		join(mounted.skillsRoot, "dir-name", "SKILL.md"),
		'---\nname: Not A Valid Name\ndescription: Use when the document is odd.\nvisibility: superuser\n---\n\nBody.\n',
		"utf8",
	);
	await writeSkill(mounted, "ok-skill");

	const skills = (await dispatch(serviceOf(mounted), "listSkills", [])) as Record<string, unknown>[];
	const odd = skills.find((entry) => entry["name"] === "dir-name");
	if (odd === undefined) assert.fail("the directory name is the fallback address");
	assert.equal(odd["visibility"], "buddy", "an unknown tier fails closed, as the providers do");
	const listed = skills.find((entry) => entry["name"] === "ok-skill");
	assert.equal(listed?.["visibility"], "buddy");
	// A valid frontmatter name still wins over the directory name.
	await mkdir(join(mounted.skillsRoot, "dir-other"), { recursive: true });
	await writeFile(
		join(mounted.skillsRoot, "dir-other", "SKILL.md"),
		'---\nname: proper-name\ndescription: Use when names matter.\n---\n\nBody.\n',
		"utf8",
	);
	const again = (await dispatch(serviceOf(mounted), "listSkills", [])) as Record<string, unknown>[];
	assert.equal(again.some((entry) => entry["name"] === "proper-name"), true);
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
