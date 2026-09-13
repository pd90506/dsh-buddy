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
function storeStub(initial?: ChatRecord): {
	store: TelegramStore;
	records: Map<string, ChatRecord>;
	origins: Map<string, { chatId: string; createdAt: string }>;
} {
	const records = new Map<string, ChatRecord>();
	if (initial !== undefined) records.set("42", initial);
	const origins = new Map<string, { chatId: string; createdAt: string }>();
	const store = {
		chats: {
			get: (key: string) => records.get(key),
			put: async (key: string, value: ChatRecord) => {
				records.set(key, value);
			},
			delete: async (key: string) => records.delete(key),
		},
		origins: {
			get: (key: string) => origins.get(key),
			put: async (key: string, value: { chatId: string; createdAt: string }) => {
				origins.set(key, value);
			},
			entries: () => origins.entries(),
		},
		global: { get: () => ({}), set: async () => undefined },
		close: async () => undefined,
	} as unknown as TelegramStore;
	return { store, records, origins };
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
	presetId?: string;
	buddyModel?: { provider: string; model: string } | undefined;
	log?: (line: string) => void;
	workspaceRegistry?: Record<string, unknown> | undefined;
}): ConstructorParameters<typeof SessionManager>[0] {
	return {
		get: (name: string) => {
			if (name === "agents") return options.agents;
			if (name === "agentPresets") return options.presets;
			if (name === "workspaceRegistry") return options.workspaceRegistry;
			if (name === "agentDefaultModel") {
				return options.defaults === undefined ? undefined : { currentSelection: () => options.defaults };
			}
			return undefined;
		},
		store: options.store,
		log: options.log ?? (() => undefined),
		presetId: options.presetId ?? "buddy",
		buddyModel: () => options.buddyModel,
	};
}

/** A workspace registry stub whose `create` returns a fixed path and records attach calls. */
function workspaceRegistryStub(
	path: string,
	options: { attachFails?: string } = {},
): {
	registry: { create(requestedPath: string): Promise<{ path: string; attachSession(sessionId: unknown): Promise<unknown> }> };
	createdWith: string[];
	attached: unknown[];
} {
	const createdWith: string[] = [];
	const attached: unknown[] = [];
	return {
		createdWith,
		attached,
		registry: {
			create: async (requestedPath: string) => {
				createdWith.push(requestedPath);
				return {
					path,
					attachSession: async (sessionId: unknown) => {
						attached.push(sessionId);
						if (options.attachFails !== undefined) throw new Error(options.attachFails);
					},
				};
			},
		},
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
		deps({
			store,
			agents,
			defaults: { provider: "deepseek-official", model: "deepseek-flash" },
			presets: presetStub().service,
		}),
	);

	const resolved = await manager.ensure("42", "Test Chat", "/tmp/telegram-work");
	assert.equal(resolved.created, true);
	assert.deepEqual(created[0]?.["meta"], { cwd: "/tmp/telegram-work", agentPreset: "buddy" });
	assert.deepEqual(created[0]?.["agentOptions"], { provider: "deepseek-official", model: "deepseek-flash" });
	assert.equal(typeof created[0]?.["setup"], "function");
	assert.equal(records.get("42")?.provider, "deepseek-official");
});

test("a new session is created inside its workspace and attached to it (R7)", async () => {
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
	const { store } = storeStub();
	const { registry, createdWith, attached } = workspaceRegistryStub("/real/telegram-work");
	const manager = new SessionManager(deps({ store, agents, presets: presetStub().service, workspaceRegistry: registry }));

	const resolved = await manager.ensure("42", "Test Chat", "/tmp/telegram-work");
	assert.deepEqual(createdWith, ["/tmp/telegram-work"]);
	assert.deepEqual(created[0]?.["meta"], { cwd: "/real/telegram-work", agentPreset: "buddy" });
	// attachSession must run only after the session itself was created.
	assert.deepEqual(attached, [resolved.sessionId]);
});

test("without a workspace registry a new session keeps the configured cwd and logs why", async () => {
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
	const { store } = storeStub();
	const lines: string[] = [];
	const manager = new SessionManager(deps({ store, agents, presets: presetStub().service, log: (line) => lines.push(line) }));

	await manager.ensure("42", "Test Chat", "/tmp/telegram-work");
	assert.deepEqual(created[0]?.["meta"], { cwd: "/tmp/telegram-work", agentPreset: "buddy" });
	assert.ok(lines.some((line) => line.includes("workspace registry unavailable")));
});

