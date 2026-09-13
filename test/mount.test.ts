/**
 * The mount test: both rows inside a real cordis app.
 *
 * A hand-written stub has no cordis rules — reading a service as a plain
 * property works there and throws in production. Here the services belong to
 * *sibling* fibers, which is what arms cordis's inject Guard and what makes a
 * late-arriving service plane observable at all: a plane that is merely
 * `ctx.provide`d on the root before the row mounts is already active, and a row
 * that reads it with the strict `ctx.get` would pass such a test while silently
 * registering nothing in a real boot.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import * as storeRow from "../src/store/index.ts";
import * as personaRow from "../src/persona/index.ts";
import { BUDDY_PRESET_ID, SOUL_VARIABLE } from "../src/index.ts";
import { DEFAULT_SOUL } from "../src/persona/soul.ts";
import { FALLBACK_CONFIG } from "../src/config.ts";
import type { BuddySessionSummary, PersonaView, PreferencesView } from "../src/persona/gateway.ts";

/** A prompt-variable provider, as `systemPrompt.variable` receives it. */
type VariableProvider = (context: unknown) => string | undefined;

/** A service as consumers reach it: a traceable proxy, never the instance. */
type ServiceProxy = Record<string, (...args: unknown[]) => unknown>;

/** The slice of a cordis `Context` this test drives. */
interface Host {
	get(name: string): unknown;
	plugin(plugin: unknown): unknown;
}

/** A session record as `sessionQuery.listSessions` returns it, trimmed to what the row reads. */
interface SessionStub {
	readonly header: { readonly id: string; readonly cwd?: string; readonly agentPreset?: string };
	/** Present so the row demonstrably ignores everything outside `header`. */
	readonly live: boolean;
}

/** How one mount differs from the default. */
interface MountOptions {
	/** Written to `SOUL.md` inside the buddy home *before* the rows mount. */
	readonly soulOnDisk?: string;
	/** Mount the `systemPrompt` plane beside the rows; default `true`. */
	readonly withSystemPrompt?: boolean;
	/** Mount the `sessionQuery` plane beside the rows; default `true`. */
	readonly withSessionQuery?: boolean;
	/** What `listSessions` answers. */
	readonly sessions?: readonly SessionStub[];
	/** Titles keyed by session id; a missing id means the session has no title. */
	readonly titles?: Readonly<Record<string, { title: string; updatedAt: number }>>;
	/**
	 * Mount a `buddyTelegram` sibling whose `telegramSessionIds()` answers these
	 * ids; omitted entirely (rather than an empty array) so a test can also cover
	 * the plane being absent altogether.
	 */
	readonly telegramSessionIds?: readonly string[];
	/** Mount the `workspaceRegistry` plane beside the rows; default `true`. */
	readonly withWorkspaceRegistry?: boolean;
	/** Session ids the workspace registry reports as already archived. */
	readonly archivedSessionIds?: readonly string[];
	/**
	 * Make `AGENTS.md` a named pipe instead of an ordinary file, *before* the
	 * rows mount. `readOr` (`src/persona/soul.ts`) blocks on `readFile` until a
	 * writer opens the other end, which is what lets a test hold the boot's
	 * initial persona read open and observe the wire while it is stuck there.
	 */
	readonly agentsIsFifo?: boolean;
}

