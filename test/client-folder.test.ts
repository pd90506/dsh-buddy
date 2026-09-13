import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { MAIN_PANEL_KEY } from "../src/index.ts";
import { contextStub, createRenderer, elements, loadClient, settle, type RecordedCall, type StubElement } from "./support/client-harness.ts";

const nodeRequire = createRequire(import.meta.url);

const SESSIONS = [
	{ sessionId: "s-tg", title: "Telegram: Panda", updatedAt: 3, cwd: "/w", source: "telegram" },
	{ sessionId: "s-web", title: "", updatedAt: 1, cwd: "/w", source: "web" },
];

function mountFolder(options: { wide?: boolean; current?: string } = {}) {
	const renderer = createRenderer();
	const calls: RecordedCall[] = [];
	const actions: { service: string; arg: unknown }[] = [];
	const listeners: (() => void)[] = [];
	let current = options.current;
	const client = loadClient((name) => renderer.modules[name] ?? nodeRequire(name));
	const { ctx, registrations } = contextStub({
		rpc: {
			call: async (route, endpoint, payload) => {
				calls.push({ route, endpoint, payload });
				return { ok: true, value: SESSIONS };
			},
		},
		sessions: {
			open: (id: string) => actions.push({ service: "sessions.open", arg: id }),
			refresh: async () => undefined,
			list: {
				getSnapshot: () => ({ current }),
				subscribe: (listener: () => void) => {
					listeners.push(listener);
					return () => undefined;
				},
			},
		},
		layout: { selectPanel: (id: unknown) => actions.push({ service: "layout.selectPanel", arg: id }) },
	});
	client.apply(ctx);
	const folder = registrations.find((r) => r.options.name === "sidebar.footer.action");
	assert.ok(folder !== undefined);
	const Component = folder.component as (props: { wide: boolean }) => unknown;
	renderer.mount(() => Component({ wide: options.wide ?? true }));
	return {
		calls,
		actions,
		tree: () => renderer.tree(),
		changeList(next: string | undefined) {
			current = next;
			for (const listener of listeners) listener();
		},
	};
}

function byLabel(tree: unknown, label: string): StubElement {
	const found = elements(tree).find((e) => e.type === "button" && e.props["aria-label"] === label);
	assert.ok(found !== undefined, `no button labelled "${label}"`);
	return found;
}

test("clicking the folder title opens the Buddy main panel", async () => {
	const folder = mountFolder();
	await settle();
	(byLabel(folder.tree(), "settings.buddy:folderTitle").props["onClick"] as () => void)();
	assert.deepEqual(folder.actions, [{ service: "layout.selectPanel", arg: MAIN_PANEL_KEY }]);
});

test("the folder starts collapsed and loads nothing until expanded", async () => {
	const folder = mountFolder();
	await settle();
	// `expected` typed explicitly: `node:assert/strict`'s deepEqual is
	// `<T>(actual: unknown, expected: T): asserts actual is T`, so a bare `[]`
	// infers T as `never[]` and narrows `folder.calls` to `never[]` for the rest
	// of this test, breaking the `.map((call) => call.endpoint)` call below.
	assert.deepEqual(folder.calls, [] as RecordedCall[]);
	(byLabel(folder.tree(), "settings.buddy:expand").props["onClick"] as () => void)();
	await settle();
	assert.deepEqual(folder.calls.map((call) => call.endpoint), ["buddyPersona/sessions"]);
	const shown = elements(folder.tree()).map((e) => e.props["children"]);
	assert.ok(shown.includes("Telegram: Panda"));
	assert.ok(shown.includes("settings.buddy:untitled"));
	assert.ok(shown.includes("settings.buddy:fromTelegram"), "a telegram conversation carries its badge");
});

test("clicking a conversation opens it and leaves the panel", async () => {
	const folder = mountFolder();
	await settle();
	(byLabel(folder.tree(), "settings.buddy:expand").props["onClick"] as () => void)();
	await settle();
	(byLabel(folder.tree(), "Telegram: Panda").props["onClick"] as () => void)();
	assert.deepEqual(folder.actions, [
		{ service: "sessions.open", arg: "s-tg" },
		{ service: "layout.selectPanel", arg: null },
	]);
});

test("the open conversation is highlighted and a session-list change reloads the expanded folder", async () => {
	const folder = mountFolder({ current: "s-web" });
	await settle();
	(byLabel(folder.tree(), "settings.buddy:expand").props["onClick"] as () => void)();
	await settle();
	assert.equal(byLabel(folder.tree(), "settings.buddy:untitled").props["aria-current"], "true");
	const before = folder.calls.length;
	// Three list changes in quick succession — the shape of a streaming/title
	// snapshot storm — must coalesce into a single reload once the debounce
	// window elapses, not one `buddyPersona/sessions` call per snapshot.
	folder.changeList("s-tg");
	folder.changeList("s-tg");
	folder.changeList("s-tg");
	// Real time, past the production 500ms debounce; this test drives the
	// actual `reloadDelayMs` the plugin ships, not a fake-timer stand-in.
	await new Promise((resolve) => setTimeout(resolve, 600));
	await settle();
	assert.equal(folder.calls.length, before + 1, "three rapid list changes must coalesce into exactly one reload");
	assert.equal(byLabel(folder.tree(), "Telegram: Panda").props["aria-current"], "true");
});

test("in the narrow rail only the icon renders, and it opens the panel", async () => {
	const folder = mountFolder({ wide: false });
	await settle();
	const buttons = elements(folder.tree()).filter((e) => e.type === "button");
	assert.equal(buttons.length, 1);
	(buttons[0]?.props["onClick"] as () => void)();
	assert.deepEqual(folder.actions, [{ service: "layout.selectPanel", arg: MAIN_PANEL_KEY }]);
});
