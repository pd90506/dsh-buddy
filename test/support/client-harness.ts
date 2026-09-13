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
	// Keyed by namespace, holding the `en` half of whatever was last registered
	// there — just enough for `bind` to answer a function-valued key (see below)
	// without turning every string key's synthetic label into the real copy,
	// which every id/order/label test in this file depends on staying literal.
	const registeredEnglish = new Map<string, Record<string, unknown>>();
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
			// plugin's own bound lookup rather than a bare global key — for an
			// ordinary string-valued key. A function-valued key (e.g.
			// `telegramStatusSessions`) cannot be represented that way at all: the
			// component calls what `t(key)` returns, so this falls back to the real
			// registered function, looked up lazily (register always runs before
			// any render reads it, even though `bind` itself is called first in
			// `apply()`).
			bind: (ns: string) => (key: string) => {
				const value = registeredEnglish.get(ns)?.[key];
				return typeof value === "function" ? value : `${ns}:${key}`;
			},
			register: (ns: string, dictionary: Record<string, unknown>) => {
				dictionaries.push({ ns, dictionary, insideEffect: depth > 0 });
				const english = (dictionary as { en?: Record<string, unknown> }).en;
				if (english !== undefined) registeredEnglish.set(ns, english);
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
		sessions: options.sessions ?? { list: { getSnapshot: () => ({}), subscribe: () => () => undefined } },
		remote: options.remote,
	};
	return { ctx, registrations, injected, effects, dictionaries };
}

/** One hook's storage across renders, scoped to one component instance. */
interface HookCell {
	value: unknown;
	deps: readonly unknown[] | undefined;
	initialised: boolean;
}

/** An element as the stub JSX runtime builds it. */
export interface StubElement {
	readonly type: unknown;
	readonly props: Record<string, unknown>;
	/** The JSX `key`, when the automatic runtime received one (its 3rd `jsx()` argument). */
	readonly key?: unknown;
}

/**
 * One rendered component instance: its own hook cells and cursor, addressed by
 * its position in the tree (see {@link resolvePath}) rather than by a single
 * shared array. This is what lets two sibling modules — or the same module
 * across renders — keep independent `useState` without stepping on each
 * other's cells the way one flat array would.
 */
interface Instance {
	type: (props: unknown) => unknown;
	cells: HookCell[];
	cursor: number;
	/** Hook count from the previous completed render, `undefined` before the first. */
	hookCount: number | undefined;
}

/** A mounted component: its current tree, re-rendered on every state change. */
interface Mounted {
	/** Modules the bundle's `require` must resolve to reach these hooks. */
	readonly modules: Record<string, unknown>;
	/** Render the component for the first time. */
	mount(component: () => unknown): void;
	/** The element tree produced by the most recent render, with every nested component already expanded. */
	tree(): unknown;
}

/**
 * A renderer with a real (if minimal) reconciler.
 *
 * The tab's save gate is a `disabled` prop computed from state the mount load
 * sets, so proving it needs *some* renderer — and this repo deliberately has no
 * `react-dom`. Rather than grow one as a dependency, the bundle's own `require`
 * is pointed at these stubs: `useState` re-renders synchronously, `useCallback`
 * and `useEffect` honour their dependency lists (without that the mount effect
 * would re-fire forever), and the JSX runtime returns plain `{ type, props, key }`.
 *
 * Task 11 introduced a genuinely nested tree (`BuddyPanel` rendering
 * `<module.Component />` per module), which the original version of this
 * renderer could not support: it called only the mounted function once and
 * left every nested function-type element as an inert `{ type, props }` object
 * — real React invokes every component it encounters during render, this did
 * not. Worse, a single flat hook-cell array shared by every component would
 * have *looked* like it worked (state slots just kept growing) while silently
 * breaking the Rules of Hooks the moment a module's own hook count changed
 * between renders, or a module was conditionally shown or hidden.
 *
 * So rendering here is a small recursive walk (`resolve`, below): every
 * element whose `type` is a function is invoked, using an {@link Instance}
 * addressed by its structural path in the tree (parent path + array index or
 * `key`) so the SAME module keeps the SAME hook cells across renders, and a
 * module that stops being visible has its instance (and its state) dropped.
 * `invoke` enforces the Rules of Hooks per instance: a hook count that changes
 * between one render and the next throws, naming the component, exactly as
 * React's own `ERR_HOOK_COUNT_MISMATCH` would.
 * @returns the stub modules and the mount handle.
 */