/** What the test observes from outside the plugins. */
interface Mounted {
	/** The buddy home the settings plane handed over. */
	readonly home: string;
	/**
	 * The throwaway `$DSH_HOME` this mount ran under, captured before it was
	 * restored. The store row's boot installs the shipped preset under the
	 * *harness* home (`dshHomePath()`), independent of `home` above, so a test
	 * asserting on that install needs this path rather than `home`.
	 */
	readonly dshHome: string;
	/** The `buddyPersona` service, or `undefined` while the row is waiting. */
	persona(): ServiceProxy | undefined;
	/** Every registered prompt variable, by name. */
	readonly variables: Map<string, VariableProvider>;
	/** What each provider answered *at registration time*, before any await. */
	readonly firstValues: Map<string, string | undefined>;
	/** Settings namespaces installed. */
	readonly sections: string[];
	/** Every contribution handed to `typert.register`. */
	readonly contributions: unknown[];
	/** Mount the `systemPrompt` plane after the fact. */
	provideSystemPrompt(): void;
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
 * Give cordis and any pending microtask chain ample room to run, so a "nothing
 * happened" assertion is a real observation rather than one made too early.
 * @returns resolution after several event-loop turns.
 */
async function settle(): Promise<void> {
	for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setTimeout(resolve, 5));
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
 * Mount both rows beside sibling service plugins on a real context.
 * @param options - how this mount differs from the default.
 * @returns everything the test observes from outside the plugins.
 */
async function mount(options: MountOptions = {}): Promise<Mounted> {
	const home = await mkdtemp(join(tmpdir(), "dsh-buddy-mount-"));
	// Authored files live under `main/`; create it before seeding them, since the
	// store row's own `mkdir` has not run yet at fixture-build time.
	const main = join(home, "main");
	if (options.soulOnDisk !== undefined || options.agentsIsFifo === true) await mkdir(main, { recursive: true });
	if (options.soulOnDisk !== undefined) await writeFile(join(main, "SOUL.md"), options.soulOnDisk, "utf8");
	if (options.agentsIsFifo === true) execFileSync("mkfifo", [join(main, "AGENTS.md")]);

	// The store row's boot also installs the shipped preset under the *harness*
	// home, resolved independently of `home` above via `dshHomePath()` reading
	// `$DSH_HOME` at call time. Left unset, that call falls back to the real
	// `~/.dsh`: on this machine Task 9 already populated
	// `~/.dsh/.agent-presets/buddy/`, so the installer would silently return
	// "kept" and the suite would look clean while still reaching outside
	// itself; on a machine without that directory it would actually create
	// files there. Every mount in this suite must be hermetic.
	const previousDshHome = process.env["DSH_HOME"];
	const dshHome = await mkdtemp(join(tmpdir(), "dsh-buddy-mount-dsh-home-"));
	process.env["DSH_HOME"] = dshHome;

	try {
		const root = new Context() as unknown as Host;
		const sections: string[] = [];
		const contributions: unknown[] = [];
		const variables = new Map<string, VariableProvider>();
		const firstValues = new Map<string, string | undefined>();
		let global: Record<string, unknown> = {};

		const sibling = (pluginName: string, provide: (ctx: unknown) => void): void => {
			root.plugin({ name: pluginName, apply: (ctx: unknown) => provide(ctx) });
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
					close: async () => undefined,
				}),
				get: () => undefined,
			}),
		);
		sibling("fake-settings", (ctx) =>
			give(ctx, "settings", {
				installSection: (
					_owner: unknown,
					ns: string,
					_schema: unknown,
					_entry: unknown,
					hooks: { setSource(source: () => typeof FALLBACK_CONFIG): void; onChange(): void },
				) => {
					sections.push(ns);
					// Only `home` differs from the documented defaults: this stub
					// stands in for the real settings plane's schema resolution, and
					// `model`/`panel` must still come back complete for a row that
					// reads `ctx.buddyStore.config()` whole.
					hooks.setSource(() => ({ ...FALLBACK_CONFIG, home }));
				},
			}),
		);

		const systemPrompt = (): void =>
			sibling("fake-system-prompt", (ctx) =>
				give(ctx, "systemPrompt", {
					variable: (varName: string, provider: VariableProvider) => {
						variables.set(varName, provider);
						// Snapshot the answer *at registration*, which is strictly
						// before any asynchronous persona read can have landed.
						firstValues.set(varName, provider({}));
						return () => variables.delete(varName);
					},
				}),
			);
		if (options.withSystemPrompt !== false) systemPrompt();

		if (options.withSessionQuery !== false) {
			sibling("fake-session-query", (ctx) =>
				give(ctx, "sessionQuery", {
					listSessions: async (): Promise<readonly SessionStub[]> => options.sessions ?? [],
					readTitle: async (sessionId: string) => options.titles?.[sessionId],
				}),
			);
		}

		if (options.telegramSessionIds !== undefined) {
			sibling("fake-buddy-telegram", (ctx) =>
				give(ctx, "buddyTelegram", {
					telegramSessionIds: async () => options.telegramSessionIds ?? [],
				}),
			);
		}

		if (options.withWorkspaceRegistry !== false) {
			const archived = new Set<string>(options.archivedSessionIds ?? []);
			sibling("fake-workspace-registry", (ctx) =>
				give(ctx, "workspaceRegistry", {
					get archivedSessionIds(): readonly string[] {
						return [...archived];
					},
					archiveSession: async (sessionId: unknown) => {
						archived.add(String(sessionId));
					},
				}),
			);
		}

		// Spread rather than passing the module namespace: namespace objects are
		// sealed, and cordis annotates the plugin object it is handed.
		const mountRow = (row: { name: string; inject: string[]; apply: (ctx: never) => void }): void => {
			root.plugin({ name: row.name, inject: row.inject, apply: row.apply });
		};
		mountRow(storeRow as never);
		mountRow(personaRow as never);

		// `$DSH_HOME` must still be in effect at the moment the store row's boot
		// reads `dshHomePath()` (`src/store/index.ts:226-227`), and that read
		// happens strictly before `new BuddyStore(...)` publishes `buddyStore`
		// (the preset install is `await`ed first). Waiting on the *publish*,
		// rather than a fixed number of event-loop turns, is what makes this
		// observation rather than a race: on a loaded machine a fixed `settle()`
		// can resolve before the boot reaches that point, letting the restored
		// env var below (in `finally`) leak the real `~/.dsh` into `dshHomePath()`
		// instead. By the time `buddyStore` is observed, that read is already
		// behind us, so `$DSH_HOME` is safe to restore.
		await until(() => root.get("buddyStore") !== undefined);
		// The persona row depends on `buddyStore` but is not itself gated by
		// `$DSH_HOME`, so the remaining settle — giving its own mount, the
		// prompt-variable registration, and the typert contribution room to
		// land — does not need the real env var held any longer.
		await settle();
		return {
			home,
			dshHome,
			persona: () => root.get("buddyPersona") as ServiceProxy | undefined,
			variables,
			firstValues,
			sections,
			contributions,
			provideSystemPrompt: systemPrompt,
		};
	} finally {
		if (previousDshHome === undefined) delete process.env["DSH_HOME"];
		else process.env["DSH_HOME"] = previousDshHome;
	}
}

