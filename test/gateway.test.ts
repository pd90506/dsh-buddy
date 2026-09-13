/**
 * The persona gateway's wire surface, exercised the way the api-gateway reaches it.
 *
 * Two properties here are load-bearing and easy to lose:
 *
 * 1. **No `#` private fields.** Cordis never hands out the instance: `ctx.get()`
 *    returns a *traceable proxy*, and the api-gateway dispatches with
 *    `Reflect.apply(method, proxy, args)`, substituting a shadow receiver for
 *    `this`. A `#` field is branded to the instance object and is unreachable
 *    through any proxy, so an endpoint using one throws on the first live call
 *    while every offline test holding the raw instance passes. Every endpoint
 *    below is therefore called on the proxy `ctx.extend().get(BUDDY_SERVICE)`
 *    returns — never on the instance — and the two are asserted to differ.
 * 2. **No unvalidated wire data reaches the persona writer.** `soulForPrompt`
 *    trims `soul` and `agents` unguarded, so a patch carrying a non-string, a
 *    null, or an unknown key must be dropped at this boundary rather than
 *    forwarded.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { remoteMethods } from "@deepseek-ai/dsh-typert-protocol";
import {
	BuddyPersonaGateway,
	BUDDY_SERVICE,
	type BuddySessionSummary,
	type GatewayDeps,
	type PersonaView,
	type PreferencesView,
} from "../src/persona/gateway.ts";
import { FALLBACK_CONFIG, type BuddyConfig } from "../src/config.ts";

/** The view the stub hands back, so identity can be asserted on the way out. */
const VIEW: PersonaView = { soul: "Voice.", agents: "", home: "/tmp/buddy" };

/** The session list the stub hands back. */
const SESSIONS: BuddySessionSummary[] = [{ sessionId: "s1", title: "First", updatedAt: 1, cwd: "/tmp", source: "web" }];

/** The preferences view the stub hands back. */
const PREFERENCES: PreferencesView = {
	model: { ...FALLBACK_CONFIG.model },
	panel: { sections: { ...FALLBACK_CONFIG.panel.sections } },
	conversationCwd: "/tmp/buddy-workspace",
};

/** Deps that record what reached them. */
interface Recorder extends GatewayDeps {
	/** Every patch that reached {@link GatewayDeps.writePersona}, in order. */
	readonly patches: Partial<{ soul: string; agents: string }>[];
	/** How many times {@link GatewayDeps.readPersona} was called. */
	reads: number;
	/** Every patch that reached {@link GatewayDeps.writePreferences}, in order. */
	readonly preferencePatches: Partial<Pick<BuddyConfig, "model" | "panel">>[];
}

/** @returns recording deps. */
function deps(): Recorder {
	const recorder: Recorder = {
		patches: [],
		reads: 0,
		preferencePatches: [],
		readPersona: async () => {
			recorder.reads += 1;
			return VIEW;
		},
		writePersona: async (patch) => {
			recorder.patches.push(patch);
			return VIEW;
		},
		listSessions: async () => SESSIONS,
		readPreferences: async () => PREFERENCES,
		writePreferences: async (patch) => {
			recorder.preferencePatches.push(patch);
			return PREFERENCES;
		},
		currentConfig: () => FALLBACK_CONFIG,
	};
	return recorder;
}

/** One advertised invocation, as the typert contribution declares it. */
interface Invocation {
	readonly id: string;
	readonly method: string;
	readonly namespace: string;
	readonly service: string;
	readonly invocation: { readonly kind: string };
	readonly parameters: readonly { readonly name: string; readonly wire: string }[];
}

/** The contribution the gateway hands to `ctx.typert.register`. */
interface Contribution {
	readonly package: string;
	readonly face: string;
	readonly invocations: readonly Invocation[];
}

/** The slice of a cordis Context this test drives. */
interface ServiceHost {
	reflect: { provide(name: string, value: unknown): void };
	get(name: string): unknown;
	extend(): ServiceHost;
}

/** A gateway on a real context, reached the way the api-gateway reaches it. */
function harness(): {
	/** The service as a *consumer* context sees it: a proxy, not the instance. */
	service: Record<string, (...args: unknown[]) => unknown>;
	instance: BuddyPersonaGateway;
	contribution: Contribution;
	recorder: Recorder;
} {
	const ctx = new Context() as unknown as ServiceHost;
	const contributions: Contribution[] = [];
	ctx.reflect.provide("typert", { register: (accepted: Contribution) => contributions.push(accepted) });
	const recorder = deps();
	const instance = new BuddyPersonaGateway(ctx as never, recorder);
	const contribution = contributions[0];
	if (contribution === undefined) assert.fail("the gateway must register its typert contribution");
	assert.equal(contributions.length, 1, "exactly one contribution");
	return {
		// A separate consumer context, as the api-gateway service has.
		service: ctx.extend().get(BUDDY_SERVICE) as Record<string, (...args: unknown[]) => unknown>,
		instance,
		contribution,
		recorder,
	};
}

/**
 * Call one endpoint the way the api-gateway does: look the method up on the
 * proxy and `Reflect.apply` it *with that proxy as `this`*.
 *
 * Both halves matter. `const method = service.persona; method()` would pass
 * `this === undefined` — a different, more forgiving path than the wire takes,
 * and the one that would let a fresh `#` field slip through review.
 * @param service - the service as `ctx.get` returns it.
 * @param method - the endpoint name.
 * @param args - positional arguments, as the contribution declares them.
 * @returns the endpoint's result.
 */
