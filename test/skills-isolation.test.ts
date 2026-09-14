/**
 * Task 15: the isolation contract's executable half.
 *
 * Spec §4 makes Buddy's skills structural, and its **first leg** is a
 * registration-layer claim: the buddy provider, `skill_manage`, the two event
 * listeners and `/refine` are registered by the *preset* row, so every one of
 * them files into the layer of the buddy preset's scope — and an ordinary
 * coding session, which merges neither that scope nor its chain, sees none of
 * them. §13.2 item 2 asserts the same fact from outside a real deployment, but
 * a probe only fails on the day someone runs it. This file is the part of that
 * claim CI can run: it pins the **tool catalogue's** isolation against the real
 * tool registry, and names — in place, below — the half of the claim that has no
 * real subject in this package at all.
 *
 * What is real here, and what is not — because a test that looks like proof and
 * is not is worse than an honest gap:
 *
 * - **Real**: cordis itself; `@deepseek-ai/dsh-scope`'s `createScope`, the exact
 *   primitive a preset's standing mount uses (`dsh-agent-presets`'
 *   `ensureStanding` does `createScope(this.selfCtx, { agentPreset })` and then
 *   mounts the preset's rows on `scope.ctx`); the **real** `ToolRuntime` from
 *   `@deepseek-ai/dsh-tools`, with its real `systemPrompt` dependency; and both
 *   shipped rows under test, mounted exactly as the composition mounts them —
 *   the host row unscoped, the preset row on the buddy scope. `ToolRuntime` is
 *   the same host-layer + per-scope-layer mechanism the phase's isolation rests
 *   on (`dsh-skill`'s own documentation calls itself "the host+per-scope shape
 *   the tools registry established"), and `register`/`schemas(scope?)` are
 *   scope-addressed, so the tool catalogue read below is a genuine observation
 *   of the real registry rather than of a stand-in.
 * - **Not real, and deliberately not faked into the claim**: `@deepseek-ai/dsh-skill`
 *   is not in this package's dependency closure and **cannot be installed
 *   here** — the worktree's `node_modules` is a symlink into the checkout and
 *   there is no network — so the *skill catalog's* cross-scope invisibility has
 *   no real `SkillRegistry` to mount. Rebuilding one out of `ScopedLayers`
 *   would test our imitation of the registry, not the registry, and a green
 *   run would read as proof of something it never touched. That half of §4 stays
 *   where the spec puts it: **§13.2 item 2's real-harness probe, Task 18**. The
 *   second test below pins only the *mechanism* such a catalog would be filed
 *   through — a registration made from a scoped context carries that scope, and
 *   the host row's global registration carries none — and says so in place.
 * - **Stand-ins, named**: the `skills` registry is {@link RecordingSkills},
 *   which records the calling context and serves no catalogs at all;
 *   `buddyStore` is a plain object, because this proof is about where a
 *   registration lands and not about the store. Everything else is shipped
 *   code.
 * - **`$DSH_HOME` is never resolved**: the store row is not mounted, and the
 *   skills root comes from `resolveBuddyPaths` with an explicit home, which
 *   short-circuits its harness-home branch. That is why this file does not take
 *   `test/support/dsh-home-hold.ts` — the hold exists for suites that mount the
 *   real store row, and mounting it here would widen what the proof touches
 *   without adding a claim.
 *
 * The three claims each fail for their own reason:
 *
 * 1. **`skill_manage` exists in the buddy scope and nowhere else.** A row that
 *    registered from the host row's context — or a test that mounted it on an
 *    unscoped context — puts the tool in the global layer, where the coding
 *    scope sees it too. The global read is asserted as well, so "visible in
 *    buddy, invisible in coding" cannot be satisfied by a coincidence of two
 *    unrelated scopes.
 * 2. **A provider registration carries the registering context's scope.** This
 *    is the mechanism the real registry would file through; it is the only part
 *    of the catalog half this package can honestly pin, and it is pinned as
 *    such.
 * 3. **The skills root is not a deployment default root** (spec §4.2). The root
 *    is computed through the real `resolveBuddyPaths`, never written as a
 *    literal, so the assertion follows the row rather than a copy of it.
 * @module test/skills-isolation
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { Context, Service } from "@deepseek-ai/cordis";
import { createScope, scopeOf, type ScopeKey } from "@deepseek-ai/dsh-scope";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { FALLBACK_CONFIG } from "../src/config.ts";
import { resolveBuddyPaths } from "../src/paths.ts";
import { BUDDY_SKILL_PROVIDER_NAME, PROMOTED_SKILL_PROVIDER_NAME } from "../src/skills/provider.ts";
import * as skillsAgentRow from "../src/skills-agent/index.ts";
import * as skillsHostRow from "../src/skills/index.ts";

/**
 * The name of the one tool the preset row registers.
 *
 * The row keeps it module-private, so it is repeated here as the model-facing
 * name a session's catalogue is read for — the literal a coding session would
 * be looking for.
 */
