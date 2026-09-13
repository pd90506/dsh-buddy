/**
 * Shared browser-half test harness.
 *
 * These helpers were extracted from `test/client-ui.test.ts` unchanged (module
 * paths aside) so the phase-6 client test files can drive the same built
 * artifact, stub context and hookless renderer without re-deriving them. This
 * file has no `test(...)` calls of its own and the `test` script's glob
 * (`test/*.test.ts test/telegram/*.test.ts`) never reaches `test/support/`, so
 * it is never run as a suite — only imported.
 *
 * See `test/client-ui.test.ts`'s own file doc for why assertions run against
 * the **built** `lib/client.js` rather than a `.tsx` source import.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

/** The browser plugin object the bundle's factory returns. */
export interface ClientPlugin {
	readonly inject: string[];
	apply(ctx: unknown): void;
}

/** A `settings.section` registration, as the slot service receives it. */
export interface SectionOptions {
	readonly name: string;
	readonly id: string;
	readonly order: number;
	readonly locale: string;
	readonly label: () => string;
}

/** A `main` slot registration, as the slot service receives it — no id/order/label, only the key the sidebar addresses it by. */
export interface MainPanelOptions {
	readonly name: string;
	readonly key: string;
}

/** One recorded slot registration. */
export interface Registration {
	readonly options: SectionOptions | MainPanelOptions;
	readonly component: unknown;
}

/** One recorded dictionary registration. */
interface Dictionary {
	readonly ns: string;
	readonly dictionary: Record<string, unknown>;
	/** Whether `locale.register` was reached from inside a `ctx.effect` body. */
	readonly insideEffect: boolean;
}

/** Everything the stub context observed. */
export interface Recorded {
	readonly ctx: Record<string, unknown>;
	readonly registrations: Registration[];
	readonly injected: string[];
	readonly effects: string[];
	readonly dictionaries: Dictionary[];
}

/** The connection service's RPC client, as the browser half uses it. */
export interface RpcStub {
	call(route: string, endpoint: string, payload: unknown): Promise<unknown>;
}

/** The built bundle, as text. */
export async function bundleText(): Promise<string> {
	return await readFile(new URL("../../lib/client.js", import.meta.url), "utf8");
}

/**
 * `src/client/index.tsx` as **text**.
 *
 * Read, never imported: no test in this plan may import a `.tsx` module because
 * Node's type stripping does not handle JSX — but reading one as a string is not
 * importing it, and it is the only way to assert on a source-level property
 * (which constant a module takes from where) that bundling erases.
 * @returns the module source.
 */
export async function clientSourceText(): Promise<string> {
	return await readFile(new URL("../../src/client/index.tsx", import.meta.url), "utf8");
}

/** What the bundle hands to `window.__ModuleLoader__.load`. */
interface LoaderModule {
	readonly id: string;
	factory(resolve: (name: string) => unknown): unknown;
}

/** Node's `require`, used both to evaluate the bundle and as the default module resolver. */
const nodeRequire = createRequire(import.meta.url);

/** The bundle is evaluated once — `require` caches it — so the captured module is memoized. */
let captured: LoaderModule | undefined;

/**
 * Evaluate `lib/client.js` the way the browser boot graph does and capture its module.
 * @returns the `{ id, factory }` the bundle registered.
 */
function clientModule(): LoaderModule {
	if (captured !== undefined) return captured;
	let seen: LoaderModule | undefined;
	(globalThis as unknown as { window: unknown }).window = {
		__ModuleLoader__: {
			load: (module: LoaderModule) => {
				seen = module;
			},
		},
	};
	nodeRequire("../../lib/client.js");
	assert.ok(seen !== undefined, "the bundle must call window.__ModuleLoader__.load");
	assert.equal(seen.id, "dsh-buddy", "the module id must match the package name");
	captured = seen;
	return captured;
}

/**
 * Instantiate the browser plugin from the built artifact.
 *
 * The factory is re-run per call with its own `module.exports`, so a test may
 * supply its own resolver — that is how the React tab below is rendered without
 * a renderer dependency.
 * @param resolve - module resolver handed to the bundle's `require`.
 * @returns the plugin object the bundle's factory returns.
 */
export function loadClient(resolve: (name: string) => unknown = (name) => nodeRequire(name)): ClientPlugin {
	return clientModule().factory(resolve) as ClientPlugin;
}

/**
 * A browser-side context stub that records every contribution.
 * @param options - `runSlotCallback: false` models a shell with no matching slot;
 *   `rpc` replaces the connection service's RPC client; `sessions` and `layout`
 *   replace those services so a test can observe `openSession`'s wiring; `remote`
 *   is exposed as `ctx.remote` for tests that stub that service directly.
 * @returns the stub context and its recordings.
 */