test("the persona row names itself and declares its three hard dependencies", () => {
	assert.equal(personaRow.name, "dsh-buddy-persona");
	// `systemPrompt` is hard, not soft: cordis's `get` is strict and answers
	// `undefined` unless the providing fiber is already active, so a row that
	// merely `get`s it at boot would register no variable at all — and every
	// buddy session would then fail assembly on `{{buddy_soul}}`. Carrying the
	// persona to the model is this row's entire purpose.
	assert.deepEqual(personaRow.inject, ["buddyStore", "typert", "systemPrompt"]);
});

test("both rows mount and publish their services", async () => {
	const persona = (await mount()).persona();
	assert.notEqual(persona, undefined, "the persona row must publish buddyPersona");
	for (const method of ["persona", "updatePersona", "sessions"]) {
		assert.equal(typeof persona?.[method], "function", `${method} must be callable through the service`);
	}
});

test("the store installs its settings section", async () => {
	const { sections } = await mount();
	assert.deepEqual(sections, ["buddy"]);
});

test("mounting the store row for real installs the shipped preset under the harness home", async () => {
	// This exercises `resolveTemplateDir` exactly as production does: the row
	// runs from `src/store/index.ts` here (same as it would from the built
	// `lib/store.js`), and a template path that silently didn't exist would be
	// swallowed by the boot's own `.catch` — passing this suite while never
	// actually installing anything. Reading the files back through the
	// filesystem, rather than trusting an in-memory return value, is what
	// would catch that regression.
	const { dshHome } = await mount();
	const presetDir = join(dshHome, ".agent-presets", "buddy");
	assert.deepEqual((await readdir(presetDir)).sort(), ["agent.cordis.yml", "preset.yml"]);
	assert.equal(await readFile(join(presetDir, "preset.yml"), "utf8"), await readFile(join("assets", "preset", "preset.yml"), "utf8"));
});