const TOOL_NAME = "skill_manage";

/** A cordis fiber, as far as this file's teardown reads it. */
interface Fiber {
	dispose(): Promise<void>;
}

/** The control one provider registration borrows; the rows' own local shape. */
interface ProviderControl {
	/** Aborts when the exact registration is disposed. */
	readonly signal: AbortSignal;
	/** Invalidate completed catalogs, while the registration remains active. */
	invalidate(): void;
}

/** One provider registration, with the context it was made from. */
interface Registration {
	/** The provider's own name, as the registry would file it. */
	readonly name: string;
	/** The context the registering row called the registry through. */
	readonly ctx: Context;
}

/** The `ctx.tools` slice this file reads: the scope-addressed catalogue. */
interface ToolCatalogue {
	/**
	 * The tools one scope resolves, or the global view when no scope is given.
	 * @param scope - the viewing scope key.
	 * @returns one schema per visible tool.
	 */
	schemas(scope?: ScopeKey): readonly { readonly name: string }[];
}

/**
 * The `skills` registry, reduced to the one fact this proof reads.
 *
 * This is **not** a skill catalog and must never be read as one: it serves no
 * providers, caches nothing and answers no lookup. It exists because
 * `@deepseek-ai/dsh-skill` cannot be installed in this package, and because the
 * only claim about the catalog half this file may make is about the *context a
 * registration was made from* — which is exactly what it records.
 */
class RecordingSkills extends Service {
	/** Every registration, in call order, with the context that made it. */
	readonly registrations: Registration[] = [];

	/**
	 * @param ctx - the context this service is provided in.
	 */
	constructor(ctx: Context) {
		super(ctx, "skills");
	}

	/**
	 * Record one registration and hand its factory a control.
	 * @param create - the row's factory.
	 * @returns a disposer, as the real registry's own would be.
	 */
	registerProvider(create: (control: ProviderControl) => { readonly name: string }): () => void {
		// `this.ctx` is the **caller's** context, not the one this service was
		// constructed in: cordis hands a service out through a traceable proxy
		// whose tracked property is `ctx`, and that is the exact mechanism the
		// real registry's layer filing rests on. Recorded from the real proxy,
		// so what the assertion below reads is where the row really called from.
		const provider = create({ signal: new AbortController().signal, invalidate: () => undefined });
		this.registrations.push({ name: provider.name, ctx: this.ctx });
		return () => undefined;
	}
}

/** What {@link twoScopes} hands back to its tests. */
interface IsolationApp {
	/** The scope key of the buddy preset's standing mount. */
	readonly buddyKey: ScopeKey;
	/** The scope key of an ordinary coding session, which mounted nothing. */
	readonly codingKey: ScopeKey;
	/** The real tool registry, read the way a prompt builder reads it. */
	readonly tools: ToolCatalogue;
	/** The buddy-tier registration the preset row made. */
	readonly buddyRegistration: Registration;
	/** The promoted-tier registration the host row made. */
	readonly hostRegistration: Registration;
	/** The skills root both rows were built over. */
	readonly skillsRoot: string;
	/** Where buddy conversations run, which must not contain the skills root. */
	readonly workspace: string;
	/** The buddy home that root sits under. */
	readonly home: string;
	/** Unmount the whole graph, the way a plugin reload does. */
	dispose(): Promise<void>;
}

/**
 * Poll until a condition holds, so a test never depends on a fixed sleep for
 * cordis's asynchronous activation.
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
 * Load one plugin under `parent`, with the plugin shape erased.
 *
 * The rows declare their own minimal `ctx` interfaces on purpose, so their
 * `apply` signatures are deliberately narrower than cordis's `Context`; the
 * erasure keeps this file's job — mounting them where the composition mounts
 * them — from restating those local types.
 * @param parent - the context to mount under.
 * @param plugin - the plugin: a class, or an object with `apply`.
 * @returns the fiber, for teardown.
 */
