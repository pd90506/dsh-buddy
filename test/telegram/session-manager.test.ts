/**
 * The create/resume/adopt order, and what a new session starts from.
 *
 * Two rules are load-bearing here. A session already live in this process must be
 * adopted through `agents.get` — resuming it would reject with
 * `SessionAlreadyOwnedError`, because a live agent holds the single write handle
 * and the GUI shares this process. And a session created without `agentOptions`
 * has an empty model route, so the first turn would fail to resolve a provider.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager, type AgentLike, type SessionLike } from "../../src/telegram/session.ts";
import type { ChatRecord, TelegramStore } from "../../src/telegram/store.ts";

/** An agent stub good enough for the manager's bookkeeping. */
function agentStub(sessionId: string): AgentLike {
	const session: SessionLike = { id: sessionId, seq: 0, snapshotEvents: () => [] } as unknown as SessionLike;
	return {
		session,
		status: "idle",
		followup: () => undefined,
		steer: () => undefined,
		cancel: () => undefined,
		whenIdle: async () => undefined,
	} as unknown as AgentLike;
}

/** A storage stub recording writes. */
function storeStub(initial?: ChatRecord): { store: TelegramStore; records: Map<string, ChatRecord> } {
	const records = new Map<string, ChatRecord>();
	if (initial !== undefined) records.set("42", initial);
	const store = {
		chats: {
			get: (key: string) => records.get(key),
			put: async (key: string, value: ChatRecord) => {
				records.set(key, value);
			},
			delete: async (key: string) => records.delete(key),
		},
		global: { get: () => ({}), set: async () => undefined },
		close: async () => undefined,
	} as unknown as TelegramStore;
	return { store, records };
}

/** A preset roster stub recording what the manager asked for and mounted. */
interface PresetRecorder {
	readonly service: { readonly defaultId: string; resolve(id?: string): Promise<{ id: string }>; mount(agentCtx: unknown, id?: string): Promise<unknown> };
	readonly resolved: (string | undefined)[];
	readonly mounted: { agentCtx: unknown; id: string | undefined }[];
}

/** Build a roster stub that answers `id` (defaulting to `standard`). */
function presetStub(defaultId = "standard"): PresetRecorder {
	const resolved: (string | undefined)[] = [];
	const mounted: { agentCtx: unknown; id: string | undefined }[] = [];
	return {
		resolved,
		mounted,
		service: {
			defaultId,
			resolve: async (id?: string) => {
				resolved.push(id);
				return { id: id ?? defaultId };
			},
			mount: async (agentCtx: unknown, id?: string) => {
				mounted.push({ agentCtx, id });
				return {};
			},
		},
	};
}

/** A resume stub that hands back the agent and captures the setup hook. */
function resumeRecorder(agent: AgentLike): {
	resume(options: Record<string, unknown>): Promise<{ agent: AgentLike; dispose: () => void }>;
	hook(): (agentCtx: unknown, agent: unknown) => Promise<void>;
} {
	let captured: ((agentCtx: unknown, agent: unknown) => Promise<void>) | undefined;
	return {
		resume: async (options: Record<string, unknown>) => {
			captured = options["setup"] as (agentCtx: unknown, agent: unknown) => Promise<void>;
			return { agent, dispose: () => undefined };
		},
		hook: () => {
			assert.ok(captured !== undefined, "a resume must carry a setup hook");
			return captured;
		},
	};
}

/** The only context member the model-selection installer touches. */
function ctxStub(): Record<string, unknown> {
	return { on: () => () => undefined };
}

/** Dependencies with a plugin-style `get`. */
function deps(options: {
	store: TelegramStore;
	agents: Record<string, unknown>;
	defaults?: { provider: string; model: string } | undefined;
	presets?: Record<string, unknown> | undefined;
	log?: (line: string) => void;
}): ConstructorParameters<typeof SessionManager>[0] {
	return {
		get: (name: string) => {
			if (name === "agents") return options.agents;
			if (name === "agentPresets") return options.presets;
			if (name === "agentDefaultModel") {
				return options.defaults === undefined ? undefined : { currentSelection: () => options.defaults };
			}
			return undefined;
		},
		store: options.store,
		log: options.log ?? (() => undefined),
	};
}