test("the row puts exactly one typert contribution on the wire", async () => {
	const { contributions } = await mount();
	// The real registry rejects a second registration of the `dsh-buddy`
	// package, so a row that registers the contribution anywhere besides the
	// single gateway construction is a row that fails to mount in production.
	assert.equal(contributions.length, 1);
});

test("the buddy_soul prompt variable is registered and never returns undefined", async () => {
	const { variables } = await mount();
	const provider = variables.get(SOUL_VARIABLE);
	assert.notEqual(provider, undefined, "the persona row must register the prompt variable");
	assert.equal(provider?.({}), DEFAULT_SOUL);
});

test("the prompt variable already has a non-empty value before the persona is read from disk", async () => {
	// The renderer throws on a referenced variable with no value for the
	// assembly, and an empty prefix shadows the deployment persona away without
	// putting anything in its place. The in-memory document starts empty, so the
	// boot window is exactly where a naive provider returns "" or `undefined`.
	const { firstValues } = await mount({ soulOnDisk: "Authored." });
	const first = firstValues.get(SOUL_VARIABLE);
	assert.equal(typeof first, "string", "the variable must answer from the very first assembly");
	assert.notEqual(first, "", "an empty soul would shadow the deployment persona with nothing");
});

test("the prompt variable serves the authored persona once it is read", async () => {
	const { variables } = await mount({ soulOnDisk: "Authored voice." });
	await until(() => variables.get(SOUL_VARIABLE)?.({}) === "Authored voice.");
	assert.equal(variables.get(SOUL_VARIABLE)?.({}), "Authored voice.");
});

test("the persona endpoint never answers with the pre-read placeholder", async () => {
	// `AGENTS.md` is a fifo: the boot's own `readOr` blocks on it until a writer
	// appears, which holds the initial disk read open for as long as this test
	// needs. An assertion made only after the window closes would prove nothing
	// about it — the defect this pins is exactly "the empty placeholder is
	// answered while the read is still in flight."
	const mounted = await mount({ soulOnDisk: "Authored voice.", agentsIsFifo: true });
	const persona = mounted.persona();
	if (persona === undefined) assert.fail("the persona row must publish buddyPersona");

	let settled: PersonaView | undefined;
	const pending = (dispatch(persona, "persona", []) as Promise<PersonaView>).then((view) => {
		settled = view;
		return view;
	});

	try {
		// The boot read cannot have landed yet — nothing has written to the fifo —
		// so the wire call above must still be unresolved rather than already
		// answering `{ soul: "", agents: "", home }`.
		await settle();
		assert.equal(settled, undefined, "persona() must not resolve before the initial disk read lands");
	} finally {
		// Unblock the boot's `readOr(agents)` unconditionally: with the fix
		// reverted this assertion throws before the fifo ever gets its writer,
		// and the boot's still-pending `readFile` on it would otherwise hold the
		// process open rather than letting the mutation surface as a clean fail.
		await writeFile(join(mounted.home, "main", "AGENTS.md"), "Rules.", "utf8");
	}

	const view = await pending;
	assert.equal(view.soul, "Authored voice.");
	assert.equal(view.agents, "Rules.");
});

test("the prompt variable is still registered when the systemPrompt plane arrives late", async () => {
	const mounted = await mount({ withSystemPrompt: false });
	await settle();
	// The hard dependency holds the whole row in waiting rather than letting it
	// boot half-mounted with no variable.
	// Compared as a boolean: a cordis service proxy throws out of the inspector
	// `node:assert` formats a failure diff with, which would replace this
	// assertion's message with an unrelated Guard error.
	assert.equal(mounted.persona() === undefined, true, "the row must wait for the systemPrompt plane");
	assert.equal(mounted.variables.size, 0);

	mounted.provideSystemPrompt();

	await until(() => mounted.variables.has(SOUL_VARIABLE));
	assert.equal(mounted.variables.get(SOUL_VARIABLE)?.({}), DEFAULT_SOUL);
	assert.notEqual(mounted.persona(), undefined, "the row must finish mounting once the plane appears");
});

