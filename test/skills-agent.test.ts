/**
 * Task 14: the buddy preset's skills row, mounted on a real cordis context.
 *
 * This row is the phase's structural isolation task. `dsh-buddy/skills` owns the
 * *state* — the skills root, the three domain tables, the review coordinator, the
 * write path's jurisdiction — but every contribution the buddy sessions actually
 * see is registered from **this** row's own `ctx`, because cordis files a
 * registration into the layer of the calling context's scope. Registered from a
 * host row instead, the provider, the `skill_manage` tool, the event listeners
 * and the `refine` command would land in the global layer and every ordinary
 * coding session would see Buddy's skills. That is the exact failure this phase
 * exists to prevent, and it is why the row declares **no** `inject`: it must
 * mount inside the preset even when the host row is absent, degrading to a silent
 * no-op rather than blocking the preset's mount.
 *
 * The harness mounts the **real** `dsh-buddy/skills` row over an in-memory store
 * and provides the three registries as siblings of a shared context — exactly
 * the shape a preset's standing composition gives the row. The registries are
 * recording fakes because `dsh-skill` / `dsh-commands` are not in this package's
 * dependency closure (`dsh-tools` is, but only for its `defineTool`, which the
 * real tool definition below is built by), while the host service is the real
 * one: `manage` writes real files, records a real ledger entry and bumps the real
 * usage table. The calls the row makes into that service are observed on
 * `BuddySkillsService.prototype`, so what the test counts is the call the row
 * really made rather than a stub's stand-in.
 *
 * Four claims can only fail for their own reason:
 *
 * 1. **A missing host row is a total no-op.** The preset must still mount — the
 *    persona, the shell tools and the rest of the composition are unaffected —
 *    and contribute nothing at all, not throw.
 * 2. **The tool routes the write through the service.** The action set is the
 *    host row's own `SKILL_MANAGE_ACTIONS`, and a write that bypassed
 *    `BuddySkillsService.manage` would skip the ledger, the snapshots and the
 *    jurisdiction guard.
 * 3. **The registry's catalog is invalidated after a successful write.** A newly
 *    created skill stays invisible until `control.invalidate()` runs, and the
 *    factory's control is the **only** invalidation entry point: there is no
 *    public `ctx.skills.invalidate()`. A row that forgets it passes every other
 *    assertion here.
 * 4. **Unmounting releases every registration.** Registration is effect, and the
 *    fake registries throw on a duplicate name, so a second mount after a
 *    dispose can only succeed if the first mount's disposers really ran.
 * @module test/skills-agent
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import type { KvTable } from "@deepseek-ai/dsh-storage-domain";
import { FALLBACK_CONFIG, type BuddyConfig } from "../src/config.ts";
import { resolveBuddyPaths } from "../src/paths.ts";
import * as agentRow from "../src/skills-agent/index.ts";
import * as skillsRow from "../src/skills/index.ts";
import { BUDDY_SKILLS_SERVICE } from "../src/skills/gateway.ts";
import { BuddySkillsService } from "../src/skills/index.ts";
import type { ReviewUsageRecord, SkillLedgerRecord, SkillUsageRecord } from "../src/store/domain.ts";
import { tableStub } from "./support/domain-tables.ts";
import { holdDshHome } from "./support/dsh-home-hold.ts";

/**
 * The file's `$DSH_HOME` hold.
 *
 * This harness mounts the *skills* row over an in-memory store rather than the
 * real store row, so nothing here should ever resolve the ambient home. The hold
 * is kept anyway: it costs one throwaway directory and it makes "this suite can
 * never write into the user's real install" a property of the file rather than a
 * property of the store row's current implementation — which is what an earlier
 * task in this phase got wrong.
 */
const dshHomeHold = holdDshHome();

/** One recorded session event, as `session/event` carries it. */
interface RecordedEvent {
	readonly type: string;
	readonly seq: number;
	readonly time: number;
	readonly data: unknown;
}

/** The live Agent one tool call claims to run for, reduced to the id the seam reads. */
interface TestAgent {
	readonly id: string;
}

/** One registered command definition, as the row handed it over. */
interface RegisteredCommand {
	readonly name: string;
	readonly description: string;
	handler(invocation: { agent: TestAgent; rawInput: string }): unknown;
}

/** One tool definition, as the fake `tools` registry holds it. */
interface RegisteredTool {
	readonly name: string;
	execute(args: unknown, exec: unknown): Promise<unknown>;
}

/** One service call the row made, with the arguments it passed. */
interface ServiceCall {
	readonly method: string;
	readonly args: readonly unknown[];
}

/** The control the `skills` registry hands one provider factory. */
interface ProviderControl {
	readonly signal: AbortSignal;
	invalidate(): void;
}