function load(parent: Context, plugin: unknown): Fiber {
	return (parent.plugin as unknown as (plugin: unknown) => Fiber)(plugin);
}

/**
 * Build a sibling plugin that publishes one service from its own fiber.
 * @param pluginName - the fiber's diagnostic name.
 * @param name - the service name to provide.
 * @param value - the service value.
 * @returns the plugin object.
 */
function sibling(pluginName: string, name: string, value: unknown): object {
	return {
		name: pluginName,
		apply: (ctx: Context): void => {
			(ctx as unknown as { reflect: { provide(key: string, provided: unknown): void } }).reflect.provide(name, value);
		},
	};
}

/**
 * Mount the real rows in a real cordis app and mint the two scopes.
 *
 * The graph is the deployment's: the store's service, the two real registries
 * `ToolRuntime` needs, then the **host** row unscoped (it owns the global layer,
 * spec §4.3) and the **preset** row on the buddy scope (it owns the buddy layer,
 * spec §4.1). The coding scope is a standing mount that composes nothing, which
 * is what an ordinary session's scope looks like with respect to Buddy.
 * @returns the mounted app and its two scope keys.
 */
async function twoScopes(): Promise<IsolationApp> {
	const home = await mkdtemp(join(tmpdir(), "dsh-buddy-isolation-"));
	const paths = resolveBuddyPaths(home);
	const root = new Context();
	const fibers: Fiber[] = [];
	const realConsoleError = console.error;
	// The host row says out loud that the typert registry is absent, because it
	// is: this proof is about the tool catalogue, not the panel. Captured so the
	// suite's output stays readable; nothing here asserts on it.
	console.error = () => undefined;
	try {
		// The store row is deliberately not mounted: it resolves the harness home,
		// opens a storage domain and installs the preset — none of which this
		// proof is about, and all of which would make the suite touch `$DSH_HOME`.
		// `buddyStore` is therefore a plain object carrying the members the host
		// row's mount actually reads.
		fibers.push(
			load(
				root,
				sibling("test-buddy-store", "buddyStore", {
					paths,
					config: () => FALLBACK_CONFIG,
					skillUsage: () => new Map(),
					skillLedger: () => new Map(),
					reviewUsage: () => new Map(),
				}),
			),
		);
		// The real services. `systemPrompt` is `ToolRuntime`'s one declared
		// dependency, and it is the real registry rather than a stub: the real
		// `ToolRuntime` registers a tool-schema provider into it during its own
		// construction. Neither is given config, which is how a profile with no
		// config block mounts them — each `Config` schema fills its own defaults.
		fibers.push(load(root, SystemPrompt));
		fibers.push(load(root, ToolRuntime));
		fibers.push(load(root, RecordingSkills));
		await until(
			() =>
				root.get("buddyStore") !== undefined && root.get("tools") !== undefined && root.get("skills") !== undefined,
		);

		// The host row, unscoped — exactly how `cordis.patch.yml` mounts it. Its
		// promoted-provider registration is the global layer's half of the split.
		fibers.push(load(root, { name: skillsHostRow.name, inject: skillsHostRow.inject, apply: skillsHostRow.apply }));
		await until(() => root.get("buddySkills") !== undefined);

		const buddyKey: ScopeKey = { agentPreset: "buddy" };
		const codingKey: ScopeKey = { agentPreset: "coding" };
		const buddyScope = createScope(root, buddyKey);
		const codingScope = createScope(root, codingKey);
		fibers.push(buddyScope, codingScope);

		// The preset's standing mount. `dsh-agent-presets` does precisely this,
		// which is why every registration this row makes lands in the buddy
		// layer: cordis files a registration into the layer of the *calling*
		// context's scope, and this is the calling context.
		load(buddyScope.ctx, { name: skillsAgentRow.name, apply: skillsAgentRow.apply });

		const catalogue = (): ToolCatalogue => root.get("tools") as ToolCatalogue;
		await until(() => catalogue().schemas(buddyKey).some((tool) => tool.name === TOOL_NAME));

		const recorder = root.get("skills") as unknown as RecordingSkills;
		const buddyRegistration = recorder.registrations.find((entry) => entry.name === BUDDY_SKILL_PROVIDER_NAME);
		const hostRegistration = recorder.registrations.find((entry) => entry.name === PROMOTED_SKILL_PROVIDER_NAME);
		if (buddyRegistration === undefined) assert.fail("the preset row must register the buddy-tier provider");
		if (hostRegistration === undefined) assert.fail("the host row must register the promoted-tier provider");

		return {
			home,
			buddyKey,
			codingKey,
			tools: catalogue(),
			buddyRegistration,
			hostRegistration,
			skillsRoot: paths.skills,
			workspace: paths.workspace,
			// Reverse mount order, so a child scope goes before the services it
			// registered against.
			dispose: async () => {
				for (const fiber of [...fibers].reverse()) await fiber.dispose();
			},
		};
	} finally {
		console.error = realConsoleError;
	}
}