/** An agent stub whose session header carries the durable preset record. */
function agentWithPreset(sessionId: string, preset: string | undefined): AgentLike {
	const session = {
		id: sessionId,
		seq: 0,
		snapshotEvents: () => [],
		header: preset === undefined ? { cwd: "/tmp/telegram-work" } : { cwd: "/tmp/telegram-work", agentPreset: preset },
	};
	return { ...agentStub(sessionId), session: session as unknown as SessionLike } as unknown as AgentLike;
}

test("a first contact creates a session with the default model and an absolute cwd", async () => {
	const created: Record<string, unknown>[] = [];
	const agents = {
		get: () => undefined,
		create: async (options: Record<string, unknown>) => {
			created.push(options);
			return { agent: agentStub(String(options["sessionId"])), dispose: () => undefined };
		},
		resume: async () => {
			throw new Error("resume must not be called when no binding is stored");
		},
	};
	const { store, records } = storeStub();
	const manager = new SessionManager(
		deps({ store, agents, defaults: { provider: "deepseek-official", model: "deepseek-flash" } }),
	);

	const resolved = await manager.ensure("42", "Test Chat", "/tmp/telegram-work");
	assert.equal(resolved.created, true);
	assert.deepEqual(created[0]?.["meta"], { cwd: "/tmp/telegram-work" });
	assert.deepEqual(created[0]?.["agentOptions"], { provider: "deepseek-official", model: "deepseek-flash" });
	assert.equal(typeof created[0]?.["setup"], "function");
	assert.equal(records.get("42")?.provider, "deepseek-official");
});

test("a new session is labelled so the GUI groups it recognizably (R7)", async () => {
	const renamed: { title: string }[] = [];
	const agents = {
		get: () => undefined,
		create: async (options: Record<string, unknown>) => ({
			agent: agentStub(String(options["sessionId"])),
			dispose: () => undefined,
		}),
		resume: async () => {
			throw new Error("unused");
		},
	};
	const { store } = storeStub();
	const base = deps({ store, agents });
	const manager = new SessionManager({
		...base,
		get: (name: string) => (name === "sessionTitle" ? { rename: (_s: unknown, title: string) => renamed.push({ title }) } : base.get(name)),
	});
	await manager.ensure("42", "Alice", "/tmp/telegram-work");
	assert.deepEqual(renamed, [{ title: "Telegram: Alice" }]);
});

test("a chat whose session is already live is adopted, never resumed", async () => {
	const live = agentStub("session-live");
	const agents = {
		get: () => live,
		create: async () => {
			throw new Error("create must not run for an existing binding");
		},
		resume: async () => {
			throw new Error("resume must not run for a live session");
		},
	};
	const { store } = storeStub({ sessionId: "session-live", updatedAt: "2026-09-10T00:00:00.000Z" });
	const manager = new SessionManager(deps({ store, agents }));

	const resolved = await manager.ensure("42", "Test Chat", "/tmp/telegram-work");
	assert.equal(resolved.created, false);
	assert.equal(String(resolved.sessionId), "session-live");
	assert.equal(resolved.agent, live);
});

test("a stored session that is gone from disk is replaced, not fatal", async () => {
	let resumed = 0;
	const agents = {
		get: () => undefined,
		resume: async () => {
			resumed += 1;
			throw Object.assign(new Error("not found"), { name: "SessionPersistenceNotFoundError" });
		},
		create: async (options: Record<string, unknown>) => ({
			agent: agentStub(String(options["sessionId"])),
			dispose: () => undefined,
		}),
	};
	const { store, records } = storeStub({ sessionId: "session-gone", updatedAt: "2026-09-10T00:00:00.000Z" });
	const manager = new SessionManager(deps({ store, agents }));

	const resolved = await manager.ensure("42", "Test Chat", "/tmp/telegram-work");
	assert.equal(resumed, 1);
	assert.equal(resolved.created, true);
	assert.notEqual(String(resolved.sessionId), "session-gone");
	assert.equal(records.get("42")?.sessionId, String(resolved.sessionId));
});