/** What one mount hands back to its tests. */
interface Mounted {
	/** The skills root under the buddy home this mount resolved. */
	readonly skillsRoot: string;
	/** The `buddySkills` service the context publishes, or `undefined` when the host row is absent. */
	skills(): unknown;
	/** Every provider registered into the shared `skills` registry, in order. */
	providerNames(): string[];
	/** The control the registry handed one provider factory, by provider name. */
	controlFor(provider: string): ProviderControl | undefined;
	/** How many times any provider's `control.invalidate()` has been called. */
	invalidations(): number;
	/** Every tool name registered into the shared `tools` registry, in order. */
	toolNames(): string[];
	/** Drive one registered tool the way the registry's dispatch would. */
	callTool(name: string, args: unknown, agent: TestAgent | undefined): Promise<unknown>;
	/** Every command name registered into the shared `commands` registry, in order. */
	commandNames(): string[];
	/** Invoke one registered command with a raw invocation. */
	callCommand(name: string, invocation: { agent: TestAgent; rawInput: string }): Promise<unknown>;
	/** Emit one `session/event` to the graph, as a committed append does. */
	emitSessionEvent(sessionId: string, event: RecordedEvent): void;
	/** Emit one `tools/post-execute` and wait for every listener. */
	emitPostExecute(exec: { name: string; arguments: unknown; agent?: TestAgent }): Promise<void>;
	/** Every `BuddySkillsService` call this mount made, in order. */
	readonly calls: readonly ServiceCall[];
	/** The `skill_usage` table this mount's host row writes through. */
	readonly usage: Map<string, SkillUsageRecord>;
	/** The `skill_ledger` table this mount's host row records into. */
	readonly ledger: Map<string, SkillLedgerRecord>;
	/** Unmount the rows this mount added, the way a preset reload does. */
	dispose(): Promise<void>;
}

/** How one mount differs from the default. */
interface MountOptions {
	/** Reuse a previously built harness instead of creating a fresh context. */
	readonly harness?: Harness;
}

/** The shared context and registries every mount in this suite contributes to. */
interface Harness {
	/** The root context, which also hosts the recording registries. */
	readonly root: {
		plugin(plugin: unknown): { dispose(): Promise<void> };
		emit(name: string, ...args: unknown[]): unknown;
		get(name: string): unknown;
	};
	/** The `skill_usage` table this harness's host row writes through. */
	readonly usage: Map<string, SkillUsageRecord>;
	/** The `skill_ledger` table this harness's host row records into. */
	readonly ledger: Map<string, SkillLedgerRecord>;
	/** The registry records, shared across mounts so a leak is observable. */
	readonly providerNames: string[];
	readonly controls: Map<string, ProviderControl>;
	/** Mutable so the counter can be read after a write. */
	readonly counters: { invalidations: number };
	readonly toolNames: string[];
	readonly tools: Map<string, RegisteredTool>;
	readonly commandNames: string[];
	readonly commands: Map<string, RegisteredCommand>;
	/** Every mounted fiber, disposed in reverse order. */
	readonly fibers: { dispose(): Promise<void> }[];
	/** The home the store resolves; one per harness. */
	readonly home: string;
	/** The paths under that home. */
	readonly paths: ReturnType<typeof resolveBuddyPaths>;
}

/** Every harness this file built, so the file-scope teardown can remove them. */
const harnesses: Harness[] = [];
/** The service calls every mount recorded, keyed by the mount's own array. */
const spies: { restore: () => void }[] = [];

/**
 * Spin the event loop until `predicate` holds.
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
 * Give cordis and every pending microtask chain room to run.
 * @returns resolution after several event-loop turns.
 */