export function contextStub(
	options: {
		runSlotCallback?: boolean;
		rpc?: RpcStub;
		sessions?: Record<string, unknown>;
		layout?: { selectPanel(panelId: unknown): void };
		remote?: unknown;
	} = {},
): Recorded {
	const runSlotCallback = options.runSlotCallback ?? true;
	const rpc = options.rpc ?? { call: async () => ({ ok: true, value: {} }) };
	const registrations: Registration[] = [];
	const injected: string[] = [];
	const effects: string[] = [];
	const dictionaries: Dictionary[] = [];
	let depth = 0;

	const ctx: Record<string, unknown> = {
		get: (name: string) => (name === "connection" ? { rpc } : undefined),
		effect: (body: () => unknown, label: string) => {
			effects.push(label);
			depth += 1;
			try {
				return body();
			} finally {
				depth -= 1;
			}
		},
		locale: {
			// A label built from the namespace proves it resolved through this
			// plugin's own bound lookup rather than a bare global key.
			bind: (ns: string) => (key: string) => `${ns}:${key}`,
			register: (ns: string, dictionary: Record<string, unknown>) => {
				dictionaries.push({ ns, dictionary, insideEffect: depth > 0 });
				return () => {};
			},
		},
		slots: {
			inject: (name: string, callback: () => unknown) => {
				injected.push(name);
				if (!runSlotCallback) return;
				const result = callback();
				// The shipped `main` registration pattern is a generator
				// (`function* () { yield slots.register(...) }`, per
				// dsh-client-ui-conversation) rather than a bare call: a generator
				// function only runs its body up to the first `yield` once iterated,
				// so calling it without draining it would silently skip the
				// `register` call and this stub would never see the panel.
				if (result !== null && typeof result === "object" && typeof (result as Iterator<unknown>).next === "function") {
					for (const _ of result as Iterable<unknown>) {
						// draining is the point: each step runs one `yield register(...)`.
					}
				}
			},
			register: (sectionOptions: SectionOptions | MainPanelOptions, component: unknown) => {
				registrations.push({ options: sectionOptions, component });
				return () => {};
			},
		},
		layout: options.layout ?? { selectPanel: () => {} },
		sessions: options.sessions ?? {},
		remote: options.remote,
	};
	return { ctx, registrations, injected, effects, dictionaries };
}

/** One hook's storage across renders. */
interface HookCell {
	value: unknown;
	deps: readonly unknown[] | undefined;
	initialised: boolean;
}

/** An element as the stub JSX runtime builds it. */
export interface StubElement {
	readonly type: unknown;
	readonly props: Record<string, unknown>;
}

/** A mounted component: its current tree, re-rendered on every state change. */
interface Mounted {
	/** Modules the bundle's `require` must resolve to reach these hooks. */
	readonly modules: Record<string, unknown>;
	/** Render the component for the first time. */
	mount(component: () => unknown): void;
	/** The element tree produced by the most recent render. */
	tree(): unknown;
}

/**
 * A renderer just large enough for this one component.
 *
 * The tab's save gate is a `disabled` prop computed from state the mount load
 * sets, so proving it needs *some* renderer — and this repo deliberately has no
 * `react-dom`. Rather than grow one as a dependency, the bundle's own `require`
 * is pointed at these stubs: `useState` re-renders synchronously, `useCallback`
 * and `useEffect` honour their dependency lists (without that the mount effect
 * would re-fire forever), and the JSX runtime returns plain `{ type, props }`.
 * @returns the stub modules and the mount handle.
 */
export function createRenderer(): Mounted {
	const cells: HookCell[] = [];
	const pendingEffects: (() => unknown)[] = [];
	let cursor = 0;
	let renders = 0;
	let component: (() => unknown) | undefined;
	let tree: unknown;

	const sameDeps = (previous: readonly unknown[] | undefined, next: readonly unknown[]): boolean =>
		previous !== undefined && previous.length === next.length && previous.every((v, i) => Object.is(v, next[i]));

	const cell = (): HookCell => {
		const existing = cells[cursor];
		const slot = existing ?? { value: undefined, deps: undefined, initialised: false };
		if (existing === undefined) cells[cursor] = slot;
		cursor += 1;
		return slot;
	};

	const render = (): void => {
		renders += 1;
		// An internal liveness bound, not a tunable: a component that re-renders
		// this many times without settling is looping, and a hung test is a worse
		// failure than a loud one.
		assert.ok(renders < 50, "the settings tab re-rendered without settling");
		cursor = 0;
		tree = (component as () => unknown)();
		while (pendingEffects.length > 0) (pendingEffects.shift() as () => unknown)();
	};

	const react = {
		useState: (initial: unknown): [unknown, (next: unknown) => void] => {
			const slot = cell();
			if (!slot.initialised) {
				slot.initialised = true;
				slot.value = typeof initial === "function" ? (initial as () => unknown)() : initial;
			}
			return [
				slot.value,
				(next: unknown) => {
					slot.value = typeof next === "function" ? (next as (previous: unknown) => unknown)(slot.value) : next;
					render();
				},
			];
		},
		useCallback: (fn: unknown, deps: readonly unknown[]): unknown => {
			const slot = cell();
			if (!sameDeps(slot.deps, deps)) {
				slot.deps = deps;
				slot.value = fn;
			}
			return slot.value;
		},
		useEffect: (fn: () => unknown, deps: readonly unknown[]): void => {
			const slot = cell();
			if (!sameDeps(slot.deps, deps)) {
				slot.deps = deps;
				pendingEffects.push(fn);
			}
		},
	};

	const jsx = (type: unknown, props: Record<string, unknown>): StubElement => ({ type, props });

	return {
		modules: { react, "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: Symbol.for("react.fragment") } },
		mount(target: () => unknown): void {
			component = target;
			render();
		},
		tree: () => tree,
	};
}

/**
 * Every element in a rendered tree, depth first.
 * @param node - a tree, an element, an array of children, or a leaf.
 * @param found - accumulator.
 * @returns the elements found.
 */
export function elements(node: unknown, found: StubElement[] = []): StubElement[] {
	if (Array.isArray(node)) {
		for (const child of node) elements(child, found);
		return found;
	}
	if (typeof node !== "object" || node === null) return found;
	const element = node as Partial<StubElement>;
	if (typeof element.props !== "object" || element.props === null) return found;
	found.push(element as StubElement);
	return elements(element.props["children"], found);
}

/** Let every pending promise chain settle. */
export async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

/** One call the tab made through the connection service. */
export interface RecordedCall {
	readonly route: string;
	readonly endpoint: string;
	readonly payload: unknown;
}