test("an unexpected resume failure is surfaced rather than silently replaced", async () => {
	const agents = {
		get: () => undefined,
		resume: async () => {
			throw new Error("corrupt log");
		},
		create: async () => {
			throw new Error("create must not run when resume failed unexpectedly");
		},
	};
	const { store } = storeStub({ sessionId: "session-broken", updatedAt: "2026-09-10T00:00:00.000Z" });
	const manager = new SessionManager(deps({ store, agents }));
	await assert.rejects(() => manager.ensure("42", "Test Chat", "/tmp/telegram-work"), /corrupt log/);
});

test("a chat-local model choice is stored without touching the global default", async () => {
	const agents = {
		get: () => agentStub("session-live"),
		create: async () => {
			throw new Error("unused");
		},
		resume: async () => {
			throw new Error("unused");
		},
	};
	const saved: unknown[] = [];
	const { store, records } = storeStub({ sessionId: "session-live", updatedAt: "2026-09-10T00:00:00.000Z" });
	const manager = new SessionManager({
		...deps({ store, agents, defaults: { provider: "deepseek-official", model: "deepseek-flash" } }),
		get: (name: string) => {
			if (name === "agents") return agents;
			if (name === "agentDefaultModel") {
				return {
					currentSelection: () => ({ provider: "deepseek-official", model: "deepseek-flash" }),
					saveSelection: (value: unknown) => {
						saved.push(value);
					},
				};
			}
			return undefined;
		},
	});
	const resolved = await manager.ensure("42", "Test Chat", "/tmp/telegram-work");
	await manager.setSelection("42", resolved, { provider: "deepseek-official", model: "deepseek-reasoner" });

	assert.equal(records.get("42")?.model, "deepseek-reasoner");
	assert.deepEqual(saved, [], "a chat-local switch must not write the global default");
});

test("a new session is composed from the deployment's default preset (R32)", async () => {
	const created: Record<string, unknown>[] = [];
	const agents = {
		get: () => undefined,
		create: async (options: Record<string, unknown>) => {
			created.push(options);
			return { agent: agentStub(String(options["sessionId"])), dispose: () => undefined };
		},
		resume: async () => {
			throw new Error("unused");
		},
	};
	const presets = presetStub();
	const { store } = storeStub();
	const manager = new SessionManager(deps({ store, agents, presets: presets.service }));

	await manager.ensure("42", "Test Chat", "/tmp/telegram-work");

	// The preset id is durable session metadata, so it is written at creation and
	// not re-derived on every resume.
	assert.deepEqual(created[0]?.["meta"], { cwd: "/tmp/telegram-work", agentPreset: "standard" });
	assert.deepEqual(presets.resolved, [undefined], "the configured default is resolved, not a hard-coded id");

	// The join happens inside the agent factory's setup hook — the one supported
	// call site — while the agent is still unpublished.
	const setup = created[0]?.["setup"] as (ctx: unknown, agent: unknown) => Promise<void>;
	const ctx = ctxStub();
	await setup(ctx, agentStub("session-new"));
	assert.deepEqual(presets.mounted, [{ agentCtx: ctx, id: "standard" }]);
});

test("a resumed session joins the preset its header recorded (R32)", async () => {
	const resumed = agentWithPreset("session-live", "standard");
	const recorder = resumeRecorder(resumed);
	const agents = {
		get: () => undefined,
		create: async () => {
			throw new Error("create must not run when a binding is stored");
		},
		resume: recorder.resume,
	};
	const presets = presetStub();
	const { store } = storeStub({ sessionId: "session-live", updatedAt: "2026-09-10T00:00:00.000Z" });
	const manager = new SessionManager(deps({ store, agents, presets: presets.service }));

	await manager.ensure("42", "Test Chat", "/tmp/telegram-work");
	// Drive the captured hook the way the factory does: with the resumed agent,
	// whose header names the preset the session was composed from.
	await recorder.hook()(ctxStub(), resumed);
	assert.deepEqual(presets.mounted.map((entry) => entry.id), ["standard"]);
});

