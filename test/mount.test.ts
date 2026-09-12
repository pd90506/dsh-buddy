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
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import * as storeRow from "../src/store/index.ts";
import * as personaRow from "../src/persona/index.ts";
import { BUDDY_PRESET_ID, SOUL_VARIABLE } from "../src/index.ts";
import { DEFAULT_SOUL } from "../src/persona/soul.ts";
import type { BuddySessionSummary, PersonaView } from "../src/persona/gateway.ts";

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
}

/** What the test observes from outside the plugins. */
interface Mounted {
	/** The buddy home the settings plane handed over. */
	readonly home: string;
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
	if (options.soulOnDisk !== undefined) await writeFile(join(home, "SOUL.md"), options.soulOnDisk, "utf8");

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
				hooks: { setSource(source: () => { home: string }): void; onChange(): void },
			) => {
				sections.push(ns);
				// `BuddyConfig` has exactly one field; emitting anything else here
				// would let a row read a setting the schema does not have.
				hooks.setSource(() => ({ home }));
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

	// Spread rather than passing the module namespace: namespace objects are
	// sealed, and cordis annotates the plugin object it is handed.
	const mountRow = (row: { name: string; inject: string[]; apply: (ctx: never) => void }): void => {
		root.plugin({ name: row.name, inject: row.inject, apply: row.apply });
	};
	mountRow(storeRow as never);
	mountRow(personaRow as never);
	await settle();
	return {
		home,
		persona: () => root.get("buddyPersona") as ServiceProxy | undefined,
		variables,
		firstValues,
		sections,
		contributions,
		provideSystemPrompt: systemPrompt,
	};
}

test("the persona row names itself and declares its three hard dependencies", () => {
	assert.equal(personaRow.name, "dsh-buddy-persona");
	// `systemPrompt` is hard, not soft: cordis's `get` is strict and answers
	// `undefined` unless the providing fiber is already active, so a row that
	// merely `get`s it at boot would register no variable at all — and every
	// buddy session would then fail assembly on `{{buddySoul}}`. Carrying the
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

test("the row puts exactly one typert contribution on the wire", async () => {
	const { contributions } = await mount();
	// The real registry rejects a second registration of the `dsh-buddy`
	// package, so a row that registers the contribution anywhere besides the
	// single gateway construction is a row that fails to mount in production.
	assert.equal(contributions.length, 1);
});

test("the buddySoul prompt variable is registered and never returns undefined", async () => {
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
	assert.equal(await readFile(join(mounted.home, "SOUL.md"), "utf8"), "Terse.");
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
		{ sessionId: "delta", title: "Delta", updatedAt: 20, cwd: "/d" },
		{ sessionId: "alpha", title: "Alpha", updatedAt: 10, cwd: "/a" },
		{ sessionId: "untitled", title: "", updatedAt: 0, cwd: "" },
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