test("a workspace attach failure does not undo the session creation", async () => {
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
	const { store, records } = storeStub();
	const { registry } = workspaceRegistryStub("/real/telegram-work", { attachFails: "workspace is gone" });
	const lines: string[] = [];
	const manager = new SessionManager(
		deps({ store, agents, presets: presetStub().service, workspaceRegistry: registry, log: (line) => lines.push(line) }),
	);

	const resolved = await manager.ensure("42", "Test Chat", "/tmp/telegram-work");
	assert.equal(resolved.created, true);
	assert.equal(records.get("42")?.sessionId, String(resolved.sessionId));
	assert.ok(lines.some((line) => line.includes("workspace attach failed") && line.includes("workspace is gone")));
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
	const base = deps({ store, agents, presets: presetStub().service });
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
	const manager = new SessionManager(deps({ store, agents, presets: presetStub().service }));

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

test("a new session is composed from the buddy preset, never the deployment default", async () => {
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
	const presets = presetStub("standard");
	const { store, origins } = storeStub();
	const manager = new SessionManager(deps({ store, agents, presets: presets.service }));

	const resolved = await manager.ensure("42", "Test Chat", "/tmp/telegram-work");
	assert.deepEqual(presets.resolved, ["buddy"]);
	assert.deepEqual(created[0]?.["meta"], { cwd: "/tmp/telegram-work", agentPreset: "buddy" });
	const setup = created[0]?.["setup"] as (ctx: unknown, agent: unknown) => Promise<void>;
	const ctx = ctxStub();
	await setup(ctx, agentStub("session-new"));
	assert.deepEqual(presets.mounted, [{ agentCtx: ctx, id: "buddy" }]);
	assert.equal(origins.get(String(resolved.sessionId))?.chatId, "42", "a created session records its Telegram origin");
});

test("a profile without the preset roster refuses to create a session", async () => {
	let createCalls = 0;
	const agents = {
		get: () => undefined,
		create: async () => {
			createCalls += 1;
			throw new Error("create must not run");
		},
		resume: async () => {
			throw new Error("unused");
		},
	};
	const { store, records, origins } = storeStub();
	const manager = new SessionManager(deps({ store, agents }));
	await assert.rejects(() => manager.ensure("42", "Test Chat", "/tmp/telegram-work"), /^Error: Buddy preset unavailable: /);
	assert.equal(createCalls, 0);
	assert.equal(records.size, 0);
	assert.equal(origins.size, 0);
});

test("an unresolvable buddy preset refuses to create a session", async () => {
	let createCalls = 0;
	const agents = {
		get: () => undefined,
		create: async () => {
			createCalls += 1;
			throw new Error("create must not run");
		},
		resume: async () => {
			throw new Error("unused");
		},
	};
	const presets = presetStub();
	const missing = {
		...presets.service,
		resolve: async () => {
			throw new Error('agent-presets: preset "buddy" not found');
		},
	};
	const { store, records } = storeStub();
	const manager = new SessionManager(deps({ store, agents, presets: missing }));
	await assert.rejects(
		() => manager.ensure("42", "Test Chat", "/tmp/telegram-work"),
		/Buddy preset unavailable: agent-presets: preset "buddy" not found/,
	);
	assert.equal(createCalls, 0);
	assert.equal(records.size, 0);
});

test("a resumed session joins the preset its header recorded", async () => {
	const resumed = agentWithPreset("session-live", "buddy");
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
	await recorder.hook()(ctxStub(), resumed);
	assert.deepEqual(presets.mounted.map((entry) => entry.id), ["buddy"]);
});

test("a resumed session whose header records no preset joins the buddy preset", async () => {
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
	assert.deepEqual(presets.mounted.map((entry) => entry.id), ["buddy"]);
});

test("a failing preset mount surfaces as a creation failure", async () => {
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
	await manager.ensure("42", "Test Chat", "/tmp/telegram-work");
	const setup = created[0]?.["setup"] as (ctx: unknown, agent: unknown) => Promise<void>;
	await assert.rejects(() => setup(ctxStub(), agentStub("session-x")), /preset broke/);
});

test("a new session starts on the buddy default model when one is set", async () => {
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
	const { store } = storeStub();
	const manager = new SessionManager(
		deps({
			store,
			agents,
			presets: presetStub().service,
			defaults: { provider: "global-p", model: "global-m" },
			buddyModel: { provider: "buddy-p", model: "buddy-m" },
		}),
	);
	await manager.ensure("42", "Test Chat", "/tmp/telegram-work");
	assert.deepEqual(created[0]?.["agentOptions"], { provider: "buddy-p", model: "buddy-m" });
});

test("without a buddy default a new session starts on the global default", async () => {
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
	const { store } = storeStub();
	const manager = new SessionManager(
		deps({ store, agents, presets: presetStub().service, defaults: { provider: "global-p", model: "global-m" } }),
	);
	await manager.ensure("42", "Test Chat", "/tmp/telegram-work");
	assert.deepEqual(created[0]?.["agentOptions"], { provider: "global-p", model: "global-m" });
});