test("a persona write reaches disk and the prompt variable without a remount", async () => {
	const mounted = await mount();
	const persona = mounted.persona();
	if (persona === undefined) assert.fail("the persona row must publish buddyPersona");
	assert.equal(mounted.variables.get(SOUL_VARIABLE)?.({}), DEFAULT_SOUL);

	const view = (await dispatch(persona, "updatePersona", [{ soul: "Terse." }])) as PersonaView;

	// Prompt assembly reads the in-memory snapshot, so a write that only landed
	// on disk would leave every running session on the stale voice.
	assert.equal(mounted.variables.get(SOUL_VARIABLE)?.({}), "Terse.");
	assert.equal(await readFile(join(mounted.home, "main", "SOUL.md"), "utf8"), "Terse.");
	assert.equal(view.soul, "Terse.");
	assert.equal(view.home, mounted.home);
	assert.equal(typeof view.lastWriteAt, "string", "the write must be recorded in the store");
});

test("only buddy sessions reach the panel, as owned summaries, newest first", async () => {
	const mounted = await mount({
		sessions: [
			{ header: { id: "alpha", cwd: "/a", agentPreset: BUDDY_PRESET_ID }, live: true },
			{ header: { id: "coding", cwd: "/c", agentPreset: "cordis" }, live: true },
			{ header: { id: "nameless", cwd: "/n" }, live: false },
			{ header: { id: "delta", cwd: "/d", agentPreset: BUDDY_PRESET_ID }, live: false },
			{ header: { id: "untitled", agentPreset: BUDDY_PRESET_ID }, live: false },
		],
		titles: { alpha: { title: "Alpha", updatedAt: 10 }, delta: { title: "Delta", updatedAt: 20 } },
	});
	const persona = mounted.persona();
	if (persona === undefined) assert.fail("the persona row must publish buddyPersona");

	const sessions = (await dispatch(persona, "sessions", [])) as BuddySessionSummary[];

	// `deepEqual` on the whole array is deliberate: it pins the filter, the
	// ordering, *and* that each summary is a small owned object built from leaf
	// fields — a spread of the live record would carry `header` and `live` here.
	assert.deepEqual(sessions, [
		{ sessionId: "delta", title: "Delta", updatedAt: 20, cwd: "/d", source: "web" },
		{ sessionId: "alpha", title: "Alpha", updatedAt: 10, cwd: "/a", source: "web" },
		{ sessionId: "untitled", title: "", updatedAt: 0, cwd: "", source: "web" },
	]);
});

test("sessions answers empty without a session-query plane", async () => {
	// `sessionQuery` is genuinely soft: a profile without it must still get a
	// mounted persona row, an empty list, and no throw.
	const mounted = await mount({ withSessionQuery: false });
	const persona = mounted.persona();
	if (persona === undefined) assert.fail("the persona row must publish buddyPersona");
	assert.deepEqual(await dispatch(persona, "sessions", []), []);
});

test("sessions are tagged by whether a Telegram chat created them", async () => {
	const mounted = await mount({
		sessions: [
			{ header: { id: "s-tg", cwd: "/a", agentPreset: BUDDY_PRESET_ID }, live: true },
			{ header: { id: "s-web", cwd: "/b", agentPreset: BUDDY_PRESET_ID }, live: true },
		],
		titles: {
			"s-tg": { title: "From Telegram", updatedAt: 10 },
			"s-web": { title: "From the web", updatedAt: 5 },
		},
		telegramSessionIds: ["s-tg"],
	});
	const persona = mounted.persona();
	if (persona === undefined) assert.fail("the persona row must publish buddyPersona");

	const sessions = (await dispatch(persona, "sessions", [])) as BuddySessionSummary[];

	assert.deepEqual(
		sessions.map((session) => [session.sessionId, session.source]),
		[
			["s-tg", "telegram"],
			["s-web", "web"],
		],
	);
});

