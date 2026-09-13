/**
 * Self-tests for `test/support/client-harness.ts`'s `createRenderer`.
 *
 * Task 11's first pass called a module's component directly
 * (`module.Component()`) instead of returning `<module.Component />` from
 * JSX, because the renderer at the time never expanded a nested element whose
 * `type` was a function — it only ever invoked the one component handed to
 * `mount()`. That masked two real bugs a genuine nested tree needs covered:
 * a shared flat hook-cell array cannot enforce the Rules of Hooks per
 * component, and it cannot give two sibling instances (or the same module
 * across renders) independent state. These two tests pin the fix directly
 * against the harness, without going through the built bundle.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRenderer } from "./support/client-harness.ts";

/** The stub `react` module's hook surface, as these tests drive it directly. */
interface StubReact {
	useState<T>(initial: T | (() => T)): [T, (next: T | ((previous: T) => T)) => void];
}

/** The stub JSX runtime's factory, as these tests drive it directly. */
interface StubJsxRuntime {
	jsx(type: unknown, props: Record<string, unknown>, key?: unknown): unknown;
}

test("a component that conditionally calls an extra hook fails the Rules of Hooks check", () => {
	const renderer = createRenderer();
	const { useState } = renderer.modules["react"] as StubReact;
	let setFlag: ((next: boolean) => void) | undefined;

	function Flaky(): unknown {
		const [flag, setF] = useState(false);
		setFlag = setF;
		// Only called once the flag flips to true — an extra hook on the second
		// render, exactly what the Rules of Hooks forbid.
		if (flag) useState(0);
		return null;
	}

	renderer.mount(Flaky);
	assert.throws(
		() => (setFlag as (next: boolean) => void)(true),
		(error: unknown) => error instanceof Error && /Flaky/.test(error.message) && /Rules of Hooks/.test(error.message),
		"a hook count that changes between renders must throw, naming the component",
	);
});

test("nested components keep independent state across re-renders", () => {
	const renderer = createRenderer();
	const { useState } = renderer.modules["react"] as StubReact;
	const { jsx } = renderer.modules["react/jsx-runtime"] as StubJsxRuntime;
	const seenCounts: Record<string, number> = {};
	let bumpA: ((next: number) => void) | undefined;
	let bumpParent: ((next: number) => void) | undefined;

	function Child(props: { id: string }): unknown {
		const [count, setCount] = useState(0);
		seenCounts[props.id] = count;
		if (props.id === "a") bumpA = setCount;
		return jsx("span", { children: `${props.id}:${String(count)}` });
	}

	function Parent(): unknown {
		const [tick, setTick] = useState(0);
		bumpParent = setTick;
		return jsx("div", {
			children: [jsx(Child, { id: "a" }, "a"), jsx(Child, { id: "b" }, "b"), `tick:${String(tick)}`],
		});
	}

	renderer.mount(Parent);
	assert.deepEqual(seenCounts, { a: 0, b: 0 });

	(bumpA as (next: number) => void)(5);
	assert.deepEqual(seenCounts, { a: 5, b: 0 }, "only the bumped child's own state changes");

	// A parent-triggered re-render walks the whole tree again (there is no
	// finer-grained invalidation in this stub), but each child's identity is
	// addressed by its own `key`, so its hook cells — and its state — must
	// survive that walk untouched.
	(bumpParent as (next: number) => void)(1);
	assert.deepEqual(seenCounts, { a: 5, b: 0 }, "a parent-triggered re-render must not reset a child's own state");
});