async function settle(): Promise<void> {
	for (let turn = 0; turn < 8; turn += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

/**
 * The recording registries one context was given.
 *
 * Shared with the helper below so the layering test can stand up a *second*
 * context with its own registries while every assertion keeps reading the same
 * fields.
 */
interface RegistryRecords {
	readonly providerNames: string[];
	readonly controls: Map<string, ProviderControl>;
	readonly counters: { invalidations: number };
	readonly toolNames: string[];
	readonly tools: Map<string, RegisteredTool>;
	readonly commandNames: string[];
	readonly commands: Map<string, RegisteredCommand>;
}

/**
 * Provide the three registries on one context, recording everything registered.
 *
 * `dsh-skill` / `dsh-commands` are not in this package's dependency closure, so
 * these are fakes — but they enforce the shipped contract that matters here: a
 * duplicate name in one layer throws (so a leaked registration is visible), and
 * every `register`/`registerProvider` answers the disposer that unregisters.
 * @param sibling - the caller's plugin mounter for this context.
 * @param give - the caller's service provider for this context.
 * @param records - where the registrations are recorded.
 */
function provideRegistries(
	sibling: (pluginName: string, provide: (ctx: unknown) => void) => void,
	give: (ctx: unknown, key: string, value: unknown) => void,
	records: RegistryRecords,
): void {
	const { providerNames, controls, counters, toolNames, tools, commandNames, commands } = records;
	sibling("fake-skills", (ctx) =>
		give(ctx, "skills", {
			registerProvider: (create: (control: ProviderControl) => { readonly name: string }) => {
				const control: ProviderControl = {
					signal: new AbortController().signal,
					invalidate: (): void => {
						counters.invalidations += 1;
					},
				};
				const provider = create(control);
				// A duplicate in one layer throws in the real registry, and that is
				// what makes a leaked registration from an earlier mount visible.
				if (providerNames.includes(provider.name)) {
					throw new Error(`a provider named '${provider.name}' is already registered in this layer`);
				}
				providerNames.push(provider.name);
				controls.set(provider.name, control);
				return () => {
					const at = providerNames.indexOf(provider.name);
					if (at !== -1) providerNames.splice(at, 1);
					controls.delete(provider.name);
				};
			},
		}),
	);
	sibling("fake-tools", (ctx) =>
		give(ctx, "tools", {
			register: (definition: RegisteredTool) => {
				if (tools.has(definition.name)) throw new Error(`duplicate tool '${definition.name}' in this layer`);
				toolNames.push(definition.name);
				tools.set(definition.name, definition);
				return () => {
					tools.delete(definition.name);
					const at = toolNames.indexOf(definition.name);
					if (at !== -1) toolNames.splice(at, 1);
				};
			},
		}),
	);
	sibling("fake-commands", (ctx) =>
		give(ctx, "commands", {
			register: (definition: RegisteredCommand) => {
				if (commands.has(definition.name)) throw new Error(`duplicate command '${definition.name}'`);
				commandNames.push(definition.name);
				commands.set(definition.name, definition);
				return () => {
					commands.delete(definition.name);
					const at = commandNames.indexOf(definition.name);
					if (at !== -1) commandNames.splice(at, 1);
				};
			},
		}),
	);
}

/**
 * Build one shared context carrying the store and the three recording registries.
 *
 * The registries are siblings of the rows, not arguments to them, because that
 * is what a standing composition supplies: the row resolves them with `ctx.get`.
 * They are **shared per harness** so that a registration the first mount leaked
 * is still visible to — and rejected by — the second.
 * @returns the harness, with its host row already mounted.
 */
async function createHarness(options: { withHostRow?: boolean } = {}): Promise<Harness> {
	const home = await mkdtemp(join(tmpdir(), "dsh-buddy-skills-agent-"));
	const paths = resolveBuddyPaths(home);
	// The host row's write path creates this lazily in production; a real mount
	// over a real store finds it already made by the store's boot.
	await mkdir(paths.skills, { recursive: true });

	const usageTable = tableStub<SkillUsageRecord>();
	const ledgerTable = tableStub<SkillLedgerRecord>();
	const reviewTable = tableStub<ReviewUsageRecord>();
	const config: BuddyConfig = { ...FALLBACK_CONFIG, home };

	const providerNames: string[] = [];
	const controls = new Map<string, ProviderControl>();
	const counters = { invalidations: 0 };
	const toolNames: string[] = [];
	const tools = new Map<string, RegisteredTool>();
	const commandNames: string[] = [];
	const commands = new Map<string, RegisteredCommand>();

	/** The exactly-shaped slice of `ctx.buddyStore` the host row reads. */
	const store = {
		paths,
		config: (): BuddyConfig => config,
		skillUsage: (): KvTable<string, SkillUsageRecord> => usageTable,
		skillLedger: (): KvTable<string, SkillLedgerRecord> => ledgerTable,
		reviewUsage: (): KvTable<string, ReviewUsageRecord> => reviewTable,
		presetOwnership: async (): Promise<"plugin" | "user" | "adopted"> => "plugin",
	};

	const root = new Context() as unknown as Harness["root"];
	const fibers: { dispose(): Promise<void> }[] = [];
	const sibling = (pluginName: string, provide: (ctx: unknown) => void): void => {
		fibers.push(root.plugin({ name: pluginName, apply: (ctx: unknown) => provide(ctx) }));
	};
	const give = (ctx: unknown, key: string, value: unknown): void => {
		(ctx as { reflect: { provide(name: string, value: unknown): void } }).reflect.provide(key, value);
	};
	sibling("fake-store", (ctx) => give(ctx, "buddyStore", store));
	provideRegistries(
		sibling,
		give,
		{ providerNames, controls, counters, toolNames, tools, commandNames, commands },
	);

	// The **real** host row over the in-memory store: this is what makes
	// `manage`, `noteStep`, `onTurnEnd` and `noteSkillUsed` real calls rather
	// than stubs. Only the tables and the paths are faked.
	if (options.withHostRow !== false) {
		fibers.push(root.plugin({ name: skillsRow.name, inject: skillsRow.inject, apply: skillsRow.apply }));
		await until(() => root.get(BUDDY_SKILLS_SERVICE) !== undefined);
	}

	const harness: Harness = {
		root,
		usage: usageTable.rows,
		ledger: ledgerTable.rows,
		providerNames,
		controls,
		counters,
		toolNames,
		tools,
		commandNames,
		commands,
		fibers,
		home,
		paths,
	};
	harnesses.push(harness);
	return harness;
}

/**
 * One fully independent scope: its own root context, store and registries.
 *
 * Independent rather than a child of a shared root on purpose. A child inherits
 * its parent's services, so a row mounted on a child could resolve a registry
 * that only the *parent* provided — and a test built that way could not tell the
 * row's own registry from one it was never handed. Two roots share nothing, so
 * anything that reaches the other one reached it through an ambient path.
 * @param label - a name for the temp directory and the row fibers.
 * @param options - `withRegistries: false` leaves the scope with only a store.
 * @returns the scope, its records and its teardown.
 */
async function independentScope(
	label: string,
	options: { withRegistries?: boolean } = {},
): Promise<{
	root: {
		plugin(plugin: unknown): { dispose(): Promise<void> };
		emit(name: string, ...args: unknown[]): unknown;
		get(name: string): unknown;
	};
	records: RegistryRecords;
	calls: ServiceCall[];
	mount(row: { name: string; inject?: string[]; apply: (ctx: never) => void }): void;
	/** The mounted fibers, oldest first, so a test can unmount the newest alone. */
	fibers(): { dispose(): Promise<void> }[];
	dispose(): Promise<void>;
}> {
	const home = await mkdtemp(join(tmpdir(), `dsh-buddy-skills-agent-${label}-`));
	const paths = resolveBuddyPaths(home);
	await mkdir(paths.skills, { recursive: true });
	const usageTable = tableStub<SkillUsageRecord>();
	const ledgerTable = tableStub<SkillLedgerRecord>();
	const reviewTable = tableStub<ReviewUsageRecord>();
	const config: BuddyConfig = { ...FALLBACK_CONFIG, home };
	const store = {
		paths,
		config: (): BuddyConfig => config,
		skillUsage: (): KvTable<string, SkillUsageRecord> => usageTable,
		skillLedger: (): KvTable<string, SkillLedgerRecord> => ledgerTable,
		reviewUsage: (): KvTable<string, ReviewUsageRecord> => reviewTable,
		presetOwnership: async (): Promise<"plugin" | "user" | "adopted"> => "plugin",
	};
	const root = new Context() as unknown as {
		plugin(plugin: unknown): { dispose(): Promise<void> };
		emit(name: string, ...args: unknown[]): unknown;
		get(name: string): unknown;
	};
	const fibers: { dispose(): Promise<void> }[] = [];
	const sibling = (pluginName: string, provide: (ctx: unknown) => void): void => {
		fibers.push(root.plugin({ name: pluginName, apply: (ctx: unknown) => provide(ctx) }));
	};
	const give = (ctx: unknown, key: string, value: unknown): void => {
		(ctx as { reflect: { provide(name: string, value: unknown): void } }).reflect.provide(key, value);
	};
	sibling("fake-store", (ctx) => give(ctx, "buddyStore", store));
	const records: RegistryRecords = {
		providerNames: [],
		controls: new Map<string, ProviderControl>(),
		counters: { invalidations: 0 },
		toolNames: [],
		tools: new Map<string, RegisteredTool>(),
		commandNames: [],
		commands: new Map<string, RegisteredCommand>(),
	};
	if (options.withRegistries !== false) provideRegistries(sibling, give, records);
	return {
		root,
		records,
		calls: [],
		mount: (row) => {
			fibers.push(root.plugin({ name: row.name, inject: row.inject ?? [], apply: row.apply }));
		},
		fibers: () => fibers,
		dispose: async () => {
			for (const fiber of [...fibers].reverse()) await fiber.dispose();
			await rm(home, { recursive: true, force: true });
		},
	};
}

/**
 * Mount the agent row on a harness, recording every service call it makes.
 * @param options - whether to mount the host row and which harness to reuse.
 * @returns everything the test observes from outside the plugins.
 */
async function mountAgentRow(options: MountOptions = {}): Promise<Mounted> {
	const harness = options.harness ?? (await createHarness());
	const calls: ServiceCall[] = [];
	// The calls are observed on the class the context publishes, so what is
	// counted is the row's own call — not a fake standing in for the service.
	const spy = spyOnService(calls);
	spies.push(spy);

	const before = harness.fibers.length;
	// The row under test. No `inject` is passed because the row exports none:
	// that absence is the point, and cordis mounting a row whose service is
	// missing is exactly the no-op case exercised below.
	harness.fibers.push(
		harness.root.plugin({
			name: agentRow.name,
			apply: (agentRow as { apply: (ctx: never) => void }).apply,
		}),
	);
	await settle();

	const own = harness.fibers.slice(before);
	return {
		skillsRoot: harness.paths.skills,
		skills: () => harness.root.get(BUDDY_SKILLS_SERVICE),
		providerNames: () => [...harness.providerNames],
		controlFor: (provider) => harness.controls.get(provider),
		invalidations: () => harness.counters.invalidations,
		toolNames: () => [...harness.toolNames],
		commandNames: () => [...harness.commandNames],
		callTool: async (name, args, agent) => {
			const definition = harness.tools.get(name);
			if (definition === undefined) assert.fail(`tool '${name}' was never registered`);
			return await definition.execute(args, {
				callId: "call-1",
				rootCallId: "call-1",
				name,
				arguments: args,
				agent,
				signal: new AbortController().signal,
				token: {},
			});
		},
		callCommand: async (name, invocation) => {
			const definition = harness.commands.get(name);
			if (definition === undefined) assert.fail(`command '${name}' was never registered`);
			return await definition.handler(invocation);
		},
		emitSessionEvent: (sessionId, event) => {
			harness.root.emit("session/event", { header: { id: sessionId } }, event);
		},
		emitPostExecute: async (exec) => {
			await harness.root.emit("tools/post-execute", exec, {}, async () => "accepted");
		},
		calls,
		usage: harness.usage,
		ledger: harness.ledger,
		dispose: async () => {
			// Newest first, which is the order a real unload takes. The harness's
			// own sibling fibers (the store and the registries) stay mounted: the
			// suite may mount the row again on top of them.
			for (const fiber of [...own].reverse()) await fiber.dispose();
			spy.restore();
		},
	};
}

/**
 * Record every `BuddySkillsService` method call made on the class's prototype.
 *
 * The service is handed out through a cordis proxy, so replacing a method on the
 * *instance* would fight the proxy's own dispatch. The prototype is the real
 * implementation both the proxy and a direct instance resolve, and the wrapper
 * delegates to the original, so the row's call still has its full effect — the
 * write really lands, the usage row really moves.
 * @param calls - the array the wrapper appends to.
 * @returns the spy, with the `restore` a test's teardown must call.
 */
function spyOnService(calls: ServiceCall[]): { restore: () => void } {
	const target = BuddySkillsService.prototype as unknown as Record<string, unknown>;
	const originals = new Map<string, unknown>();
	for (const method of Object.getOwnPropertyNames(target)) {
		const original = target[method];
		if (typeof original !== "function" || method === "constructor") continue;
		originals.set(method, original);
		target[method] = function (this: unknown, ...args: unknown[]): unknown {
			calls.push({ method, args });
			return (original as (...a: unknown[]) => unknown).apply(this, args);
		};
	}
	return {
		restore: () => {
			for (const [method, original] of originals) target[method] = original;
		},
	};
}

/** The agent every tool call in this suite runs for. */
const AGENT: TestAgent = { id: "s1" };

/** The file-scope teardown: every harness's fibers, then the ambient home back. */
after(async () => {
	for (const spy of spies) spy.restore();
	for (const harness of [...harnesses].reverse()) {
		for (const fiber of [...harness.fibers].reverse()) await fiber.dispose();
		await rm(harness.home, { recursive: true, force: true });
	}
	dshHomeHold.release();
});

test("the agent row names itself and declares no hard dependency", () => {
	assert.equal(agentRow.name, "dsh-buddy-skills-agent");
	// No `inject` export at all: the row has to mount inside the preset even
	// when the host skills row is absent, and an inject on a missing service
	// would leave the whole preset composition waiting instead.
	assert.equal((agentRow as { inject?: unknown }).inject, undefined);
});

test("the agent row registers a buddy-layer provider, the tool and the command", async () => {
	const scope = await mountAgentRow();
	assert.deepEqual(scope.providerNames(), ["buddy-skills", "buddy-promoted"]);
	assert.ok(scope.toolNames().includes("skill_manage"));
	assert.deepEqual(scope.commandNames(), ["refine"]);
	await scope.dispose();
});

test("without the host row the whole row is a silent no-op rather than a blocked mount", async () => {
	// The preset composition carries the persona, the shell tools and the rest;
	// a skills host row that is not installed must cost it nothing. "Registers
	// nothing" is the assertion — not "does not throw", which a row that
	// registered a broken provider would also satisfy.
	const bare = await harnessWithoutHostRow();
	const scope = await mountAgentRow({ harness: bare });
	assert.equal(scope.skills(), undefined);
	assert.deepEqual(scope.providerNames(), []);
	assert.deepEqual(scope.toolNames(), []);
	assert.deepEqual(scope.commandNames(), []);
	await scope.dispose();
});

test("step and turn events drive the coordinator through the host service", async () => {
	const scope = await mountAgentRow();
	scope.emitSessionEvent("s1", { type: "step/end", seq: 1, time: 1, data: {} });
	scope.emitSessionEvent("s1", {
		type: "turn/end",
		seq: 2,
		time: 2,
		data: { turn: 1, reason: { kind: "completed" } },
	});
	await settle();
	assert.equal(scope.calls.filter((call) => call.method === "noteStep").length, 1);
	assert.equal(scope.calls.filter((call) => call.method === "onTurnEnd").length, 1);
	// The session id travels as the header's, not as an invented field.
	assert.deepEqual(scope.calls.find((call) => call.method === "noteStep")?.args, ["s1"]);
	const ended = scope.calls.find((call) => call.method === "onTurnEnd")?.args[0] as { sessionId?: string };
	assert.equal(ended?.sessionId, "s1");
	await scope.dispose();
});

test("a session event that is neither a step nor a turn end is left alone", async () => {
	const scope = await mountAgentRow();
	scope.emitSessionEvent("s1", { type: "turn/start", seq: 1, time: 1, data: { turn: 1 } });
	scope.emitSessionEvent("s1", { type: "step/start", seq: 2, time: 2, data: { turn: 1, step: 1 } });
	await settle();
	// Mount already called `skillsRoot` and reported its own heartbeat; what this
	// asserts is that neither event type reached the coordinator.
	assert.deepEqual(
		scope.calls.filter((call) => call.method === "noteStep" || call.method === "onTurnEnd"),
		[],
	);
	await scope.dispose();
});

test("observing the skill loader bumps use and records a read mark", async () => {
	const scope = await mountAgentRow();
	await scope.emitPostExecute({ name: "skill", arguments: { name: "a-b" }, agent: AGENT });
	await settle();
	// One method does both halves of the observation (the brief's correction 2):
	// the usage bump and the read mark that read-before-write is judged against.
	const used = scope.calls.filter((call) => call.method === "noteSkillUsed");
	assert.deepEqual(used.map((call) => call.args), [["s1", "a-b"]]);
	const row = scope.usage.get("a-b");
	assert.notEqual(row, undefined, "the usage bump must have landed in the table");
	assert.equal(row?.use_count, 1);
	await scope.dispose();
});

test("a post-execute the listener does not own is passed straight through", async () => {
	const scope = await mountAgentRow();
	await scope.emitPostExecute({ name: "read", arguments: { path: "/x" }, agent: AGENT });
	await settle();
	assert.deepEqual(scope.calls.filter((call) => call.method === "noteSkillUsed"), []);
	await scope.dispose();
});

test("a skill load with no owning agent is still recorded as a read", async () => {
	const scope = await mountAgentRow();
	// The review's own child session has no live agent. The observation is still
	// the read mark the guard consults, and dropping it would refuse a write the
	// review was entitled to.
	await scope.emitPostExecute({ name: "skill", arguments: { name: "a-b" } });
	await settle();
	assert.deepEqual(
		scope.calls.filter((call) => call.method === "noteSkillUsed").map((call) => call.args),
		[["", "a-b"]],
	);
	await scope.dispose();
});

test("a non-string skill name in the loader's arguments is not recorded", async () => {
	const scope = await mountAgentRow();
	await scope.emitPostExecute({ name: "skill", arguments: { name: 42 }, agent: AGENT });
	await settle();
	assert.deepEqual(scope.calls.filter((call) => call.method === "noteSkillUsed"), []);
	await scope.dispose();
});

test("the tool resets the nudge counter and routes writes through the service", async () => {
	const scope = await mountAgentRow();
	const result = (await scope.callTool(
		"skill_manage",
		{ operations: [{ action: "create", name: "x-y", content: skillDocument("x-y") }] },
		AGENT,
	)) as { success: boolean; message: string };
	await settle();
	assert.deepEqual(
		scope.calls.filter((call) => call.method === "noteSkillManageCalled").map((call) => call.args),
		[["s1"]],
	);
	assert.equal(scope.calls.filter((call) => call.method === "manage").length, 1);
	// Routing through `manage` is what makes the write real: the ledger entry and
	// the file on disk exist only on that path.
	assert.equal(result.success, true, result.message);
	assert.match(await readFile(join(scope.skillsRoot, "x-y", "SKILL.md"), "utf8"), /# Body/);
	assert.equal(scope.ledger.size, 1);
	await scope.dispose();
});

test("a tool call with no owning agent is refused and never reaches the write path", async () => {
	const scope = await mountAgentRow();
	await assert.rejects(async () => {
		await scope.callTool(
			"skill_manage",
			{ operations: [{ action: "create", name: "x-y", content: skillDocument("x-y") }] },
			undefined,
		);
	});
	assert.deepEqual(scope.calls.filter((call) => call.method === "manage"), [], "an unattributable write must not run");
	assert.deepEqual(scope.calls.filter((call) => call.method === "noteSkillManageCalled"), []);
	await scope.dispose();
});

test("a successful write invalidates the registry's cached catalog", async () => {
	// The registry caches completed catalogs, and the factory's control is the
	// only invalidation entry point — there is no public `ctx.skills.invalidate`.
	// A row that skips this leaves every newly created skill invisible.
	const scope = await mountAgentRow();
	assert.equal(scope.invalidations(), 0, "nothing has been written yet");
	const result = (await scope.callTool(
		"skill_manage",
		{ operations: [{ action: "create", name: "x-y", content: skillDocument("x-y") }] },
		AGENT,
	)) as { success: boolean };
	assert.equal(result.success, true);
	assert.equal(scope.invalidations(), 1, "the written skill must become visible to the next catalog read");
	await scope.dispose();
});

test("a refused write does not invalidate the catalog", async () => {
	// The invalidation rides on a *successful* write: a refused batch changed
	// nothing, and forcing every consumer to re-read the catalog for it is the
	// cost the control exists to avoid.
	const scope = await mountAgentRow();
	const result = (await scope.callTool("skill_manage", { operations: [] }, AGENT)) as { success: boolean };
	assert.equal(result.success, false);
	assert.equal(scope.invalidations(), 0);
	await scope.dispose();
});

test("the refine command routes its agent and trimmed focus to the host service", async () => {
	const scope = await mountAgentRow();
	const result = await scope.callCommand("refine", { agent: { id: "agent-7" }, rawInput: "  house style  " });
	await settle();
	const refined = scope.calls.filter((call) => call.method === "refine");
	assert.equal(refined.length, 1);
	assert.equal((refined[0]?.args[0] as { id?: string } | undefined)?.id, "agent-7");
	assert.equal(refined[0]?.args[1], "house style");
	assert.deepEqual(result, { kind: "success", text: "Reviewing with focus: house style" });
	await scope.dispose();
});

test("the refine command with no focus still reviews the conversation", async () => {
	const scope = await mountAgentRow();
	const result = await scope.callCommand("refine", { agent: { id: "agent-7" }, rawInput: "" });
	await settle();
	assert.equal(scope.calls.filter((call) => call.method === "refine").length, 1);
	assert.deepEqual(result, { kind: "success", text: "Reviewing the conversation for skills" });
	await scope.dispose();
});

test("unmounting the agent row releases every registration it made", async () => {
	// Registration is effect: a preset reload must not leave a provider, a tool
	// or a command behind. The two mounts share **one** context, because that is
	// the only arrangement in which a leak is observable — the fake registries
	// throw on a duplicate name in one layer, so a second mount into the same
	// layer can only succeed if the first mount's disposers really ran. Two
	// separate contexts would hide a leak entirely: the stale registry would be
	// discarded along with its context.
	const scope = await independentScope("reload");
	scope.mount(skillsRow as never);
	await until(() => scope.root.get(BUDDY_SKILLS_SERVICE) !== undefined);

	scope.mount(agentRow as never);
	await settle();
	assert.deepEqual(scope.records.providerNames, ["buddy-skills", "buddy-promoted"]);
	assert.deepEqual(scope.records.toolNames, ["skill_manage"]);
	assert.deepEqual(scope.records.commandNames, ["refine"]);

	// Unmount only the agent row — the host row and the registries stay up, as
	// they do when a preset is reloaded inside a running harness.
	const fiber = scope.fibers().pop();
	if (fiber === undefined) assert.fail("the agent row's fiber must be the most recent mount");
	await fiber.dispose();

	assert.deepEqual(scope.records.providerNames, [], "a disposed registration must be gone from the registry");
	assert.deepEqual(scope.records.toolNames, []);
	assert.deepEqual(scope.records.commandNames, []);

	// And the same layer accepts the row again, which a leaked provider name
	// would have made throw.
	scope.mount(agentRow as never);
	await settle();
	assert.deepEqual(scope.records.providerNames, ["buddy-skills", "buddy-promoted"]);
	assert.deepEqual(scope.records.toolNames, ["skill_manage"]);
	assert.deepEqual(scope.records.commandNames, ["refine"]);

	await scope.dispose();
});

test("every registration is bound to the registries and service the row's own context carries", async () => {
	// This is the wiring the phase rests on, and the one failure a hand-written
	// `ctx` stub cannot show: the layer a contribution lands in is decided by
	// *which context the row is mounted on*, because cordis files a registration
	// into the calling context's layer. Two fully independent scopes — each with
	// its own store, its own registries and its own host row — make that
	// observable: the row is mounted on one, and both its registrations and the
	// service calls its listeners forward must land there. A module-level
	// registry, an ambient singleton or a hard-wired reference to some other
	// scope's host row would put the provider, the tool, the listeners and the
	// command in front of every ordinary coding session.
	const scope = await independentScope("bound");
	const outside = await independentScope("outside");
	const spy = spyOnService(scope.calls);
	spies.push(spy);

	scope.mount(skillsRow as never);
	await until(() => scope.root.get(BUDDY_SKILLS_SERVICE) !== undefined);
	scope.mount(agentRow as never);
	await settle();

	assert.deepEqual(scope.records.providerNames, ["buddy-skills", "buddy-promoted"], "both tiers belong here");
	assert.deepEqual(scope.records.toolNames, ["skill_manage"], "so does the tool");
	assert.deepEqual(scope.records.commandNames, ["refine"], "and the command");
	assert.deepEqual(outside.records.providerNames, [], "nothing may reach a registry the row was not handed");
	assert.deepEqual(outside.records.toolNames, []);
	assert.deepEqual(outside.records.commandNames, []);

	// The listener forwards to *this* scope's host service, and the session
	// event dispatched from this scope's own root reaches it.
	scope.root.emit("session/event", { header: { id: "s1" } }, { type: "step/end", seq: 1, time: 1, data: {} });
	await settle();
	assert.equal(scope.calls.filter((call: ServiceCall) => call.method === "noteStep").length, 1);

	await scope.dispose();
	await outside.dispose();
});

test("with no registries at all the row still mounts and contributes nothing", async () => {
	// The registries are soft like everything else this row reads. A profile
	// without a skills or tools plane must still mount the preset — the persona
	// and the shell tools are unaffected — and the row must not fall back to any
	// ambient registry to make up the difference.
	const scope = await independentScope("bare", { withRegistries: false });
	scope.mount(skillsRow as never);
	await until(() => scope.root.get(BUDDY_SKILLS_SERVICE) !== undefined);
	scope.mount(agentRow as never);
	await settle();
	// The host row is reachable and the row's heartbeat was recorded; the point
	// is that the *registries* were never touched, and mounting did not throw.
	assert.notEqual(scope.root.get(BUDDY_SKILLS_SERVICE), undefined);
	assert.deepEqual(scope.records.providerNames, []);
	await scope.dispose();
});

test("the provider factory receives the registration's own control", async () => {
	const scope = await mountAgentRow();
	const control = scope.controlFor("buddy-skills");
	assert.notEqual(control, undefined, "the factory must be called with the registry's control");
	assert.equal(typeof control?.invalidate, "function");
	assert.equal(control?.signal.aborted, false, "the control carries the registration's live abort signal");
	await scope.dispose();
});

test("the tool's action set is the host row's, and carries no visibility action", async () => {
	const scope = await mountAgentRow();
	// `visibility` is deliberately absent: only the panel can raise a skill's
	// scope. The row reuses the host row's exported list, so the two cannot drift.
	assert.deepEqual(
		[...skillsRow.SKILL_MANAGE_ACTIONS],
		["create", "patch", "edit", "delete", "write_file", "remove_file"],
	);
	assert.equal((skillsRow.SKILL_MANAGE_ACTIONS as readonly string[]).includes("visibility"), false);
	await scope.dispose();
});

test("a skill written through the tool is readable from the root the host row resolved", async () => {
	const scope = await mountAgentRow();
	await scope.callTool(
		"skill_manage",
		{ operations: [{ action: "create", name: "readable-skill", content: skillDocument("readable-skill") }] },
		AGENT,
	);
	await settle();
	assert.match(await readFile(join(scope.skillsRoot, "readable-skill", "SKILL.md"), "utf8"), /# Body/);
	// The tool reaches the same root the host row publishes, so a skill written
	// inside the preset is exactly the one the providers will discover.
	const service = scope.skills() as { listSkills: () => Promise<{ name: string }[]> };
	assert.equal(
		(await service.listSkills()).some((entry) => entry.name === "readable-skill"),
		true,
		"the write and the panel's own discovery must share one skills root",
	);
	await scope.dispose();
});

test("a malformed tool argument is rejected by the compiled schema, not by the write path", async () => {
	const scope = await mountAgentRow();
	// `defineTool` compiles the parameter schema and validates before `execute`,
	// so an argument the model got wrong never reaches the service at all.
	await assert.rejects(async () => {
		await scope.callTool("skill_manage", { operations: "not-an-array" }, AGENT);
	});
	assert.deepEqual(scope.calls.filter((call) => call.method === "manage"), []);
	await scope.dispose();
});

test("the host service exposes the skills root and the merged observation method", async () => {
	// `skillsRoot()` is what the preset row builds both providers over, and
	// `noteSkillUsed` replaces Task 13's read-only `noteSkillRead`, which had no
	// caller anywhere. Both are on the service the host row publishes.
	const scope = await mountAgentRow();
	const service = scope.skills() as Record<string, unknown>;
	assert.equal(typeof service["skillsRoot"], "function");
	assert.equal(typeof service["noteSkillUsed"], "function");
	assert.equal(service["noteSkillRead"], undefined, "the read-only half must not be left behind");
	assert.equal(scope.skillsRoot, (service["skillsRoot"] as () => string).call(service));
	await scope.dispose();
});

/**
 * Build a harness whose host skills row was never mounted.
 *
 * The registries and the store are still there — the preset's other rows would
 * be — so the only thing missing is `ctx.buddySkills`.
 * @returns the bare harness.
 */
async function harnessWithoutHostRow(): Promise<Harness> {
	return await createHarness({ withHostRow: false });
}

/**
 * One skill document, in the grammar the host row's write path accepts.
 * @param name - the skill name.
 * @returns the SKILL.md text.
 */
function skillDocument(name: string): string {
	return `---\nname: ${name}\ndescription: Use when ${name} matters.\n---\n\n# Body\n`;
}