test("skill_manage is absent from a scope that never mounted the row", async () => {
	const app = await twoScopes();
	try {
		// Where the preset mounted the row, the tool is there...
		assert.ok(
			app.tools.schemas(app.buddyKey).some((tool) => tool.name === TOOL_NAME),
			"the buddy scope must resolve skill_manage",
		);
		// ...and where it did not, the tool is nowhere to be found.
		assert.ok(
			!app.tools.schemas(app.codingKey).some((tool) => tool.name === TOOL_NAME),
			"a coding scope must not resolve skill_manage",
		);
		// The global view is asserted too: a row registered from the host row's
		// context would put the tool *there*, where every unrelated scope merges
		// it — so "visible in buddy, invisible in coding" alone could be an
		// accident of two scopes, while this cannot.
		assert.ok(
			!app.tools.schemas(undefined).some((tool) => tool.name === TOOL_NAME),
			"skill_manage must not be a global tool",
		);
	} finally {
		await app.dispose();
	}
});

test("the row's provider registration is filed by a scoped context", async () => {
	// `@deepseek-ai/dsh-skill` is not installable in this package, so the skill
	// catalog's own cross-scope invisibility is **not** provable here and is left
	// to Task 18's real-harness probe (spec §13.2 item 2). What this pins is the
	// mechanism that half would file through: the registry sees the registration
	// arrive from a scoped context, never from an ambient or global one.
	const app = await twoScopes();
	try {
		assert.equal(app.buddyRegistration.name, BUDDY_SKILL_PROVIDER_NAME);
		assert.equal(scopeOf(app.buddyRegistration.ctx), app.buddyKey, "the buddy tier must file into the buddy scope");
		// The host row is the global layer's owner (spec §4.3): a promoted skill
		// is what an ordinary coding session merges, so this registration must
		// carry no scope at all.
		assert.equal(app.hostRegistration.name, PROMOTED_SKILL_PROVIDER_NAME);
		assert.equal(scopeOf(app.hostRegistration.ctx), undefined, "the promoted tier must file globally");
	} finally {
		await app.dispose();
	}
});

test("skills on disk are not picked up by the deployment's default roots", async () => {
	// Spec §4.2: the skills root is `<home>/main/skills`, which is not any root
	// the deployment's own skill discovery scans — so even a session whose cwd is
	// the buddy workspace cannot discover Buddy's skills as project skills. The
	// root is computed through the real resolver rather than written as a
	// literal, so the claim follows the row instead of a copy of it.
	const app = await twoScopes();
	try {
		assert.equal(app.skillsRoot, resolveBuddyPaths(app.home).skills, "the root under test is the resolver's root");
		assert.ok(!app.skillsRoot.includes(join(".dsh", "skills")), "not the harness home's skills root");
		assert.ok(!app.skillsRoot.includes(join(".agents", "skills")), "not the agents home's skills root");
		// The sibling-of-workspace half of the same rule (`src/paths.ts`): a skills
		// directory inside the session cwd would be a project skill root for every
		// session whose cwd is the workspace, which is precisely how a buddy skill
		// would reach an ordinary coding session.
		assert.ok(app.skillsRoot.startsWith(`${app.home}${sep}`), "the root stays under the buddy home");
		assert.ok(
			!app.skillsRoot.startsWith(`${app.workspace}${sep}`),
			"the root is a sibling of the workspace, never inside it",
		);
	} finally {
		await app.dispose();
	}
});