test("a session created before presets existed is upgraded to the default (R32)", async () => {
	const legacy = agentWithPreset("session-legacy", undefined);
	const recorder = resumeRecorder(legacy);
	const agents = {
		get: () => undefined,
		create: async () => {
			throw new Error("unused");
		},
		resume: recorder.resume,
	};
	const presets = presetStub("standard");
	const { store } = storeStub({ sessionId: "session-legacy", updatedAt: "2026-09-10T00:00:00.000Z" });
	const manager = new SessionManager(deps({ store, agents, presets: presets.service }));

	await manager.ensure("42", "Test Chat", "/tmp/telegram-work");
	await recorder.hook()(ctxStub(), legacy);
	// Same behaviour as the GUI opening that session: the header says nothing, so
	// the deployment default applies.
	assert.deepEqual(presets.mounted.map((entry) => entry.id), ["standard"]);
});

test("a profile without the preset roster still creates sessions (R32)", async () => {
	const created: Record<string, unknown>[] = [];
	const agents = {
		get: () => undefined,
		create: async (options: Record<string, unknown>) => {
			created.push(options);
			return { agent: agentStub("session-plain"), dispose: () => undefined };
		},
		resume: async () => {
			throw new Error("unused");
		},
	};
	const { store } = storeStub();
	const manager = new SessionManager(deps({ store, agents }));
	const resolved = await manager.ensure("42", "Test Chat", "/tmp/telegram-work");

	assert.equal(resolved.created, true);
	assert.deepEqual(created[0]?.["meta"], { cwd: "/tmp/telegram-work" }, "no preset id is invented");
	const setup = created[0]?.["setup"] as (ctx: unknown, agent: unknown) => Promise<void>;
	await setup(ctxStub(), agentStub("session-plain"));
});

test("a failing preset mount surfaces as a creation failure (R32)", async () => {
	const created: Record<string, unknown>[] = [];
	const agents = {
		get: () => undefined,
		create: async (options: Record<string, unknown>) => {
			created.push(options);
			return { agent: agentStub(String(options["sessionId"])), dispose: () => undefined };
		},
		resume: async () => {
			throw new Error("unused");
		},
	};
	const presets = presetStub();
	const failing = {
		...presets.service,
		mount: async () => {
			throw new Error("preset broke");
		},
	};
	const { store } = storeStub();
	const manager = new SessionManager(deps({ store, agents, presets: failing }));
	const resolved = await manager.ensure("42", "Test Chat", "/tmp/telegram-work");
	assert.equal(resolved.created, true);

	// The join is installed while the agent is still unpublished, so a rejection
	// here rolls the whole creation back rather than publishing a bare agent.
	const setup = created[0]?.["setup"] as (ctx: unknown, agent: unknown) => Promise<void>;
	await assert.rejects(() => setup(ctxStub(), agentStub("session-x")), /preset broke/);
});

test("a profile without a preset roster says so in the log (R32)", async () => {
	const created: Record<string, unknown>[] = [];
	const logs: string[] = [];
	const agents = {
		get: () => undefined,
		create: async (options: Record<string, unknown>) => {
			created.push(options);
			return { agent: agentStub(String(options["sessionId"])), dispose: () => undefined };
		},
		resume: async () => {
			throw new Error("unused");
		},
	};
	const { store } = storeStub();
	const manager = new SessionManager(deps({ store, agents, log: (line) => logs.push(line) }));
	await manager.ensure("42", "Test Chat", "/tmp/telegram-work");
	assert.deepEqual(logs, [], "nothing is logged before the agent factory calls setup");

	// The hook is where the absence matters — an agent without a preset has no
	// tools beyond the host-scope ones — so it is where the line belongs.
	const setup = created[0]?.["setup"] as (ctx: unknown, agent: unknown) => Promise<void>;
	await setup(ctxStub(), agentStub("session-plain"));
	assert.equal(logs.length, 1);
	assert.match(logs[0] ?? "", /no roster/);
});
