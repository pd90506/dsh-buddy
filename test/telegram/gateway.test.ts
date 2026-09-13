/**
 * The service-proxy test: cordis never hands out the instance.
 *
 * Every other test in this suite calls the gateway on the object that was handed
 * to `reflect.provide`. Production does not. `ctx.get("telegram")` returns a
 * *traceable proxy* (`createTraceable` in cordis), and the api-gateway dispatches
 * through `Reflect.apply(method, receiver, args)` with that proxy as `this` — the
 * proxy's method wrapper then substitutes a shadow wrapper again. A
 * runtime-private (`#`) field is bound to the instance object itself and cannot be
 * reached through any proxy, so the first live call failed with
 *
 *     telegram/status failed: gateway/internal: Cannot read private member #deps
 *     from an object whose class did not declare it
 *
 * while the whole offline suite passed, because every one of those tests used the
 * raw instance. This file registers the gateway on a real cordis Context, asks a
 * separate consumer context for the service the way the wire does, and calls every
 * endpoint the contribution advertises.
 *
 * It is also the reason the gateway's fields are TypeScript-`private` and not
 * `#`-private: the compiler still enforces them, and they survive a proxy.
 * DSH's own host packages contain no `#` field at all.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import type { TelegramConfig } from "../../src/telegram/config.ts";
import { TelegramGateway, type GatewayDeps, type TelegramStatus } from "../../src/telegram/gateway.ts";

/** The config the stub hands back, so identity can be asserted on the way out. */
const CONFIG: TelegramConfig = {
	enabled: true,
	ownerUserId: "42",
	defaultCwd: "/tmp/dsh-telegram",
	permissionPreset: "workspace-write",
	renderMarkdown: true,
	mediaDelivery: "all",
};

/** The status the stub hands back. */
const STATUS: TelegramStatus = {
	state: "off",
	detail: "disabled",
	botUsername: "@example_bot",
	sessions: 3,
	token: { configured: true, source: "file", writable: true },
};

/** One advertised invocation, as the typert contribution declares it. */
interface Invocation {
	method: string;
	parameters: { name: string; wire: string }[];
}

/** The slice of a cordis Context this test exercises. */
interface ServiceHost {
	reflect: { provide(name: string, value: unknown): void };
	get(name: string): unknown;
	extend(): ServiceHost;
}

/** A gateway on a real context, reached the way the api-gateway reaches it. */
function harness(): {
	service: Record<string, (...args: unknown[]) => unknown>;
	instance: TelegramGateway;
	invocations: Invocation[];
	written: Record<string, unknown>[];
} {
	const ctx = new Context() as unknown as ServiceHost;
	const contributions: { invocations: Invocation[] }[] = [];
	ctx.reflect.provide("typert", {
		register: (accepted: { invocations: Invocation[] }) => contributions.push(accepted),
	});
	const written: Record<string, unknown>[] = [];
	const deps: GatewayDeps = {
		status: async () => STATUS,
		readConfig: () => CONFIG,
		writeConfig: async (patch) => {
			written.push(patch);
		},
	};
	const instance = new TelegramGateway(ctx as never, deps);
	const contribution = contributions[0];
	if (contribution === undefined) assert.fail("the gateway must register its typert contribution");
	// A separate consumer context, as the api-gateway service has.
	return {
		service: ctx.extend().get("telegram") as Record<string, (...args: unknown[]) => unknown>,
		instance,
		invocations: contribution.invocations,
		written,
	};
}

/**
 * Call one endpoint the way the api-gateway does: look the method up on the proxy
 * and `Reflect.apply` it *with that proxy as `this`*.
 *
 * Both halves matter. Calling `service.status()` binds `this` to the proxy too, but
 * `const method = service.status; method()` would pass `this === undefined` — a
 * different, more forgiving path than the wire takes, and the one that would let a
 * fresh `#` field slip through review.
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

test("the gateway answers through the cordis service proxy (live-failure regression)", async () => {
	const { service, instance } = harness();
	// The inequality is the whole point: `this` inside an endpoint is this proxy,
	// never the instance, so nothing on the instance may be `#`-private.
	assert.notEqual(service, instance, "cordis must hand out a proxy, not the instance");
	assert.deepEqual(await dispatch(service, "status", []), STATUS);
	assert.deepEqual(dispatch(service, "config", []), CONFIG);
	assert.deepEqual(await dispatch(service, "updateConfig", [{ enabled: false }]), CONFIG);
});

test("every endpoint the contribution advertises is callable through the proxy", async () => {
	const { service, invocations, written } = harness();
	assert.deepEqual(
		invocations.map((invocation) => invocation.method).sort(),
		["config", "status", "updateConfig"],
	);
	for (const invocation of invocations) {
		// A new endpoint added to the contribution is covered here automatically,
		// which is how the proxy constraint keeps holding without being remembered.
		await dispatch(service, invocation.method, invocation.parameters.map(() => ({ enabled: true })));
	}
	assert.deepEqual(written, [{ enabled: true }], "the write path must reach the settings section");
});