export function createRenderer(): Mounted {
	const pendingEffects: (() => unknown)[] = [];
	const instances = new Map<string, Instance>();
	const instanceStack: Instance[] = [];
	let renders = 0;
	let root: ((props: unknown) => unknown) | undefined;
	let tree: unknown;

	const sameDeps = (previous: readonly unknown[] | undefined, next: readonly unknown[]): boolean =>
		previous !== undefined && previous.length === next.length && previous.every((v, i) => Object.is(v, next[i]));

	const componentName = (type: (props: unknown) => unknown): string => (type as { name?: string }).name || "anonymous component";

	const cell = (): HookCell => {
		const instance = instanceStack[instanceStack.length - 1];
		assert.ok(instance !== undefined, "a hook was called outside of a component render");
		const existing = instance.cells[instance.cursor];
		const slot = existing ?? { value: undefined, deps: undefined, initialised: false };
		if (existing === undefined) instance.cells[instance.cursor] = slot;
		instance.cursor += 1;
		return slot;
	};

	/** Get this path's instance, or start a fresh one — a new path is an ordinary mount, never a Rules-of-Hooks violation. */
	const instanceAt = (path: string, type: (props: unknown) => unknown): Instance => {
		const existing = instances.get(path);
		if (existing !== undefined && existing.type === type) return existing;
		const created: Instance = { type, cells: [], cursor: 0, hookCount: undefined };
		instances.set(path, created);
		return created;
	};

	/** Invoke one component instance and enforce its own Rules of Hooks across renders. */
	const invoke = (instance: Instance, props: unknown): unknown => {
		instance.cursor = 0;
		instanceStack.push(instance);
		let result: unknown;
		try {
			result = instance.type(props);
		} finally {
			instanceStack.pop();
		}
		if (instance.hookCount !== undefined) {
			assert.strictEqual(
				instance.cursor,
				instance.hookCount,
				`${componentName(instance.type)} called ${String(instance.cursor)} hook(s) this render but ${String(instance.hookCount)} on the previous render — hooks must run unconditionally, in the same order, on every render (Rules of Hooks)`,
			);
		}
		instance.hookCount = instance.cursor;
		return result;
	};

	/** A stable suffix for one child's path: its `key` when the element carries one, else its position. */
	const step = (index: number, key: unknown): string => (key !== undefined ? `#${String(key)}` : `.${String(index)}`);

	/**
	 * Recursively expand every function-type element in a rendered value.
	 * @param node - a tree, an element, an array of children, or a leaf.
	 * @param path - this node's structural address, unique among its siblings across renders.
	 * @param seen - every instance path touched this render, so a dropped instance's state is freed.
	 * @returns the same shape with every nested component replaced by what it rendered.
	 */
	const resolve = (node: unknown, path: string, seen: Set<string>): unknown => {
		if (Array.isArray(node)) {
			return node.map((child, index) => resolve(child, path + step(index, (child as Partial<StubElement>)?.key), seen));
		}
		if (node === null || typeof node !== "object") return node;
		const element = node as StubElement;
		if (typeof element.type === "function") {
			seen.add(path);
			const rendered = invoke(instanceAt(path, element.type as (props: unknown) => unknown), element.props);
			// A distinct suffix for what the instance rendered, so its own output
			// never collides with the instance's own address in `instances`.
			return resolve(rendered, `${path}/body`, seen);
		}
		if (typeof element.props !== "object" || element.props === null) return node;
		const children = element.props["children"];
		if (children === undefined) return element;
		return { ...element, props: { ...element.props, children: resolve(children, `${path}.c`, seen) } };
	};

	const render = (): void => {
		renders += 1;
		// An internal liveness bound, not a tunable: a component that re-renders
		// this many times without settling is looping, and a hung test is a worse
		// failure than a loud one.
		assert.ok(renders < 50, "the component re-rendered without settling");
		assert.ok(root !== undefined, "render() called before mount()");
		const seen = new Set<string>(["root"]);
		const rootOutput = invoke(instanceAt("root", root), undefined);
		tree = resolve(rootOutput, "root/body", seen);
		// Drop state for any instance this render never reached — a module that
		// stopped being visible unmounts, it does not keep its old draft around.
		for (const key of instances.keys()) if (!seen.has(key)) instances.delete(key);
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

	// `key` is the automatic JSX runtime's 3rd positional argument (extracted
	// from `props` by the transform, never left inside it) — carried onto the
	// stub element so `resolve` can address a keyed list item stably across
	// renders instead of falling back to array position.
	const jsx = (type: unknown, props: Record<string, unknown>, key?: unknown): StubElement =>
		key === undefined ? { type, props } : { type, props, key };

	return {
		modules: { react, "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: Symbol.for("react.fragment") } },
		mount(target: () => unknown): void {
			root = target as (props: unknown) => unknown;
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