test("sessions excludes conversations the workspace registry has archived", async () => {
	const mounted = await mount({
		sessions: [
			{ header: { id: "s-a", cwd: "/a", agentPreset: BUDDY_PRESET_ID }, live: true },
			{ header: { id: "s-b", cwd: "/b", agentPreset: BUDDY_PRESET_ID }, live: true },
		],
		titles: { "s-a": { title: "A", updatedAt: 2 }, "s-b": { title: "B", updatedAt: 1 } },
		archivedSessionIds: ["s-a"],
	});
	const persona = mounted.persona();
	if (persona === undefined) assert.fail("the persona row must publish buddyPersona");
	const sessions = (await dispatch(persona, "sessions", [])) as BuddySessionSummary[];
	assert.deepEqual(
		sessions.map((session) => session.sessionId),
		["s-b"],
		"an archived conversation must not appear in the list",
	);
});

test("archiveSession archives through the workspace registry, dropping it from the next list", async () => {
	const mounted = await mount({
		sessions: [
			{ header: { id: "s-a", cwd: "/a", agentPreset: BUDDY_PRESET_ID }, live: true },
			{ header: { id: "s-b", cwd: "/b", agentPreset: BUDDY_PRESET_ID }, live: true },
		],
		titles: { "s-a": { title: "A", updatedAt: 2 }, "s-b": { title: "B", updatedAt: 1 } },
	});
	const persona = mounted.persona();
	if (persona === undefined) assert.fail("the persona row must publish buddyPersona");
	const before = (await dispatch(persona, "sessions", [])) as BuddySessionSummary[];
	assert.deepEqual(before.map((session) => session.sessionId).sort(), ["s-a", "s-b"]);

	const after = (await dispatch(persona, "archiveSession", ["s-a"])) as BuddySessionSummary[];
	assert.deepEqual(after.map((session) => session.sessionId), ["s-b"], "the archived session drops from the returned list");
	const again = (await dispatch(persona, "sessions", [])) as BuddySessionSummary[];
	assert.deepEqual(again.map((session) => session.sessionId), ["s-b"], "and stays gone on the next read");
});

test("archiveSession without a workspace registry fails loudly", async () => {
	const mounted = await mount({
		withWorkspaceRegistry: false,
		sessions: [{ header: { id: "s-a", cwd: "/a", agentPreset: BUDDY_PRESET_ID }, live: true }],
	});
	const persona = mounted.persona();
	if (persona === undefined) assert.fail("the persona row must publish buddyPersona");
	await assert.rejects(async () => await dispatch(persona, "archiveSession", ["s-a"]), /workspace registry/);
});

test("sessions all report source web when the Telegram plane is absent", async () => {
	// `buddyTelegram` is soft and read at request time: a profile without the
	// Telegram row must still get a mounted persona row and a web-only list.
	const mounted = await mount({
		sessions: [
			{ header: { id: "s-tg", cwd: "/a", agentPreset: BUDDY_PRESET_ID }, live: true },
			{ header: { id: "s-web", cwd: "/b", agentPreset: BUDDY_PRESET_ID }, live: true },
		],
	});
	const persona = mounted.persona();
	if (persona === undefined) assert.fail("the persona row must publish buddyPersona");

	const sessions = (await dispatch(persona, "sessions", [])) as BuddySessionSummary[];

	assert.ok(sessions.length > 0);
	for (const session of sessions) assert.equal(session.source, "web");
});

test("preferences are served through the proxy with the conversation cwd", async () => {
	// `preferences()` derives the conversation cwd from the buddy home, so it lands
	// at `<home>/main/workspace` under this mount's throwaway home — no `$HOME`
	// isolation needed, and it never `mkdir`s inside the real account home.
	const mounted = await mount();
	const persona = mounted.persona();
	if (persona === undefined) assert.fail("the persona row must publish buddyPersona");
	const view = (await dispatch(persona, "preferences", [])) as PreferencesView;
	assert.equal(view.conversationCwd, join(mounted.home, "main", "workspace"));
	assert.deepEqual(view.panel, { sections: { soul: true, agents: true, model: true, telegram: true } });
});