function dispatch(
	service: Record<string, (...args: unknown[]) => unknown>,
	method: string,
	args: unknown[],
): unknown {
	const found = service[method];
	if (typeof found !== "function") assert.fail(`${method} must be callable on the proxy`);
	return Reflect.apply(found, service, args);
}

test("constructing the gateway registers the typert contribution", () => {
	const { contribution } = harness();
	assert.equal(contribution.package, "dsh-buddy");
	assert.equal(contribution.face, "host");
	assert.deepEqual(
		contribution.invocations.map((invocation) => invocation.method).sort(),
		["persona", "preferences", "sessions", "updatePersona", "updatePreferences"],
	);
	for (const invocation of contribution.invocations) {
		assert.equal(invocation.namespace, BUDDY_SERVICE, `${invocation.method} must be on the buddy namespace`);
		assert.equal(invocation.service, BUDDY_SERVICE, `${invocation.method} must name the buddy service`);
		assert.equal(invocation.invocation.kind, "direct");
		assert.equal(invocation.id, `dsh-buddy#${invocation.method}`);
	}
	const update = contribution.invocations.find((invocation) => invocation.method === "updatePersona");
	assert.deepEqual(update?.parameters.map((parameter) => parameter.wire), ["patch"]);
});

test("the endpoints come from the runtime registry, not from @Remote decorators", () => {
	const { instance } = harness();
	// A decorator writes its marker into the module-private table of whichever
	// `dsh-typert-protocol` copy attached it, and this plugin's nested copy is
	// not the api-gateway's — so a decorated endpoint is invisible on the wire.
	assert.deepEqual(remoteMethods(instance), [], "no endpoint may be declared with @Remote");
});

test("a missing typert registry fails loudly", () => {
	const bare = new Context() as unknown as ServiceHost;
	assert.throws(() => new BuddyPersonaGateway(bare as never, deps()), /typert/);
});

test("every endpoint survives proxy dispatch (no # private fields)", async () => {
	const { service, instance, recorder } = harness();
	// The inequality is the whole point: `this` inside an endpoint is this proxy,
	// never the instance, so nothing on the instance may be `#`-private.
	assert.notEqual(service, instance, "cordis must hand out a proxy, not the instance");
	assert.equal(await dispatch(service, "persona", []), VIEW);
	assert.equal(await dispatch(service, "sessions", []), SESSIONS);
	assert.equal(await dispatch(service, "updatePersona", [{ soul: "New." }]), VIEW);
	assert.deepEqual(recorder.patches, [{ soul: "New." }]);
});

test("every endpoint the contribution advertises is callable through the proxy", async () => {
	const { service, contribution, recorder } = harness();
	for (const invocation of contribution.invocations) {
		// An endpoint added to the contribution later is covered here
		// automatically, which is how the proxy constraint keeps holding.
		await dispatch(
			service,
			invocation.method,
			invocation.parameters.map(() => ({ soul: "loop" })),
		);
	}
	assert.deepEqual(recorder.patches, [{ soul: "loop" }], "the write path must reach the persona writer");
});

test("updatePersona accepts only known string fields", async () => {
	const { service, recorder } = harness();
	await dispatch(service, "updatePersona", [{ soul: "A", agents: "B", evil: "C", n: 5 }]);
	assert.deepEqual(recorder.patches, [{ soul: "A", agents: "B" }]);
});

test("updatePersona drops a known field carrying the wrong type", async () => {
	const { service, recorder } = harness();
	// `soulForPrompt` trims both fields unguarded; a number, a null or an array
	// reaching the writer is a crash or a corrupted file, not a bad edit.
	assert.equal(await dispatch(service, "updatePersona", [{ soul: "A", agents: 5 }]), VIEW);
	assert.deepEqual(recorder.patches, [{ soul: "A" }], "the ill-typed field must not be forwarded at all");
	await dispatch(service, "updatePersona", [{ soul: 5, agents: null }]);
	await dispatch(service, "updatePersona", [{ soul: ["A"], agents: { toString: "B" } }]);
	await dispatch(service, "updatePersona", [{ soul: undefined, agents: undefined }]);
	assert.deepEqual(recorder.patches, [{ soul: "A" }], "no further write may have happened");
});

test("an empty patch performs no write", async () => {
	const { service, recorder } = harness();
	for (const patch of [{}, { nothing: true }, { evil: "C" }, { soul: 5 }]) {
		// The read is what the caller gets back, so "no write" must not mean
		// "no answer" either.
		assert.equal(await dispatch(service, "updatePersona", [patch]), VIEW);
	}
	assert.deepEqual(recorder.patches, [], "an empty patch must not reach the writer, not even as {}");
	assert.equal(recorder.reads, 4, "each empty patch must answer from a fresh read");
});

test("updatePreferences dispatches through the proxy and writes only validated fields", async () => {
	const { service, recorder } = harness();
	await dispatch(service, "updatePreferences", [{ panel: { sections: { telegram: false } }, home: "/nope" }]);
	assert.deepEqual(recorder.preferencePatches, [
		{ panel: { sections: { soul: true, agents: true, model: true, telegram: false } } },
	]);
});

test("the service name is the typert namespace", () => {
	assert.equal(BUDDY_SERVICE, "buddyPersona");
});
