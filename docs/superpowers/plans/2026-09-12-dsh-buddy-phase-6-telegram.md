# dsh-buddy Phase 6 (Telegram + main panel) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Absorb the dsh-telegram plugin into dsh-buddy as a `dsh-buddy/telegram` row whose sessions always use the `buddy` preset, give Buddy a default model, and restructure the browser half into a modular Buddy main panel opened from a sidebar folder above Settings.

**Architecture:** The dsh-telegram host source is copied verbatim into `src/telegram/` and then changed in small, separately tested steps: identity (names, settings namespace `buddy-telegram`, domain `buddy_telegram`), fixed fail-closed `buddy` preset, model precedence, English copy, one-shot settings migration, and an occupancy guard against the still-installed dsh-telegram. Buddy's own settings gain `model` and `panel.sections`; `buddyStore` exposes them. The browser half becomes: a slim Settings → Buddy tab (module visibility), a `main` panel built from a module table (Soul, Agents, Model, Telegram) with a New Buddy conversation button, and a `sidebar.footer.action` folder listing buddy conversations.

**Tech Stack:** TypeScript compiled by esbuild, `@deepseek-ai/cordis`, `@deepseek-ai/dsh-storage-domain`, `@deepseek-ai/dsh-settings`, `@deepseek-ai/dsh-credentials`, `@deepseek-ai/dsh-agent`, `@deepseek-ai/schemastery`, `zod`, React 19 (external), `node:test`.

**Spec:** `docs/superpowers/specs/2026-09-12-buddy-telegram-design.md`

## Global Constraints

Everything in `CLAUDE.md` → "Invariants" applies. In addition:

- Settings namespaces: `buddy` (existing), `buddy-telegram` (new; settings grammar `/^[a-z][a-z0-9-]*$/`).
- Storage domains: `buddy` (existing), `buddy_telegram` (new; storage grammar `/^[a-z][a-z0-9_]*$/`).
- Credential key: `TELEGRAM_BOT_TOKEN` — unchanged, shared with dsh-telegram.
- Typert: the persona gateway keeps package `dsh-buddy`, namespace `buddyPersona`. The Telegram gateway uses package `dsh-buddy-telegram`, namespace and cordis service key `buddyTelegram`. A typert package may be registered only once.
- New row: id `buddy-telegram`, name `dsh-buddy/telegram`, artifact `lib/telegram.js`, `inject = ["typert", "storageDomain", "buddyStore"]`.
- Preset id: `BUDDY_PRESET_ID` (`"buddy"`) imported from `src/index.ts`, never restated. Resolution failure never falls back to another preset.
- Model precedence: chat-local `/model` > Buddy default (`buddy.model`, used only when provider and model are both non-empty) > global `agentDefaultModel.currentSelection()`.
- Default working directory for new installs: `~/buddy-workspace` (`BUDDY_WORKSPACE_DEFAULT` in `src/index.ts`). Never the buddy home.
- Every string the bot sends to Telegram is English. Browser UI strings keep en + zh dictionaries with identical keys.
- Telegram commands: exactly `/new`, `/model`, `/stop`, `/help`.
- Never edit `~/repo/dsh-plugins/dsh-telegram`. It is the rollback path.
- Never touch the user's live dsh instance (`dsh-web.service`) or poll the real bot token from a probe. Task 15 (cutover) starts only after the user confirms in chat.
- Main-panel module ids: `soul`, `agents`, `model`, `telegram` (this order).

---

## File Structure

```
src/
├── index.ts                  # + BUDDY_WORKSPACE_DEFAULT
├── config.ts                 # + model, panel.sections, PANEL_SECTION_IDS
├── model-selection.ts        # NEW pure: ModelSelection, selectionFromDefault, resolveModelSelection
├── store/index.ts            # BuddyStore.config() / updateConfig()
├── persona/
│   ├── index.ts              # preferences endpoints wiring; sessions carry `source`
│   └── gateway.ts            # + preferences / updatePreferences; BuddySessionSummary.source
├── telegram/                 # NEW — copied from dsh-telegram/src (no client/)
│   ├── index.ts              # row entry (identity, migration, guard, buddy wiring)
│   ├── migrate.ts            # NEW one-shot settings migration
│   ├── occupancy.ts          # NEW legacy dsh-telegram guard
│   ├── session.ts            # fixed preset, fail-closed, model precedence, origins
│   ├── store.ts              # domain buddy_telegram (+ origins table)
│   ├── gateway.ts            # buddyTelegram service
│   ├── runtime.ts approvals.ts files.ts model.ts config.ts credentials.ts credential-key.ts
│   └── telegram/{api,deliver,markdown,media,merge,render}.ts
└── client/
    ├── index.tsx             # registrations only
    ├── call.ts               # unchanged
    ├── modules.ts            # NEW pure: module table + visibility filter
    ├── document-module.tsx   # NEW Soul / Agents editor module
    ├── model-module.tsx      # NEW Model module
    ├── telegram-module.tsx   # NEW Telegram module (ported from dsh-telegram tab)
    ├── panel.tsx             # main panel host (module table + New Buddy conversation)
    ├── folder.tsx            # NEW sidebar folder
    └── settings.tsx          # slim meta settings
test/
├── support/client-harness.ts # NEW — helpers extracted from client-ui.test.ts
├── client-ui.test.ts         # registrations + call.ts (trimmed)
├── client-panel.test.ts      # NEW main panel + modules
├── client-folder.test.ts     # NEW sidebar folder
├── client-settings.test.ts   # NEW slim settings
├── model-selection.test.ts   # NEW
├── preferences.test.ts       # NEW persona preferences endpoints
└── telegram/                 # NEW — copied from dsh-telegram/test (no client.test.ts)
    ├── english-copy.test.ts  # NEW CJK scan
    ├── migrate.test.ts       # NEW
    └── occupancy.test.ts     # NEW
```

---

### Task 1: Buddy config gains `model` and `panel.sections`; pure model precedence

**Files:**
- Modify: `src/index.ts`
- Modify: `src/config.ts`
- Create: `src/model-selection.ts`
- Modify: `src/store/index.ts`
- Test: `test/config.test.ts`, `test/model-selection.test.ts`, `test/store.test.ts`

**Interfaces:**
- Produces:
  - `src/index.ts`: `export const BUDDY_WORKSPACE_DEFAULT = "~/buddy-workspace";`
  - `src/config.ts`: `PANEL_SECTION_IDS`, `type PanelSectionId`, `interface BuddyModelDefault { provider: string; model: string; reasoningEffort: string }`, `interface BuddyConfig { home: string; model: BuddyModelDefault; panel: { sections: Record<PanelSectionId, boolean> } }`, `FALLBACK_CONFIG`, `Config`.
  - `src/model-selection.ts`: `interface ModelSelection { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }`, `selectionFromDefault(value: BuddyModelDefault): ModelSelection | undefined`, `resolveModelSelection(chatLocal, buddyDefault, globalDefault): ModelSelection | undefined`.
  - `BuddyStore.config(): BuddyConfig`, `BuddyStore.updateConfig(patch: Partial<Pick<BuddyConfig, "model" | "panel">>): Promise<void>`.

- [ ] **Step 1: Write the failing config tests**

Replace `test/config.test.ts` with:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { Config, FALLBACK_CONFIG, PANEL_SECTION_IDS } from "../src/config.ts";

test("a silent document produces the documented defaults", () => {
	const resolved = Config({});
	assert.equal(resolved.home, "");
	assert.deepEqual(resolved.model, { provider: "", model: "", reasoningEffort: "" });
	assert.deepEqual(resolved.panel, { sections: { soul: true, agents: true, model: true, telegram: true } });
});

test("the fallback matches the schema defaults", () => {
	assert.deepEqual(JSON.parse(JSON.stringify(FALLBACK_CONFIG)), JSON.parse(JSON.stringify(Config({}))));
});

test("an explicit home survives resolution", () => {
	assert.equal(Config({ home: "~/elsewhere" }).home, "~/elsewhere");
});

test("a partial model and a partial panel are completed from defaults", () => {
	const resolved = Config({ model: { provider: "p" }, panel: { sections: { telegram: false } } } as never);
	assert.deepEqual(resolved.model, { provider: "p", model: "", reasoningEffort: "" });
	assert.deepEqual(resolved.panel.sections, { soul: true, agents: true, model: true, telegram: false });
});

test("the panel section ids are the four modules, in display order", () => {
	assert.deepEqual([...PANEL_SECTION_IDS], ["soul", "agents", "model", "telegram"]);
});
```

- [ ] **Step 2: Write the failing model-selection tests**

Create `test/model-selection.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveModelSelection, selectionFromDefault } from "../src/model-selection.ts";

const chat = { provider: "chat-p", model: "chat-m" };
const buddy = { provider: "buddy-p", model: "buddy-m", reasoningEffort: "high" };
const global = { provider: "global-p", model: "global-m" };

test("a chat-local choice wins over everything", () => {
	assert.deepEqual(resolveModelSelection(chat, buddy, global), chat);
});

test("the buddy default wins over the global default", () => {
	assert.deepEqual(resolveModelSelection(undefined, buddy, global), buddy);
});

test("the global default applies when nothing else is set", () => {
	assert.deepEqual(resolveModelSelection(undefined, undefined, global), global);
	assert.equal(resolveModelSelection(undefined, undefined, undefined), undefined);
});

test("an incomplete buddy default is no default", () => {
	assert.equal(selectionFromDefault({ provider: "", model: "", reasoningEffort: "" }), undefined);
	assert.equal(selectionFromDefault({ provider: "p", model: "", reasoningEffort: "high" }), undefined);
	assert.equal(selectionFromDefault({ provider: "", model: "m", reasoningEffort: "" }), undefined);
});

test("an empty reasoning effort is omitted, not sent as an empty string", () => {
	assert.deepEqual(selectionFromDefault({ provider: "p", model: "m", reasoningEffort: "" }), { provider: "p", model: "m" });
	assert.deepEqual(selectionFromDefault({ provider: "p", model: "m", reasoningEffort: "low" }), {
		provider: "p",
		model: "m",
		reasoningEffort: "low",
	});
});
```

- [ ] **Step 3: Run both to verify they fail**

Run: `node --test test/config.test.ts test/model-selection.test.ts`
Expected: FAIL — `PANEL_SECTION_IDS` is not exported; `../src/model-selection.ts` not found.

- [ ] **Step 4: Implement config and model selection**

Append to `src/index.ts`:

```ts
/**
 * Working directory for buddy conversations that have no other: new web
 * conversations, and Telegram when `buddy-telegram.defaultCwd` is empty.
 *
 * Deliberately not the buddy home: an agent working there could rewrite its own
 * SOUL.md and AGENTS.md, and self-modification is a later phase's decision.
 */
export const BUDDY_WORKSPACE_DEFAULT = "~/buddy-workspace";
```

Replace the body of `src/config.ts` below the imports (keep the module doc comment, extending it with one sentence: "`model` and `panel` are Buddy-wide preferences edited from the Buddy main panel and the slim Settings tab."):

```ts
import z from "@deepseek-ai/schemastery";
import { SETTINGS_NAMESPACE } from "./index.ts";

export { SETTINGS_NAMESPACE };

/** Main-panel module ids, in display order. */
export const PANEL_SECTION_IDS = ["soul", "agents", "model", "telegram"] as const;

/** One main-panel module id. */
export type PanelSectionId = (typeof PANEL_SECTION_IDS)[number];

/** Buddy's own default model; all-empty means "follow the global default". */
export interface BuddyModelDefault {
	provider: string;
	model: string;
	/** Empty means the model's own default effort. */
	reasoningEffort: string;
}

/** Shape of the `buddy` settings section. */
export interface BuddyConfig {
	/**
	 * Buddy home directory. Empty means the harness home's `buddy/`, which is
	 * what almost every deployment wants; a `~` prefix is expanded.
	 */
	home: string;
	/** Default model for newly created buddy conversations. */
	model: BuddyModelDefault;
	/** Which main-panel modules are shown. */
	panel: { sections: Record<PanelSectionId, boolean> };
}

/** Defaults used before the settings section resolves. */
export const FALLBACK_CONFIG: BuddyConfig = {
	home: "",
	model: { provider: "", model: "", reasoningEffort: "" },
	panel: { sections: { soul: true, agents: true, model: true, telegram: true } },
};

/**
 * The settings schema; defaults apply when the user document is silent.
 *
 * Both type arguments are deliberate. `z<T>` is `Schemastery<T, T>`, which would
 * claim every field is required *on input* — but a settings document is silent
 * by design, and `Config({})` is the case the defaults exist to serve. The pair
 * states what the schema actually does: a partial document in, a complete config
 * out. Collapsing this to `z<BuddyConfig>` breaks `test/config.test.ts`.
 *
 * Nested objects carry both an object-level default (for an absent key) and
 * field-level defaults (for a partial object).
 */
export const Config: z<Partial<BuddyConfig>, BuddyConfig> = z.object({
	home: z
		.string()
		.default("")
		.description("Buddy home directory holding SOUL.md and AGENTS.md; empty means <harness home>/buddy"),
	model: z
		.object({
			provider: z.string().default("").description("Provider id; empty follows the global default model"),
			model: z.string().default("").description("Model id; empty follows the global default model"),
			reasoningEffort: z.string().default("").description("Reasoning effort id; empty uses the model's default"),
		})
		.default({ ...FALLBACK_CONFIG.model })
		.description("Default model for new buddy conversations"),
	panel: z
		.object({
			sections: z
				.object({
					soul: z.boolean().default(true),
					agents: z.boolean().default(true),
					model: z.boolean().default(true),
					telegram: z.boolean().default(true),
				})
				.default({ ...FALLBACK_CONFIG.panel.sections }),
		})
		.default({ sections: { ...FALLBACK_CONFIG.panel.sections } })
		.description("Which modules the Buddy main panel shows"),
}) as never;
```

Create `src/model-selection.ts`:

```ts
/**
 * Which model a new buddy conversation starts on.
 *
 * Pure and dependency-free on purpose: the Telegram row and the browser's
 * New Buddy conversation button both apply the same precedence, and the browser
 * bundle must not pull in a host module to do it.
 * @module dsh-buddy/model-selection
 */
import type { BuddyModelDefault } from "./config.ts";

/** A concrete model route, as the harness's session APIs accept it. */
export interface ModelSelection {
	readonly provider: string;
	readonly model: string;
	readonly reasoningEffort?: string;
}

/**
 * Buddy's stored default as a selection.
 * @param value - the `buddy.model` settings value.
 * @returns the selection, or `undefined` when provider or model is empty.
 */
export function selectionFromDefault(value: BuddyModelDefault): ModelSelection | undefined {
	if (value.provider === "" || value.model === "") return undefined;
	return value.reasoningEffort === ""
		? { provider: value.provider, model: value.model }
		: { provider: value.provider, model: value.model, reasoningEffort: value.reasoningEffort };
}

/**
 * Apply the precedence: chat-local, then Buddy default, then global default.
 * @param chatLocal - a per-chat `/model` choice.
 * @param buddyDefault - `selectionFromDefault(buddy.model)`.
 * @param globalDefault - the harness's global default selection.
 * @returns the first defined selection.
 */
export function resolveModelSelection(
	chatLocal: ModelSelection | undefined,
	buddyDefault: ModelSelection | undefined,
	globalDefault: ModelSelection | undefined,
): ModelSelection | undefined {
	return chatLocal ?? buddyDefault ?? globalDefault;
}
```

- [ ] **Step 5: Run to verify they pass**

Run: `node --test test/config.test.ts test/model-selection.test.ts`
Expected: PASS. If `Config({ model: { provider: "p" } })` leaves `model`/`reasoningEffort` undefined, schemastery is not applying field defaults inside a supplied object; in that case keep the field-level `.default("")` calls (already present) and verify `@deepseek-ai/schemastery` is the installed version from `package.json` — do not fall back to post-processing in code.

- [ ] **Step 6: Write the failing store test**

Add to `test/store.test.ts` (next to the existing `new BuddyStore(` cases, reusing that file's existing `ctx`/`paths`/`handle` fixtures exactly as the case at line ~125 builds them):

```ts
test("the store exposes the live config and writes preferences through the settings plane", async () => {
	const writes: { ns: string; patch: unknown }[] = [];
	let current: BuddyConfig = { ...FALLBACK_CONFIG, model: { provider: "p", model: "m", reasoningEffort: "" } };
	const { ctx, paths, handle } = await storeFixture();
	const store = new BuddyStore(ctx as unknown as Context, paths, handle, {
		read: () => current,
		write: async (patch) => {
			writes.push({ ns: SETTINGS_NAMESPACE, patch });
			current = { ...current, ...(patch as Partial<BuddyConfig>) };
		},
	});
	assert.equal(store.config().model.provider, "p");
	await store.updateConfig({ panel: { sections: { soul: true, agents: true, model: true, telegram: false } } });
	assert.deepEqual(writes, [
		{ ns: "buddy", patch: { panel: { sections: { soul: true, agents: true, model: true, telegram: false } } } },
	]);
	assert.equal(store.config().panel.sections.telegram, false, "config() must read live, not a boot snapshot");
});

test("a store built without config access reports the fallback and refuses writes", async () => {
	const { ctx, paths, handle } = await storeFixture();
	const store = new BuddyStore(ctx as unknown as Context, paths, handle);
	assert.deepEqual(store.config(), FALLBACK_CONFIG);
	await assert.rejects(() => store.updateConfig({ model: FALLBACK_CONFIG.model }), /settings service is unavailable/);
});
```

If `test/store.test.ts` has no `storeFixture()` helper, extract one from the setup the existing `new BuddyStore(` case at line ~125 performs (it must return `{ ctx, paths, handle }`), and make that existing case call it too.

- [ ] **Step 7: Run to verify it fails**

Run: `node --test test/store.test.ts`
Expected: FAIL — `store.config is not a function`.

- [ ] **Step 8: Implement `config()` / `updateConfig()`**

In `src/store/index.ts`, import `FALLBACK_CONFIG` (already imported) and add above `class BuddyStore`:

```ts
/** Live access to the `buddy` settings section. */
export interface ConfigAccess {
	/** The resolved section, read at call time. */
	read(): BuddyConfig;
	/** Merge a patch into the section through the settings plane. */
	write(patch: Partial<Pick<BuddyConfig, "model" | "panel">>): Promise<void>;
}

/** Used when the row runs without a settings plane. */
const NO_SETTINGS: ConfigAccess = {
	read: () => FALLBACK_CONFIG,
	write: async () => {
		throw new Error("dsh-buddy: the settings service is unavailable");
	},
};
```

Inside `BuddyStore`, add the field, extend the constructor, and add the methods:

```ts
	private readonly configAccess: ConfigAccess;

	constructor(ctx: Context, paths: BuddyPaths, handle: BuddyDomainHandle, configAccess: ConfigAccess = NO_SETTINGS) {
		super(ctx, "buddyStore");
		this.paths = paths;
		this.handle = handle;
		this.configAccess = configAccess;
	}

	/**
	 * The `buddy` settings section as it reads now.
	 * @returns the resolved configuration.
	 */
	config(): BuddyConfig {
		return this.configAccess.read();
	}

	/**
	 * Write Buddy-wide preferences. `home` is deliberately not writable here: it
	 * is read once at boot and moving it under a live row strands open handles.
	 * @param patch - whole `model` and/or `panel` objects.
	 */
	async updateConfig(patch: Partial<Pick<BuddyConfig, "model" | "panel">>): Promise<void> {
		await this.configAccess.write(patch);
	}
```

In `apply`, where `new BuddyStore(ctx as unknown as Context, paths, opened);` is constructed, replace it with:

```ts
			new BuddyStore(ctx as unknown as Context, paths, opened, {
				read: () => readConfig(),
				write: async (patch) => {
					// `ctx.get`, never `ctx.settings`: settings is a scoped, soft dependency.
					const settings = ctx.get("settings") as
						| { update(ns: string, patch: Record<string, unknown>): Promise<void> }
						| undefined;
					if (settings === undefined) throw new Error("dsh-buddy: the settings service is unavailable");
					await settings.update(SETTINGS_NAMESPACE, patch);
				},
			});
```

- [ ] **Step 9: Run the gate**

Run: `npm run check`
Expected: typecheck clean, all tests PASS.

- [ ] **Step 10: Commit**

```bash
git add src/index.ts src/config.ts src/model-selection.ts src/store/index.ts test/config.test.ts test/model-selection.test.ts test/store.test.ts
git commit -m "feat: buddy settings gain a default model and panel module visibility"
```

---

### Task 2: Persona gateway serves preferences

**Files:**
- Modify: `src/persona/gateway.ts`
- Modify: `src/persona/index.ts`
- Test: `test/preferences.test.ts`, `test/gateway.test.ts`, `test/mount.test.ts`

**Interfaces:**
- Consumes: `BuddyStore.config()`, `BuddyStore.updateConfig()`, `BuddyConfig`, `PANEL_SECTION_IDS`, `BUDDY_WORKSPACE_DEFAULT`.
- Produces:
  - `interface PreferencesView { readonly model: BuddyModelDefault; readonly panel: { readonly sections: Record<PanelSectionId, boolean> }; readonly conversationCwd: string }` exported from `src/persona/gateway.ts`.
  - `GatewayDeps.readPreferences: () => Promise<PreferencesView>`, `GatewayDeps.writePreferences: (patch: Partial<Pick<BuddyConfig, "model" | "panel">>) => Promise<PreferencesView>`.
  - Wire: `buddyPersona/preferences` (no params), `buddyPersona/updatePreferences` (`{ patch }`).
  - Pure validator `cleanPreferencesPatch(current: BuddyConfig, patch: Record<string, unknown>): Partial<Pick<BuddyConfig, "model" | "panel">>` exported from `src/persona/gateway.ts`.

- [ ] **Step 1: Write the failing validator tests**

Create `test/preferences.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { FALLBACK_CONFIG } from "../src/config.ts";
import { cleanPreferencesPatch } from "../src/persona/gateway.ts";

test("a model patch is completed from the current model and only strings are accepted", () => {
	const current = { ...FALLBACK_CONFIG, model: { provider: "p", model: "m", reasoningEffort: "low" } };
	assert.deepEqual(cleanPreferencesPatch(current, { model: { model: "m2", reasoningEffort: 3 } }), {
		model: { provider: "p", model: "m2", reasoningEffort: "low" },
	});
});

test("a panel patch accepts only the known module ids with boolean values", () => {
	assert.deepEqual(
		cleanPreferencesPatch(FALLBACK_CONFIG, { panel: { sections: { telegram: false, soul: "no", rogue: false } } }),
		{ panel: { sections: { soul: true, agents: true, model: true, telegram: false } } },
	);
});

test("unknown top-level fields and malformed shapes produce an empty patch", () => {
	assert.deepEqual(cleanPreferencesPatch(FALLBACK_CONFIG, { home: "/elsewhere", model: "x", panel: [] }), {});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/preferences.test.ts`
Expected: FAIL — `cleanPreferencesPatch` is not exported.

- [ ] **Step 3: Implement the validator, the view and the endpoints**

In `src/persona/gateway.ts`:

Add imports:

```ts
import { PANEL_SECTION_IDS, type BuddyConfig, type BuddyModelDefault, type PanelSectionId } from "../config.ts";
```

Add below `PersonaView`:

```ts
/** What the Model module, the slim Settings tab and New Buddy conversation read. */
export interface PreferencesView {
	readonly model: BuddyModelDefault;
	readonly panel: { readonly sections: Record<PanelSectionId, boolean> };
	/** Absolute working directory for a new web buddy conversation; created on read. */
	readonly conversationCwd: string;
}

/** A plain-object field of an unknown record. */
function objectField(value: unknown, key: string): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const field = (value as Record<string, unknown>)[key];
	if (typeof field !== "object" || field === null || Array.isArray(field)) return undefined;
	return field as Record<string, unknown>;
}

/**
 * Validate a wire patch against the current configuration.
 *
 * Whole objects go out because the settings plane's merge depth is not part of
 * this plugin's contract: a `model` or `panel` write is always complete.
 * @param current - the configuration as it reads now.
 * @param patch - untrusted wire data.
 * @returns only the fields that validated, each completed from `current`.
 */
export function cleanPreferencesPatch(
	current: BuddyConfig,
	patch: Record<string, unknown>,
): Partial<Pick<BuddyConfig, "model" | "panel">> {
	const clean: { model?: BuddyModelDefault; panel?: BuddyConfig["panel"] } = {};
	const model = objectField(patch, "model");
	if (model !== undefined) {
		const next = { ...current.model };
		for (const key of ["provider", "model", "reasoningEffort"] as const) {
			if (typeof model[key] === "string") next[key] = model[key];
		}
		clean.model = next;
	}
	const sections = objectField(objectField(patch, "panel"), "sections");
	if (sections !== undefined) {
		const next = { ...current.panel.sections };
		for (const id of PANEL_SECTION_IDS) {
			if (typeof sections[id] === "boolean") next[id] = sections[id];
		}
		clean.panel = { sections: next };
	}
	return clean;
}
```

Note: `objectField(patch, "panel")` returning an array case (`panel: []`) yields `undefined`, so `sections` is `undefined` — the third test depends on that.

In `typertContribution()` add two invocations to the array:

```ts
			{ ...shared, id: `${TYPERT_PACKAGE}#preferences`, method: "preferences", parameters: [] },
			{
				...shared,
				id: `${TYPERT_PACKAGE}#updatePreferences`,
				method: "updatePreferences",
				parameters: [{ name: "patch", wire: "patch", ...json }],
			},
```

Extend `GatewayDeps`:

```ts
	/** Buddy-wide preferences. */
	readonly readPreferences: () => Promise<PreferencesView>;
	/** Apply an already-validated preferences write. */
	readonly writePreferences: (patch: Partial<Pick<BuddyConfig, "model" | "panel">>) => Promise<PreferencesView>;
	/** The configuration the validator completes patches from. */
	readonly currentConfig: () => BuddyConfig;
```

Add methods to `BuddyPersonaGateway`:

```ts
	/**
	 * Buddy-wide preferences.
	 * @returns model default, module visibility, and the conversation cwd.
	 */
	async preferences(): Promise<PreferencesView> {
		return await this.deps.readPreferences();
	}

	/**
	 * Write Buddy-wide preferences. Unknown or malformed fields are dropped.
	 * @param patch - `{ model?: Partial<BuddyModelDefault>, panel?: { sections?: Partial<Record<PanelSectionId, boolean>> } }`.
	 * @returns the preferences after the write.
	 */
	async updatePreferences(patch: Record<string, unknown>): Promise<PreferencesView> {
		const clean = cleanPreferencesPatch(this.deps.currentConfig(), patch);
		if (Object.keys(clean).length === 0) return await this.deps.readPreferences();
		return await this.deps.writePreferences(clean);
	}
```

Update the class doc comment to list the two new endpoints.

In `src/persona/index.ts`:

Add imports:

```ts
import { mkdir } from "node:fs/promises";
import { expandHomePath } from "@deepseek-ai/dsh-home-paths";
import { BUDDY_PRESET_ID, BUDDY_WORKSPACE_DEFAULT, SOUL_VARIABLE } from "../index.ts";
import type { BuddyConfig } from "../config.ts";
```

(and add `type PreferencesView` to the `./gateway.ts` import). Extend `PluginContext.buddyStore`:

```ts
		config(): BuddyConfig;
		updateConfig(patch: Partial<Pick<BuddyConfig, "model" | "panel">>): Promise<void>;
```

Before `new BuddyPersonaGateway(`:

```ts
	const preferences = async (): Promise<PreferencesView> => {
		const config = ctx.buddyStore.config();
		const conversationCwd = expandHomePath(BUDDY_WORKSPACE_DEFAULT);
		// Created here, not by the caller: the browser cannot mkdir, and the session
		// store rejects a cwd that does not exist.
		await mkdir(conversationCwd, { recursive: true });
		return { model: { ...config.model }, panel: { sections: { ...config.panel.sections } }, conversationCwd };
	};
```

Add to the deps object passed to the gateway:

```ts
		readPreferences: preferences,
		writePreferences: async (patch) => {
			await ctx.buddyStore.updateConfig(patch);
			return await preferences();
		},
		currentConfig: () => ctx.buddyStore.config(),
```

- [ ] **Step 4: Run the validator tests**

Run: `node --test test/preferences.test.ts`
Expected: PASS.

- [ ] **Step 5: Extend the proxy-dispatch test**

In `test/gateway.test.ts`, the helper that builds `GatewayDeps` must now supply `readPreferences`, `writePreferences`, `currentConfig`. Add them to that helper (record written patches into the same recorder object as `patches`, as a new `preferencePatches` array) and add:

```ts
test("updatePreferences dispatches through the proxy and writes only validated fields", async () => {
	const { service, recorder } = mountGateway();
	await service.updatePreferences?.({ panel: { sections: { telegram: false } }, home: "/nope" });
	assert.deepEqual(recorder.preferencePatches, [
		{ panel: { sections: { soul: true, agents: true, model: true, telegram: false } } },
	]);
});
```

Use the file's existing names for the mount helper and recorder (`mountGateway`/`recorder` above stand for whatever the file already calls them — read the top 60 lines first and match them exactly). `currentConfig` returns `FALLBACK_CONFIG` in the helper.

In `test/mount.test.ts`, the real-cordis mount already publishes `buddyStore` from the real store row, so the new endpoints are reachable; add:

```ts
test("preferences are served through the proxy with the conversation cwd", async () => {
	const mounted = await mount();
	const view = (await dispatch(persona(mounted), "preferences", [])) as { conversationCwd: string; panel: unknown };
	assert.ok(view.conversationCwd.endsWith("buddy-workspace"));
	assert.deepEqual(view.panel, { sections: { soul: true, agents: true, model: true, telegram: true } });
});
```

matching that file's existing mount/dispatch helpers (see the `updatePersona` case at line ~397 for the exact call shape, and reuse it). Because `preferences()` creates `~/buddy-workspace`, set `HOME` for this case to a `mkdtemp` directory before mounting and restore it after, the same way the file isolates the buddy home.

- [ ] **Step 6: Run the gate**

Run: `npm run check`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/persona test/preferences.test.ts test/gateway.test.ts test/mount.test.ts
git commit -m "feat: persona gateway serves buddy preferences"
```

---

### Task 3: Import the dsh-telegram host source verbatim

This task changes no behaviour. It exists so the later diffs against the imported code are reviewable.

**Files:**
- Create: `src/telegram/**` (copied), `test/telegram/**` (copied)
- Modify: `package.json`, `build.mjs`, `tsconfig.json`

**Interfaces:**
- Produces: `lib/telegram.js` built from `src/telegram/index.ts`; exports subpath `./telegram`. The row is **not** in `cordis.patch.yml` yet.

- [ ] **Step 1: Copy source and tests**

```bash
T=~/repo/dsh-plugins/dsh-telegram
mkdir -p src/telegram test/telegram
cp "$T"/src/*.ts src/telegram/
cp -r "$T"/src/telegram src/telegram/telegram
cp "$T"/test/*.test.ts test/telegram/
rm test/telegram/client.test.ts
sed -i 's#"\.\./src/#"../../src/telegram/#g' test/telegram/*.test.ts
git -C "$T" rev-parse HEAD
```

Record the printed dsh-telegram commit hash in the commit message of Step 6.

Then check for any test that resolves files relative to its own location:

```bash
grep -n "import.meta.url\|__dirname\|new URL(" test/telegram/*.test.ts
```

For every hit that points at `../src/...` or `../lib/...`, change it to `../../src/telegram/...`; a hit pointing at `../lib/client.js` belongs to the dropped client test and must not exist (if one does, delete that single test case — the browser half is rebuilt in Tasks 10–13).

- [ ] **Step 2: Add the runtime dependencies**

In `package.json`:

- `devDependencies` add: `"@deepseek-ai/dsh-agent": "^0.1.5-rc.1"`, `"@deepseek-ai/dsh-brand": "^0.1.5-rc.1"`, `"@deepseek-ai/dsh-credentials": "^0.1.5-rc.1"`, `"@deepseek-ai/dsh-llm": "^0.1.5-rc.1"`, `"@deepseek-ai/dsh-session": "^0.1.5-rc.1"`.
- `peerDependencies` add the same five names with `">=0.1.0-rc.8 <0.2.0"`.
- `exports` add `"./telegram": { "default": "./lib/telegram.js" }` after `./persona`.
- `scripts.test`: `"node --test test/*.test.ts test/telegram/*.test.ts"`.

Run: `npm install`
Expected: completes; `git diff package-lock.json` shows the five packages added.

- [ ] **Step 3: Build entry and tsconfig**

In `build.mjs`, append to `hostEntries`:

```js
	["src/telegram/index.ts", "lib/telegram.js"],
```

In `tsconfig.json`, set `"target": "ES2023"` and `"lib": ["ES2023", "DOM"]` (dsh-telegram was written against ES2023; the esbuild targets `node22` / `es2022` are unchanged).

- [ ] **Step 4: Verify externals**

Run: `npm run build && grep -oE 'from "[^".][^"]*"' lib/telegram.js | sort -u`
Expected: only `@deepseek-ai/*`, `zod`, and `node:*` specifiers. Any other bare specifier means a dependency is being bundled — add it to `peerDependencies`.

- [ ] **Step 5: Run the gate**

Run: `npm run check`
Expected: typecheck clean; test count = previous count + the dsh-telegram suite; all PASS. A typecheck error that exists only because of buddy's stricter/looser tsconfig must be fixed in `tsconfig.json`, not by editing the imported source.

- [ ] **Step 6: Commit**

```bash
git add src/telegram test/telegram package.json package-lock.json build.mjs tsconfig.json
git commit -m "chore: import dsh-telegram host source verbatim (dsh-telegram@<hash>)"
```

---

### Task 4: Give the Telegram row Buddy's identity and mount it

**Files:**
- Modify: `src/telegram/index.ts`, `src/telegram/config.ts`, `src/telegram/store.ts`, `src/telegram/gateway.ts`
- Modify: `cordis.patch.yml`
- Test: `test/patch.test.ts`, `test/telegram/plugin.test.ts`, `test/telegram/mount.test.ts`, `test/telegram/gateway.test.ts`, `test/telegram/config.test.ts`

**Interfaces:**
- Produces: `name = "dsh-buddy-telegram"`, `inject = ["typert", "storageDomain", "buddyStore"]`, `SETTINGS_NAMESPACE = "buddy-telegram"`, `TELEGRAM_DOMAIN_NAME = "buddy_telegram"`, `TELEGRAM_SERVICE = "buddyTelegram"`, gateway typert package `dsh-buddy-telegram`, `DEFAULT_CWD = BUDDY_WORKSPACE_DEFAULT`.

- [ ] **Step 1: Update the patch test first**

In `test/patch.test.ts` add:

```ts
test("the patch mounts the telegram row under the buddy package", () => {
	assert.ok(rowNames().includes("dsh-buddy/telegram"), `rows: ${rowNames().join(", ")}`);
});
```

Update the identity assertions in the imported tests:

- `test/telegram/plugin.test.ts`: `name` → `"dsh-buddy-telegram"`; installed sections → `["buddy-telegram"]`; invocation namespace → `"buddyTelegram"`; every `provided.get("telegram")` → `provided.get("buddyTelegram")`; the stub domain `name: "telegram"` → `"buddy_telegram"`; add `"buddyStore"` wherever the test asserts the `inject` array.
- `test/telegram/mount.test.ts`: `root.get("telegram")` → `root.get("buddyTelegram")`; sections → `["buddy-telegram"]`; patch `ns: "telegram"` → `ns: "buddy-telegram"`; stub domain name → `"buddy_telegram"`. In the function that mounts sibling service plugins (the one that provides `storageDomain`), provide `buddyStore` the same way with the value `{ paths: { home: "/tmp/buddy" }, config: () => FALLBACK_CONFIG }` (import `FALLBACK_CONFIG` from `../../src/config.ts`) — the row now waits on it.
- `test/telegram/gateway.test.ts`: `ctx.extend().get("telegram")` → `get("buddyTelegram")`; the doc comment's `telegram/status` → `buddyTelegram/status`.
- `test/telegram/config.test.ts`: `DEFAULT_CWD` → `"~/buddy-workspace"`; the two `endsWith("dsh-telegram")` → `endsWith("buddy-workspace")`. Keep the `expandHome("~/dsh-telegram", …)` case (it tests `~` expansion, not the default).

- [ ] **Step 2: Run to verify they fail**

Run: `npm run build && node --test test/patch.test.ts test/telegram/plugin.test.ts test/telegram/mount.test.ts test/telegram/gateway.test.ts test/telegram/config.test.ts`
Expected: FAIL on every changed assertion.

- [ ] **Step 3: Change the identity**

- `src/telegram/index.ts`: `export const name = "dsh-buddy-telegram";`, `export const inject = ["typert", "storageDomain", "buddyStore"];`; the log prefix `dsh-telegram: ` → `dsh-buddy-telegram: `; the effect label `"dsh-telegram: runtime"` → `"dsh-buddy-telegram: runtime"`; `FALLBACK.defaultCwd` → `BUDDY_WORKSPACE_DEFAULT` (import from `../index.ts`); rewrite the module doc comment's first paragraph to say this row is Buddy's Telegram bridge absorbed from dsh-telegram, configured from the Buddy main panel, and add `buddyStore` to the hard-dependency sentence ("the buddy home and the `buddy` preset must exist before any session is created").
- `src/telegram/config.ts`: `SETTINGS_NAMESPACE = "buddy-telegram"`; `DEFAULT_CWD = BUDDY_WORKSPACE_DEFAULT` (import from `../index.ts`).
- `src/telegram/store.ts`: `TELEGRAM_DOMAIN_NAME = "buddy_telegram"`; the `facility === undefined` message prefix `telegram:` → `dsh-buddy-telegram:`.
- `src/telegram/gateway.ts`: `TELEGRAM_SERVICE = "buddyTelegram"`; `TYPERT_PACKAGE = "dsh-buddy-telegram"`; error prefix `telegram:` → `dsh-buddy-telegram:`; module doc comment: "backing the Telegram module of the Buddy main panel".

`cordis.patch.yml`, append under `insert:` after `buddy-client`:

```yaml
    - id: buddy-telegram
      name: 'dsh-buddy/telegram'
      config: {}
```

and add one line to the header comment: "`buddy-telegram` is the Telegram bridge; it idles until enabled from the Buddy main panel and refuses to poll while dsh-telegram still holds the bot."

- [ ] **Step 4: Run the gate**

Run: `npm run check`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/telegram cordis.patch.yml test/patch.test.ts test/telegram
git commit -m "feat: mount the telegram row under buddy's identity"
```

---

### Task 5: Fixed `buddy` preset, fail-closed, model precedence, session origins

**Files:**
- Modify: `src/telegram/session.ts`, `src/telegram/store.ts`, `src/telegram/index.ts`
- Test: `test/telegram/session-manager.test.ts`, `test/telegram/integration.test.ts`

**Interfaces:**
- Consumes: `BUDDY_PRESET_ID`, `selectionFromDefault`, `resolveModelSelection`, `ctx.buddyStore.config()`.
- Produces:
  - `SessionDeps.presetId: string`, `SessionDeps.buddyModel: () => ModelSelection | undefined`.
  - `TelegramStore.origins: KvTable<string, OriginRecord>`; `OriginRecord = { chatId: string; createdAt: string }` keyed by session id.
  - Error message prefix `Buddy preset unavailable: `.

- [ ] **Step 1: Rewrite the preset tests (failing)**

In `test/telegram/session-manager.test.ts`:

Extend `storeStub` so the returned store also has

```ts
		origins: {
			get: (key: string) => origins.get(key),
			put: async (key: string, value: { chatId: string; createdAt: string }) => {
				origins.set(key, value);
			},
			entries: () => origins.entries(),
		},
```

with `const origins = new Map<string, { chatId: string; createdAt: string }>();` and return `{ store, records, origins }`. Make the same `origins` addition to the store stub in `test/telegram/integration.test.ts` (line ~234).

Extend `deps(...)`: add options `presetId?: string` and `buddyModel?: { provider: string; model: string } | undefined`, and return `presetId: options.presetId ?? "buddy"`, `buddyModel: () => options.buddyModel`.

Replace the six `(R32)` tests with:

```ts
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
```

Add model-precedence tests:

```ts
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
```

Every other pre-existing test in this file that constructs a manager through `deps(...)` and reaches `#create` must now pass `presets: presetStub().service` (otherwise it correctly fails closed). Update the first test ("a first contact creates…") to pass presets and to expect `meta` `{ cwd: "/tmp/telegram-work", agentPreset: "buddy" }`.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/telegram/session-manager.test.ts`
Expected: FAIL — presets resolved with `undefined`, sessions created without a preset, `origins` never written.

- [ ] **Step 3: Implement**

`src/telegram/store.ts`: add

```ts
/** Where a session came from: the chat that created it. Never deleted by `/new`. */
export const originRecordSchema = z.object({
	chatId: z.string(),
	/** ISO-8601. */
	createdAt: z.string(),
});

/** Stored shape of one session origin. */
export type OriginRecord = z.infer<typeof originRecordSchema>;
```

add `origins: domainTable(originRecordSchema)` to `tables` in `telegramDomainSpec`, `readonly origins: KvTable<string, OriginRecord>;` (doc: "session id → the chat that created it") to `TelegramStore`, and `origins: domain.table("origins"),` in `openStore`'s returned object.

`src/telegram/session.ts`:

- Import `import { resolveModelSelection, type ModelSelection as BuddyModelSelection } from "../model-selection.ts";`.
- `SessionDeps` add:

```ts
	/** The only preset this manager composes sessions from. */
	readonly presetId: string;
	/** Buddy's default model, read at creation time. */
	readonly buddyModel: () => BuddyModelSelection | undefined;
```

- Rename the old `#defaultSelection()` to `#globalSelection()` (body unchanged) and add:

```ts
	/**
	 * The model a session starts on when its chat has not chosen one: Buddy's
	 * default, then the deployment's global default.
	 * @returns the selection, when any is configured.
	 */
	#defaultSelection(): ModelSelection | undefined {
		return resolveModelSelection(undefined, this.#deps.buddyModel(), this.#globalSelection());
	}
```

- Replace `#defaultPresetId()` with:

```ts
	/**
	 * Resolve Buddy's preset, or refuse.
	 *
	 * Never falls back: a Telegram chat with Buddy that silently ran on the
	 * deployment's default preset would be an agent without Buddy's voice
	 * answering under Buddy's name.
	 * @returns the resolved preset id.
	 * @throws `Buddy preset unavailable: …` when there is no roster or the id does not resolve.
	 */
	async #presetId(): Promise<string> {
		const presets = this.#presets();
		if (presets === undefined) throw new Error("Buddy preset unavailable: this profile mounts no agent preset roster");
		try {
			return (await presets.resolve(this.#deps.presetId)).id;
		} catch (error) {
			throw new Error(`Buddy preset unavailable: ${(error as Error).message}`);
		}
	}
```

- In `#create`, move preset resolution to the very top of the method body (before `const agents = this.#agents();` and before `mkdir`), as `const presetId = await this.#presetId();`, delete the later `const presetId = await this.#defaultPresetId();`, and change `meta` to `{ cwd: defaultCwd, agentPreset: presetId }`. After the `chats.put(...)` call add:

```ts
		await this.#deps.store.origins.put(String(sessionId), { chatId, createdAt: new Date().toISOString() });
```

- In `#setupFor`: replace the `presets === undefined` branch body (log + return) with `throw new Error("Buddy preset unavailable: this profile mounts no agent preset roster");`, and change the id line to `const id = storedPreset(agent) ?? fallbackPresetId ?? (await this.#presetId());` followed directly by `await presets.mount(agentCtx, id);` (remove the `if (id === undefined) return;` line). Update the two doc comments to say the preset is Buddy's, fixed.
- Update the `AgentPresetsLike` doc comment that mentions "the configured default when omitted" to note this manager always passes an id.

`src/telegram/index.ts`: import `BUDDY_PRESET_ID` from `../index.ts` and `selectionFromDefault` from `../model-selection.ts`; add to `PluginContext`:

```ts
	buddyStore: { config(): import("../config.ts").BuddyConfig };
```

and construct the manager as:

```ts
		manager = new SessionManager({
			get: (service) => ctx.get(service),
			store,
			log,
			presetId: BUDDY_PRESET_ID,
			// `buddyStore` is a declared hard dependency, so the property read is safe.
			buddyModel: () => selectionFromDefault(ctx.buddyStore.config().model),
		});
```

Add the same two fields to the `SessionManager` construction in `test/telegram/integration.test.ts` and in any other test that builds `SessionManager` directly (`grep -n "new SessionManager" test/telegram/*.ts`): `presetId: "buddy", buddyModel: () => undefined`, and give their preset stubs a `resolve` that answers `{ id }`.

- [ ] **Step 4: Run the gate**

Run: `npm run check`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/telegram test/telegram
git commit -m "feat: telegram sessions always use the buddy preset and buddy's default model"
```

---

### Task 6: Every bot-facing string is English

**Files:**
- Modify: `src/telegram/runtime.ts`, `src/telegram/approvals.ts`, `src/telegram/files.ts`, `src/telegram/model.ts`, `src/telegram/telegram/deliver.ts`
- Create: `test/telegram/english-copy.test.ts`
- Modify: tests asserting the old strings — `test/telegram/{approvals,api,deliver,session,render,integration,runtime-shell}.test.ts`

**Interfaces:**
- Produces: `helpText(config, state, model)` output exactly as in Step 3.

- [ ] **Step 1: Write the failing scan**

Create `test/telegram/english-copy.test.ts`:

```ts
/**
 * The bot speaks English. Comments may be in any language; code may not carry a
 * CJK character, because every string literal in `src/telegram` can reach a chat.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../src/telegram", import.meta.url));
const CJK = /[　-鿿＀-￯]/;

function sources(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) return sources(path);
		return path.endsWith(".ts") ? [path] : [];
	});
}

test("no CJK character survives outside comments in the telegram row", () => {
	const offenders: string[] = [];
	for (const file of sources(ROOT)) {
		const code = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
		code.split("\n").forEach((line, index) => {
			if (CJK.test(line)) offenders.push(`${file}:${String(index + 1)}: ${line.trim()}`);
		});
	}
	assert.deepEqual(offenders, []);
});
```

(Line numbers reported are post-comment-stripping and only indicative; the line text identifies the string.)

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/telegram/english-copy.test.ts`
Expected: FAIL listing the strings in the table below.

- [ ] **Step 3: Translate**

Replace each literal exactly (interpolations kept as-is):

| File | Old | New |
|---|---|---|
| approvals.ts | `<b>需要你的许可</b>` | `<b>Approval needed</b>` |
| approvals.ts | `工具：<code>${…}</code>` | `Tool: <code>${…}</code>` |
| approvals.ts | `原因：${…}` | `Reason: ${…}` |
| approvals.ts | `${…} 秒内不点按视为拒绝。` | `No answer within ${…} seconds counts as a denial.` |
| approvals.ts | `"允许一次"` | `"Allow once"` |
| approvals.ts | `"拒绝"` | `"Deny"` |
| approvals.ts | `"✅ 已允许（仅这一次）"` | `"✅ Allowed (this once)"` |
| approvals.ts | `"⌛ 已过期，按拒绝处理"` | `"⌛ Expired, treated as denied"` |
| approvals.ts | `"❌ 已拒绝"` | `"❌ Denied"` |
| files.ts | `这个文件超过 ${…}MB，Telegram 不允许 bot 下载。` | `This file is over ${…} MB; Telegram does not let bots download it.` |
| files.ts | `"Telegram 没有给出文件路径，无法下载。"` | `"Telegram returned no file path, so the file cannot be downloaded."` |
| files.ts | `"文件下载失败，请再发一次。"` | `"The file download failed. Please send it again."` |
| telegram/deliver.ts | `"不在工作目录内"` | `"outside the working directory"` |
| telegram/deliver.ts | `"文件不存在"` | `"file not found"` |
| telegram/deliver.ts | `"不是普通文件"` | `"not a regular file"` |
| telegram/deliver.ts | `"超过 Telegram 的上限"` | `"over Telegram's size limit"` |
| telegram/deliver.ts | `"读不出来"` | `"unreadable"` |
| telegram/deliver.ts | `"不是可发送的媒体"` | `"not sendable media"` |
| telegram/deliver.ts | `` `[未发送：${A}（${B}${C === "" ? "" : `：${C}`}）]` `` | `` `[Not sent: ${A} (${B}${C === "" ? "" : `: ${C}`})]` `` |
| telegram/deliver.ts | `` `（还有 ${…} 个媒体未发送）` `` | `` `(${…} more media item(s) not sent)` `` |
| telegram/deliver.ts | `"附件"` | `"attachment"` |
| model.ts | `"← 换 provider"` | `"← Change provider"` |
| runtime.ts | `"怎么用这个 bot"` | `"How to use this bot"` |
| runtime.ts | `"开一条新会话（当前目录）"` | `"Start a new conversation (same directory)"` |
| runtime.ts | `"换这个 chat 用的模型"` | `"Change the model for this chat"` |
| runtime.ts | `"停掉正在跑的这一轮"` | `"Stop the current turn"` |
| runtime.ts (×2) | `"token 无效或已被吊销"` | `"The token is invalid or has been revoked"` |
| runtime.ts | `` `[用户发来一个文件，已保存到 ${…}]` `` | `` `[The user sent a file, saved to ${…}]` `` |
| runtime.ts | `` `这一轮没起来：${detail}` `` | `` `This turn never started: ${detail}` `` |
| runtime.ts | `"（这一轮没有产生文本输出）"` | `"(This turn produced no text output)"` |
| runtime.ts | `` `这一轮出错了：${…}` `` | `` `This turn failed: ${…}` `` |
| runtime.ts | `` `[未发送：${…}（${failure}）]` `` | `` `[Not sent: ${…} (${failure})]` `` |
| runtime.ts | `"好，下一条消息会开一条新会话（目录不变）。"` | `"OK. Your next message starts a new conversation (same directory)."` |
| runtime.ts | `"现在没有在跑的回合。"` | `"Nothing is running right now."` |
| runtime.ts | `"已请求停止。"` | `"Stop requested."` |
| runtime.ts | `` `不认识的命令：/${name}。发 /help 看用法。` `` | `` `Unknown command: /${name}. Send /help for usage.` `` |
| runtime.ts | `"这个 profile 没有挂载模型目录服务，换不了模型。"` | `"This profile has no model catalog service, so the model cannot be changed."` |
| runtime.ts | `"这个版本还不支持 /model <名字>，请用按钮选。"` | `"/model <name> is not supported yet. Pick with the buttons."` |
| runtime.ts | `"没有可用的模型。"` | `"No models are available."` |
| runtime.ts | `` `当前模型：${current}\n选一个 provider：` `` | `` `Current model: ${current}\nPick a provider:` `` |
| runtime.ts (×2) | `"选一个 provider："` | `"Pick a provider:"` |
| runtime.ts | `"选一个模型："` | `"Pick a model:"` |
| runtime.ts | `` `这个模型用不了：${…}` `` | `` `This model cannot be used: ${…}` `` |
| runtime.ts | `"这个 chat 还没有会话，先发一条消息，再选模型。"` | `"This chat has no conversation yet. Send a message first, then pick a model."` |
| runtime.ts | `` `已切到 ${p} / ${m}（只影响这个 chat）` `` | `` `Switched to ${p} / ${m} (this chat only)` `` |
| runtime.ts | `` `${…} 张图片` `` | `` `${…} image(s)` `` |
| runtime.ts | `"文本"` | `"text"` |

Replace the body of `helpText` in `runtime.ts` from `const stateLabel` through the returned `join` with:

```ts
	const stateLabel = { off: "off", starting: "starting…", running: "running", error: "error" }[state];
	return [
		"I'm Buddy, running inside DeepSeek Harness on this machine. Message me and I'll work here.",
		"",
		"Commands:",
		"/new — start a new conversation (same working directory)",
		"/model — change the model for this chat (desktop default unaffected)",
		"/stop — stop the current turn",
		"/help — this message",
		"",
		`Working directory: ${config.defaultCwd}`,
		`Model: ${model ?? "(follows default)"}`,
		`Status: ${stateLabel}`,
		`Permission level: ${config.permissionPreset}`,
		"",
		"Files you send me are saved under downloads/ in the working directory.",
	].join("\n");
```

- [ ] **Step 4: Update the tests that asserted the old strings**

Run: `grep -n '[一-鿿]' test/telegram/*.test.ts`
For each hit that is an expected value, replace it with the new English literal from the table (or from `helpText` above). A hit that is *input* — e.g. a Chinese user message fed to the bot, or Markdown under test in `render.test.ts` / `api.test.ts` — stays as it is: the rule is about what the bot sends, and those tests prove non-ASCII input round-trips.

- [ ] **Step 5: Run the gate**

Run: `npm run check`
Expected: all PASS, including `english-copy.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/telegram test/telegram
git commit -m "feat: the telegram bot speaks English"
```

---

### Task 7: One-shot migration of the legacy `telegram` settings

**Files:**
- Create: `src/telegram/migrate.ts`
- Modify: `src/telegram/index.ts`
- Test: `test/telegram/migrate.test.ts`, `test/telegram/plugin.test.ts`

**Interfaces:**
- Produces:
  - `LEGACY_NAMESPACE = "telegram"`, `MIGRATED_FIELDS`, `type MigrationResult = "migrated" | "present" | "no-legacy"`.
  - `interface MigrationSettings { describe(): readonly { ns: string; user?: unknown }[]; update(ns: string, patch: Record<string, unknown>): Promise<void> }`.
  - `migrateLegacySettings(settings: MigrationSettings, targetNs: string): Promise<MigrationResult>`.

- [ ] **Step 1: Write the failing tests**

Create `test/telegram/migrate.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { migrateLegacySettings, type MigrationSettings } from "../../src/telegram/migrate.ts";

function settings(descriptors: { ns: string; user?: unknown }[]): MigrationSettings & { writes: { ns: string; patch: unknown }[] } {
	const writes: { ns: string; patch: unknown }[] = [];
	return {
		writes,
		describe: () => descriptors,
		update: async (ns, patch) => {
			writes.push({ ns, patch });
		},
	};
}

test("user-set legacy fields are copied and the switch is written off", async () => {
	const plane = settings([
		{ ns: "telegram", user: { enabled: true, ownerUserId: "1000000000", defaultCwd: "~/dsh-telegram", junk: 1 } },
		{ ns: "buddy-telegram" },
	]);
	assert.equal(await migrateLegacySettings(plane, "buddy-telegram"), "migrated");
	assert.deepEqual(plane.writes, [
		{ ns: "buddy-telegram", patch: { enabled: false, ownerUserId: "1000000000", defaultCwd: "~/dsh-telegram" } },
	]);
});

test("an existing buddy-telegram section is never overwritten", async () => {
	const plane = settings([
		{ ns: "telegram", user: { ownerUserId: "1" } },
		{ ns: "buddy-telegram", user: { ownerUserId: "2" } },
	]);
	assert.equal(await migrateLegacySettings(plane, "buddy-telegram"), "present");
	assert.deepEqual(plane.writes, []);
});

test("nothing is written when the legacy section is absent or only defaulted", async () => {
	for (const descriptors of [[{ ns: "buddy-telegram" }], [{ ns: "telegram" }, { ns: "buddy-telegram" }]]) {
		const plane = settings(descriptors);
		assert.equal(await migrateLegacySettings(plane, "buddy-telegram"), "no-legacy");
		assert.deepEqual(plane.writes, []);
	}
});

test("the legacy section is only read", async () => {
	const legacy = { ownerUserId: "1", renderMarkdown: false, mediaDelivery: "presented", permissionPreset: "read-only" };
	const plane = settings([{ ns: "telegram", user: legacy }, { ns: "buddy-telegram" }]);
	await migrateLegacySettings(plane, "buddy-telegram");
	assert.ok(plane.writes.every((write) => write.ns !== "telegram"));
	assert.deepEqual(plane.writes[0]?.patch, { enabled: false, ...legacy });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/telegram/migrate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/telegram/migrate.ts`:

```ts
/**
 * One-shot migration from dsh-telegram's `telegram` settings section.
 *
 * Only what the user actually wrote is copied (the raw `user` section, not the
 * resolved value), `enabled` is never copied and always written `false` — two
 * polling rows must not come up together because a migration ran — and the
 * legacy section is only ever read, so re-installing dsh-telegram is a lossless
 * rollback.
 *
 * The settings plane can only describe *registered* namespaces, so this finds a
 * legacy section only while dsh-telegram is still mounted. The cutover order in
 * the plan relies on that: install Buddy first, migrate, then remove dsh-telegram.
 * @module dsh-buddy/telegram/migrate
 */

/** dsh-telegram's settings namespace. */
export const LEGACY_NAMESPACE = "telegram";

/** Fields carried over. `enabled` is deliberately absent. */
export const MIGRATED_FIELDS = ["ownerUserId", "defaultCwd", "permissionPreset", "renderMarkdown", "mediaDelivery"] as const;

/** What a migration attempt concluded. */
export type MigrationResult = "migrated" | "present" | "no-legacy";

/** The settings-plane slice this needs. */
export interface MigrationSettings {
	describe(): readonly { ns: string; user?: unknown }[];
	update(ns: string, patch: Record<string, unknown>): Promise<void>;
}

/**
 * Copy the legacy section into `targetNs` once.
 * @param settings - the settings plane.
 * @param targetNs - the namespace to migrate into; must already be registered.
 * @returns what happened.
 */
export async function migrateLegacySettings(settings: MigrationSettings, targetNs: string): Promise<MigrationResult> {
	const descriptors = settings.describe();
	if (descriptors.find((descriptor) => descriptor.ns === targetNs)?.user !== undefined) return "present";
	const legacy = descriptors.find((descriptor) => descriptor.ns === LEGACY_NAMESPACE)?.user;
	if (typeof legacy !== "object" || legacy === null || Array.isArray(legacy)) return "no-legacy";
	const patch: Record<string, unknown> = { enabled: false };
	for (const field of MIGRATED_FIELDS) {
		const value = (legacy as Record<string, unknown>)[field];
		if (value !== undefined) patch[field] = value;
	}
	await settings.update(targetNs, patch);
	return "migrated";
}
```

In `src/telegram/index.ts`: import `migrateLegacySettings, type MigrationSettings` from `./migrate.ts`; extend the `settings?` type in `PluginContext` with `describe(): readonly { ns: string; user?: unknown }[];`; and in the `ctx.inject(["settings"], (scoped) => { … })` callback, after `installSection(...)`, add:

```ts
		const settings = scoped.settings;
		if (settings !== undefined) {
			// After installSection: `update` rejects an unregistered namespace.
			void migrateLegacySettings(settings as MigrationSettings, SETTINGS_NAMESPACE)
				.then((result) => {
					log(`legacy telegram settings: ${result}`);
				})
				.catch((error: unknown) => {
					log(`legacy telegram settings migration failed: ${(error as Error).message}`);
				});
		}
```

In `test/telegram/plugin.test.ts`, the settings stub must now provide `describe: () => []` (add it next to its `installSection`/`update`), and add one case named `"mounting beside a user-set legacy section migrates it into buddy-telegram, switched off"`. Build it with the file's own stub-builder (read its first 100 lines; the settings stub is the object whose `installSection` pushes into `sections` and whose `update` records patches). Inputs: the settings stub's `describe` returns `[{ ns: "telegram", user: { ownerUserId: "42", enabled: true } }, { ns: "buddy-telegram" }]`. Action: `apply(ctx)`, then `await settle()` (the file's helper). Assertion: the recorded updates deep-equal `[{ ns: "buddy-telegram", patch: { enabled: false, ownerUserId: "42" } }]`.

- [ ] **Step 4: Run the gate**

Run: `npm run check`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/telegram test/telegram
git commit -m "feat: migrate dsh-telegram settings into buddy-telegram once, switched off"
```

---

### Task 8: Refuse to poll while dsh-telegram still holds the bot

**Files:**
- Create: `src/telegram/occupancy.ts`
- Modify: `src/telegram/index.ts`
- Test: `test/telegram/occupancy.test.ts`, `test/telegram/plugin.test.ts`

**Interfaces:**
- Produces: `LEGACY_PLUGIN = "dsh-telegram"`, `OCCUPIED_DETAIL`, `legacyBotActive(get: (name: string) => unknown): boolean`.

- [ ] **Step 1: Write the failing tests**

Create `test/telegram/occupancy.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { legacyBotActive } from "../../src/telegram/occupancy.ts";

function world(options: { rows: { name: string; disabled: boolean }[] | undefined; legacyEnabled: unknown }): (name: string) => unknown {
	return (name) => {
		if (name === "loader") {
			return options.rows === undefined
				? undefined
				: { entries: () => options.rows!.map((row) => ({ options: { name: row.name }, disabled: row.disabled })) };
		}
		if (name === "settings") return { get: (ns: string) => (ns === "telegram" ? { enabled: options.legacyEnabled } : undefined) };
		return undefined;
	};
}

test("a mounted, enabled dsh-telegram occupies the bot", () => {
	assert.equal(legacyBotActive(world({ rows: [{ name: "dsh-telegram", disabled: false }], legacyEnabled: true })), true);
});

test("a disabled row, a switched-off legacy bot, or no row at all does not", () => {
	assert.equal(legacyBotActive(world({ rows: [{ name: "dsh-telegram", disabled: true }], legacyEnabled: true })), false);
	assert.equal(legacyBotActive(world({ rows: [{ name: "dsh-telegram", disabled: false }], legacyEnabled: false })), false);
	assert.equal(legacyBotActive(world({ rows: [{ name: "dsh-buddy/telegram", disabled: false }], legacyEnabled: true })), false);
});

test("without a loader service nothing is assumed to occupy the bot", () => {
	assert.equal(legacyBotActive(world({ rows: undefined, legacyEnabled: true })), false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/telegram/occupancy.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/telegram/occupancy.ts`:

```ts
/**
 * Whether the standalone dsh-telegram plugin is still polling the bot.
 *
 * One token admits one long-poller; a second gets 409 Conflict and both look
 * broken with nothing on screen to say why. While dsh-telegram is mounted and
 * switched on, this row stays down and says so in its status instead.
 * @module dsh-buddy/telegram/occupancy
 */

/** The legacy plugin's row name (its package name). */
export const LEGACY_PLUGIN = "dsh-telegram";

/** Status detail shown in the Telegram module while occupied. */
export const OCCUPIED_DETAIL = "dsh-telegram is still polling this bot; remove it from the profile first";

/** The loader slice read here (`cordis-plugin-loader` `Entry`). */
interface LoaderLike {
	entries(): Iterable<{ readonly options: { readonly name: string }; readonly disabled: boolean }>;
}

/**
 * @param get - `ctx.get`.
 * @returns `true` when a non-disabled `dsh-telegram` row exists and `telegram.enabled` is `true`.
 */
export function legacyBotActive(get: (name: string) => unknown): boolean {
	const loader = get("loader") as LoaderLike | undefined;
	if (loader === undefined) return false;
	let mounted = false;
	for (const entry of loader.entries()) {
		if (entry.options.name === LEGACY_PLUGIN && !entry.disabled) mounted = true;
	}
	if (!mounted) return false;
	const settings = get("settings") as { get(ns: string): unknown } | undefined;
	const legacy = settings?.get("telegram") as { enabled?: unknown } | undefined;
	return legacy?.enabled === true;
}
```

In `src/telegram/index.ts`:

- import `legacyBotActive, OCCUPIED_DETAIL` from `./occupancy.ts`;
- add `let occupied = false;` next to `let stopped = false;`;
- in `sync`, right after `const config = readConfig();`:

```ts
		// Before the enable check on purpose: the Telegram module must explain an
		// occupied bot even while Buddy's own switch is still off.
		occupied = legacyBotActive((service) => ctx.get(service));
		if (occupied) {
			await runtime.stop();
			log("dsh-telegram still holds the bot; not polling");
			return;
		}
```

- re-judge when the legacy switch moves — add after the `credentials/reference-updated` listener:

```ts
	// The legacy plugin's own switch decides whether this row may poll.
	ctx.on("settings/updated", ((ns: unknown) => {
		if (ns === "telegram") resync();
	}) as never);
```

- in the gateway `status` dep, replace the spread line with:

```ts
			...(occupied
				? { ...(runtime?.status() ?? { sessions: 0 }), state: "error" as const, detail: OCCUPIED_DETAIL }
				: (runtime?.status() ?? { state: "off" as const, sessions: 0 })),
```

In `test/telegram/plugin.test.ts` add a case using the file's harness: give `get("loader")` → `{ entries: () => [{ options: { name: "dsh-telegram" }, disabled: false }] }`, the settings stub `get("telegram")` → `{ enabled: true }`, this row's config `enabled: true` with a token; after settling, `gateway.status()` must resolve with `state: "error"` and `detail` equal to `OCCUPIED_DETAIL`, and the runtime's `start` must not have been called (assert on whatever the harness records for starts — the existing "starts when enabled with a token" case shows how).

- [ ] **Step 4: Run the gate**

Run: `npm run check`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/telegram test/telegram
git commit -m "feat: stay down while dsh-telegram still polls the bot"
```

---

### Task 9: Sessions know whether they came from Telegram

**Files:**
- Modify: `src/telegram/gateway.ts`, `src/telegram/index.ts`
- Modify: `src/persona/gateway.ts`, `src/persona/index.ts`
- Test: `test/telegram/gateway.test.ts`, `test/mount.test.ts`

**Interfaces:**
- Consumes: `TelegramStore.origins` (Task 5).
- Produces:
  - `TelegramGateway.telegramSessionIds(): Promise<string[]>` (cordis service method; not on the wire).
  - `BuddySessionSummary.source: "telegram" | "web"`.

- [ ] **Step 1: Write the failing tests**

In `test/telegram/gateway.test.ts` (using its proxy mount helper, with `GatewayDeps` extended by `telegramSessionIds: async () => ["s-tg"]`):

```ts
test("telegram session ids are reachable through the service proxy", async () => {
	const { service } = mountGateway();
	assert.deepEqual(await service.telegramSessionIds?.(), ["s-tg"]);
});
```

In `test/mount.test.ts`, extend the existing sessions case (line ~422) or add one: mount with two buddy sessions `s-tg` and `s-web`, provide a sibling `buddyTelegram` service `{ telegramSessionIds: async () => ["s-tg"] }` the same way `sessionQuery` is given, and assert the `sessions` result maps `s-tg` → `source: "telegram"`, `s-web` → `source: "web"`. Add a second assertion without the `buddyTelegram` sibling: every summary has `source: "web"`.

- [ ] **Step 2: Run to verify they fail**

Run: `npm run build && node --test test/telegram/gateway.test.ts test/mount.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/telegram/gateway.ts`: add to `GatewayDeps`

```ts
	/** Ids of every session a Telegram chat created. */
	readonly telegramSessionIds: () => Promise<string[]>;
```

and to the class

```ts
	/**
	 * Ids of every session a Telegram chat created, including ones `/new` has
	 * since unbound. For the Buddy folder's source badge; not a wire endpoint.
	 * @returns session ids.
	 */
	async telegramSessionIds(): Promise<string[]> {
		return await this.deps.telegramSessionIds();
	}
```

`src/telegram/index.ts`, in the `new TelegramGateway(ctx, { … })` deps:

```ts
		telegramSessionIds: async () => (store === undefined ? [] : [...store.origins.keys()]),
```

`src/persona/gateway.ts`: add to `BuddySessionSummary`

```ts
	/** Whether a Telegram chat created this conversation. */
	readonly source: "telegram" | "web";
```

`src/persona/index.ts`, in `listSessions` before `Promise.all`:

```ts
		// Soft and per request: without the Telegram row every conversation is a web one.
		const telegram = ctx.get("buddyTelegram") as { telegramSessionIds(): Promise<string[]> } | undefined;
		const fromTelegram = new Set(await telegram?.telegramSessionIds().catch(() => []) ?? []);
```

and add `source: fromTelegram.has(record.header.id) ? "telegram" : "web",` to the built summary.

Update the existing expectations in `test/mount.test.ts` / `test/gateway.test.ts` that deep-equal session summaries to include `source: "web"`.

- [ ] **Step 4: Run the gate**

Run: `npm run check`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat: buddy conversations report whether telegram created them"
```

---

### Task 10: Extract the browser test harness

No behaviour change; it makes the three new client test files possible.

**Files:**
- Create: `test/support/client-harness.ts`
- Modify: `test/client-ui.test.ts`

**Interfaces:**
- Produces (all exported from `test/support/client-harness.ts`): `bundleText`, `clientSourceText`, `loadClient`, `contextStub`, `createRenderer`, `elements`, `settle`, and types `StubElement`, `Recorded`, `RpcStub`, `RecordedCall`, `ClientPlugin`, `Registration`.
- `contextStub` options gain `remote?: unknown` (exposed as `ctx.remote`) and `sessions?: Record<string, unknown>` (was `{ open }` only).

- [ ] **Step 1: Move the helpers**

Move, unchanged except for `export` and the two option widenings above, every helper and type from the top of `test/client-ui.test.ts` through `settle()` (lines ~1–345) into `test/support/client-harness.ts`. URLs built with `new URL("../lib/client.js", import.meta.url)` and `"../src/client/index.tsx"` become `"../../lib/client.js"` and `"../../src/client/index.tsx"`; `nodeRequire("../lib/client.js")` becomes `nodeRequire("../../lib/client.js")`. In `contextStub`, add `remote: options.remote,` to the `ctx` object.

At the top of `test/client-ui.test.ts`, import them from `./support/client-harness.ts`. The harness file has no `test(...)` calls, and the `test` script's glob does not reach `test/support/`, so it is never run as a suite.

- [ ] **Step 2: Run the gate**

Run: `npm run check`
Expected: identical test count to Task 9, all PASS.

- [ ] **Step 3: Commit**

```bash
git add test/support/client-harness.ts test/client-ui.test.ts
git commit -m "test: extract the browser half's test harness"
```

---

### Task 11: Main panel from a module table — Soul, Agents, New Buddy conversation; slim Settings

**Files:**
- Create: `src/client/modules.ts`, `src/client/document-module.tsx`
- Modify: `src/client/panel.tsx`, `src/client/settings.tsx`, `src/client/index.tsx`, `package.json` (`dsh.client.inject`)
- Test: `test/client-panel.test.ts`, `test/client-settings.test.ts`, `test/client-ui.test.ts`

**Interfaces:**
- Consumes: `buddyPersona/persona`, `buddyPersona/updatePersona`, `buddyPersona/preferences`, `buddyPersona/updatePreferences`, `PANEL_SECTION_IDS`, `selectionFromDefault`, `BUDDY_PRESET_ID`.
- Produces:
  - `src/client/modules.ts`: `interface PanelModule<C> { readonly id: PanelSectionId; readonly order: number; readonly titleKey: string; readonly Component: C }`, `visibleModules<C>(modules, sections?)`.
  - `createDocumentModule(deps: { call: Call; t(key: string): string }, field: "soul" | "agents"): () => unknown`.
  - `createBuddyPanel(deps: { call: Call; t(key: string): string; modules: readonly PanelModule<() => unknown>[]; newConversation(): Promise<void> }): () => unknown`.
  - `createBuddySettingsSection(deps: { call: Call; t(key: string): string }): () => unknown` (meta settings).
  - Client `inject`: `["slots", "locale", "connection", "layout", "sessions", "remote", "remote.session"]`.

- [ ] **Step 1: Look up the declaring packages for the new injects**

Run (the harness tree, a specific directory):

```bash
H=/home/panda-nuc/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai
grep -rlE "remote(\.session)?\s*:" --include='*.d.ts' "$H"/*/lib/types/client 2>/dev/null | head
grep -n '"dsh-api-remotes"\|dsh-api-remotes' ~/repo/dsh-plugins/dsh-telegram/package.json
```

Record which package augments `Context` with `remote` and which with `remote.session` (expected: `@deepseek-ai/dsh-api-remotes` for `remote`, `@deepseek-ai/dsh-api-session-controller` for `remote.session`). These two names go into `package.json` `dsh.client.inject` (add only the ones not already present) and into the provider map in Step 2.

- [ ] **Step 2: Write the failing registration and module tests**

In `test/client-ui.test.ts`:

- the inject assertion becomes `["slots", "locale", "connection", "layout", "sessions", "remote", "remote.session"]`;
- the provider map gains `remote` and `"remote.session"` with the packages from Step 1;
- delete the tests "the settings tab registers into settings.section … nothing else" count assertion's `sidebar.panellist` expectations **only in Task 13** — in this task keep the three registrations and keep every panellist/icon test unchanged;
- delete the tests that exercise the old settings tab and the old panel list (`a persona that failed to load…`, `a loaded persona saves…`, and the six `panel …`/`opening a conversation…`/`the refresh button…`/`empty cwd…`/`empty-state hint…`/`failed sessions load…` cases) — their behaviour moves to the new files below;
- the dictionary test's key list becomes `["nav", "panelTitle", "newConversation", "soulTitle", "soulHint", "agentsTitle", "agentsHint", "save", "homeLabel", "settingsHint", "sectionsTitle"]`.

Create `test/client-panel.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { visibleModules } from "../src/client/modules.ts";
import {
	contextStub,
	createRenderer,
	elements,
	loadClient,
	settle,
	type RecordedCall,
	type StubElement,
} from "./support/client-harness.ts";

const nodeRequire = createRequire(import.meta.url);
const PREFS = {
	model: { provider: "", model: "", reasoningEffort: "" },
	panel: { sections: { soul: true, agents: true, model: true, telegram: true } },
	conversationCwd: "/home/u/buddy-workspace",
};

test("visibleModules drops hidden modules and orders the rest", () => {
	const modules = [
		{ id: "telegram", order: 40, titleKey: "t", Component: 4 },
		{ id: "soul", order: 10, titleKey: "s", Component: 1 },
		{ id: "agents", order: 20, titleKey: "a", Component: 2 },
	] as const;
	assert.deepEqual(visibleModules(modules, { agents: false }).map((m) => m.Component), [1, 4]);
	assert.deepEqual(visibleModules(modules, undefined).map((m) => m.Component), [1, 2, 4]);
});

function mountPanel(answer: (endpoint: string, payload: unknown) => Promise<unknown>, remote?: unknown) {
	const renderer = createRenderer();
	const calls: RecordedCall[] = [];
	const actions: { service: string; arg: unknown }[] = [];
	const client = loadClient((name) => renderer.modules[name] ?? nodeRequire(name));
	const { ctx, registrations } = contextStub({
		rpc: {
			call: async (route, endpoint, payload) => {
				calls.push({ route, endpoint, payload });
				return await answer(endpoint, payload);
			},
		},
		remote,
		sessions: {
			open: (id: string) => actions.push({ service: "sessions.open", arg: id }),
			refresh: async () => {
				actions.push({ service: "sessions.refresh", arg: undefined });
			},
			list: { getSnapshot: () => ({ current: undefined }), subscribe: () => () => undefined },
		},
		layout: { selectPanel: (id: unknown) => actions.push({ service: "layout.selectPanel", arg: id }) },
	});
	client.apply(ctx);
	const main = registrations.find((r) => r.options.name === "main");
	assert.ok(main !== undefined);
	renderer.mount(main.component as () => unknown);
	return { calls, actions, tree: () => renderer.tree() };
}

function texts(tree: unknown): unknown[] {
	return elements(tree).map((element) => element.props["children"]);
}

function button(tree: unknown, label: string): StubElement {
	const found = elements(tree).find((e) => e.type === "button" && e.props["children"] === label);
	assert.ok(found !== undefined, `no button "${label}"`);
	return found;
}

test("the panel shows only the modules preferences leave visible", async () => {
	const panel = mountPanel(async (endpoint) =>
		endpoint === "buddyPersona/preferences"
			? { ok: true, value: { ...PREFS, panel: { sections: { ...PREFS.panel.sections, agents: false, model: false, telegram: false } } } }
			: { ok: true, value: { soul: "v", agents: "r", home: "/h" } },
	);
	await settle();
	const shown = texts(panel.tree());
	assert.ok(shown.includes("settings.buddy:soulTitle"));
	assert.ok(!shown.includes("settings.buddy:agentsTitle"), "a hidden module must not render");
});

test("a document module that failed to load cannot save over the file", async () => {
	const panel = mountPanel(async (endpoint) =>
		endpoint === "buddyPersona/preferences"
			? { ok: true, value: { ...PREFS, panel: { sections: { soul: true, agents: false, model: false, telegram: false } } } }
			: { ok: false, error: { code: "EIO", message: "host is down" } },
	);
	await settle();
	const save = button(panel.tree(), "settings.buddy:save");
	assert.equal(save.props["disabled"], true);
	(save.props["onClick"] as () => void)();
	await settle();
	assert.ok(!panel.calls.some((call) => call.endpoint === "buddyPersona/updatePersona"));
});

test("the soul module saves only its own field", async () => {
	const panel = mountPanel(async (endpoint) =>
		endpoint === "buddyPersona/preferences"
			? { ok: true, value: { ...PREFS, panel: { sections: { soul: true, agents: false, model: false, telegram: false } } } }
			: { ok: true, value: { soul: "a voice", agents: "rules", home: "/h" } },
	);
	await settle();
	(button(panel.tree(), "settings.buddy:save").props["onClick"] as () => void)();
	await settle();
	const write = panel.calls.find((call) => call.endpoint === "buddyPersona/updatePersona");
	assert.deepEqual(write?.payload, { args: { patch: { soul: "a voice" } } });
});

test("New Buddy conversation creates a buddy-preset session in the conversation cwd, applies the buddy model, and opens it", async () => {
	const remoteCalls: { method: string; arg: unknown }[] = [];
	const remote = {
		session: {
			create: async (arg: unknown) => {
				remoteCalls.push({ method: "create", arg });
				return { ok: true, value: { sessionId: "s-new", agentPreset: "buddy" } };
			},
			selectModel: async (arg: unknown) => {
				remoteCalls.push({ method: "selectModel", arg });
				return { ok: true, value: {} };
			},
		},
	};
	const panel = mountPanel(
		async (endpoint) =>
			endpoint === "buddyPersona/preferences"
				? { ok: true, value: { ...PREFS, model: { provider: "p", model: "m", reasoningEffort: "" } } }
				: { ok: true, value: { soul: "", agents: "", home: "/h" } },
		remote,
	);
	await settle();
	(button(panel.tree(), "settings.buddy:newConversation").props["onClick"] as () => void)();
	await settle();
	assert.deepEqual(remoteCalls, [
		{ method: "create", arg: { cwd: "/home/u/buddy-workspace", agentPreset: "buddy" } },
		{ method: "selectModel", arg: { sessionId: "s-new", provider: "p", model: "m" } },
	]);
	assert.deepEqual(panel.actions.slice(-3), [
		{ service: "sessions.refresh", arg: undefined },
		{ service: "sessions.open", arg: "s-new" },
		{ service: "layout.selectPanel", arg: null },
	]);
});

test("without a buddy model New Buddy conversation does not pick a model", async () => {
	const remoteCalls: string[] = [];
	const remote = {
		session: {
			create: async () => {
				remoteCalls.push("create");
				return { ok: true, value: { sessionId: "s-new" } };
			},
			selectModel: async () => {
				remoteCalls.push("selectModel");
				return { ok: true, value: {} };
			},
		},
	};
	const panel = mountPanel(
		async (endpoint) =>
			endpoint === "buddyPersona/preferences" ? { ok: true, value: PREFS } : { ok: true, value: { soul: "", agents: "", home: "/h" } },
		remote,
	);
	await settle();
	(button(panel.tree(), "settings.buddy:newConversation").props["onClick"] as () => void)();
	await settle();
	assert.deepEqual(remoteCalls, ["create"]);
});

test("a failed create is shown and nothing is opened", async () => {
	const remote = { session: { create: async () => ({ ok: false, error: { message: "no workspace" } }), selectModel: async () => ({ ok: true }) } };
	const panel = mountPanel(
		async (endpoint) =>
			endpoint === "buddyPersona/preferences" ? { ok: true, value: PREFS } : { ok: true, value: { soul: "", agents: "", home: "/h" } },
		remote,
	);
	await settle();
	(button(panel.tree(), "settings.buddy:newConversation").props["onClick"] as () => void)();
	await settle();
	assert.ok(texts(panel.tree()).includes("no workspace"));
	assert.ok(!panel.actions.some((action) => action.service === "sessions.open"));
});
```

Create `test/client-settings.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { contextStub, createRenderer, elements, loadClient, settle, type RecordedCall } from "./support/client-harness.ts";

const nodeRequire = createRequire(import.meta.url);
const PREFS = {
	model: { provider: "", model: "", reasoningEffort: "" },
	panel: { sections: { soul: true, agents: true, model: true, telegram: true } },
	conversationCwd: "/c",
};

function mountSettings(answer: (endpoint: string) => Promise<unknown>) {
	const renderer = createRenderer();
	const calls: RecordedCall[] = [];
	const client = loadClient((name) => renderer.modules[name] ?? nodeRequire(name));
	const { ctx, registrations } = contextStub({
		rpc: {
			call: async (route, endpoint, payload) => {
				calls.push({ route, endpoint, payload });
				return await answer(endpoint);
			},
		},
	});
	client.apply(ctx);
	const section = registrations.find((r) => r.options.name === "settings.section");
	assert.ok(section !== undefined);
	renderer.mount(section.component as () => unknown);
	return { calls, tree: () => renderer.tree() };
}

test("the settings tab holds module switches and the home path — no persona editors", async () => {
	const tab = mountSettings(async (endpoint) =>
		endpoint === "buddyPersona/preferences" ? { ok: true, value: PREFS } : { ok: true, value: { soul: "x", agents: "y", home: "/home/buddy" } },
	);
	await settle();
	const all = elements(tab.tree());
	assert.equal(all.filter((e) => e.type === "textarea").length, 0, "persona editing lives in the main panel now");
	assert.equal(all.filter((e) => e.type === "input" && e.props["type"] === "checkbox").length, 4);
	assert.ok(all.some((e) => e.props["children"] === "settings.buddy:homeLabel /home/buddy"));
});

test("toggling a module writes the whole sections object", async () => {
	const tab = mountSettings(async (endpoint) =>
		endpoint === "buddyPersona/preferences" || endpoint === "buddyPersona/updatePreferences"
			? { ok: true, value: PREFS }
			: { ok: true, value: { soul: "", agents: "", home: "/h" } },
	);
	await settle();
	const telegram = elements(tab.tree()).find((e) => e.type === "input" && e.props["name"] === "telegram");
	assert.ok(telegram !== undefined);
	(telegram.props["onChange"] as (event: { target: { checked: boolean } }) => void)({ target: { checked: false } });
	await settle();
	const write = tab.calls.find((call) => call.endpoint === "buddyPersona/updatePreferences");
	assert.deepEqual(write?.payload, {
		args: { patch: { panel: { sections: { soul: true, agents: true, model: true, telegram: false } } } },
	});
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npm run build && node --test test/client-ui.test.ts test/client-panel.test.ts test/client-settings.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement `modules.ts` and the document module**

Create `src/client/modules.ts`:

```ts
/**
 * The Buddy main panel is a table of modules. Later phases add rows here; the
 * panel itself never changes shape to accommodate them.
 * @module dsh-buddy/client/modules
 */
import type { PanelSectionId } from "../config.ts";

/** One main-panel module. */
export interface PanelModule<C> {
	readonly id: PanelSectionId;
	/** Ascending display order. */
	readonly order: number;
	/** Locale key of the module title. */
	readonly titleKey: string;
	readonly Component: C;
}

/**
 * @param modules - the module table.
 * @param sections - `buddy.panel.sections`; a module is hidden only by an explicit `false`.
 * @returns the visible modules, ordered.
 */
export function visibleModules<C>(
	modules: readonly PanelModule<C>[],
	sections: Partial<Record<PanelSectionId, boolean>> | undefined,
): PanelModule<C>[] {
	return modules.filter((module) => sections?.[module.id] !== false).sort((a, b) => a.order - b.order);
}
```

Create `src/client/document-module.tsx`:

```tsx
/**
 * The Soul and Agents modules: one authored Markdown file each.
 *
 * They stay two modules because only SOUL.md reaches the prompt as
 * `{{buddy_soul}}`; merging them would put operating rules into the voice.
 * @module dsh-buddy/client/document-module
 */
import { useCallback, useEffect, useState } from "react";
import type { Call } from "./call.ts";

/** Collaborators supplied by the plugin's `apply`. */
export interface DocumentModuleDeps {
	call: Call;
	t(key: string): string;
}

const styles = {
	block: { display: "flex", flexDirection: "column", gap: 8 },
	hint: { fontSize: 12, color: "var(--dsw-alias-label-secondary)", margin: 0 },
	error: { fontSize: 13, color: "var(--dsw-alias-status-error, #d64545)", margin: 0 },
	area: {
		minHeight: 160,
		fontFamily: "var(--dsw-font-mono, monospace)",
		fontSize: 13,
		padding: 8,
		borderRadius: 6,
		border: "1px solid var(--dsw-alias-border, #ccc)",
		background: "var(--dsw-alias-fill-input, transparent)",
		color: "inherit",
		resize: "vertical",
	},
	row: { display: "flex", alignItems: "center", gap: 8 },
	button: { padding: "6px 14px", borderRadius: 6, cursor: "pointer" },
} as const;

/**
 * @param deps - RPC and locale.
 * @param field - which document this module edits.
 * @returns the module component.
 */
export function createDocumentModule(deps: DocumentModuleDeps, field: "soul" | "agents"): () => unknown {
	return function DocumentModule(): unknown {
		const [loaded, setLoaded] = useState<{ home: string } | undefined>(undefined);
		const [text, setText] = useState("");
		const [busy, setBusy] = useState(false);
		const [error, setError] = useState<string | undefined>(undefined);

		const load = useCallback(async (): Promise<void> => {
			try {
				const view = (await deps.call("buddyPersona/persona", {})) as { soul: string; agents: string; home: string };
				setText(view[field]);
				setLoaded({ home: view.home });
				setError(undefined);
			} catch (cause) {
				setError((cause as Error).message);
			}
		}, []);

		useEffect(() => {
			void load();
		}, [load]);

		const save = async (): Promise<void> => {
			// Never before a successful load: the draft starts empty, and an empty
			// string is indistinguishable on the wire from "the user cleared it".
			if (loaded === undefined) return;
			setBusy(true);
			try {
				await deps.call("buddyPersona/updatePersona", { patch: { [field]: text } });
				setError(undefined);
			} catch (cause) {
				setError((cause as Error).message);
			} finally {
				setBusy(false);
			}
		};

		return (
			<section style={styles.block}>
				<p style={styles.hint}>{deps.t(field === "soul" ? "soulHint" : "agentsHint")}</p>
				<textarea
					style={styles.area}
					value={text}
					onChange={(event: { target: { value: string } }) => setText(event.target.value)}
				/>
				<div style={styles.row}>
					<button style={styles.button} type="button" disabled={busy || loaded === undefined} onClick={() => void save()}>
						{deps.t("save")}
					</button>
				</div>
				{error !== undefined && <p style={styles.error}>{error}</p>}
			</section>
		);
	};
}
```

- [ ] **Step 5: Implement the panel host and the slim settings**

Replace `src/client/panel.tsx` (keep `createBuddyIcon` exactly as it is — the folder reuses it in Task 13; delete `BuddySessionSummary`, `PanelDeps` and the old `createBuddyPanel`):

```tsx
/**
 * The Buddy main panel: Buddy's own configuration, one module per card.
 * Conversations are listed in the sidebar folder, not here.
 * @module dsh-buddy/client/panel
 */
import { useCallback, useEffect, useState } from "react";
import type { Call } from "./call.ts";
import { visibleModules, type PanelModule } from "./modules.ts";
import type { PanelSectionId } from "../config.ts";

/** Collaborators supplied by the plugin's `apply`. */
export interface PanelDeps {
	call: Call;
	t(key: string): string;
	modules: readonly PanelModule<() => unknown>[];
	/** Create, configure and open a new buddy conversation; rejects with a displayable message. */
	newConversation(): Promise<void>;
}

const styles = {
	panel: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0 },
	header: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 12,
		padding: "14px 20px",
		borderBottom: "1px solid var(--dsw-alias-border, #e5e5e5)",
	},
	title: { fontSize: 15, fontWeight: 600 },
	body: { flex: 1, minHeight: 0, overflowY: "auto", padding: "16px 20px", display: "flex", flexDirection: "column", gap: 16 },
	card: {
		background: "var(--dsw-alias-bg-layer-3)",
		border: "0.5px solid var(--dsw-alias-border-l2)",
		borderRadius: 10,
		padding: "14px 16px",
		display: "flex",
		flexDirection: "column",
		gap: 10,
	},
	cardTitle: { fontSize: 14, fontWeight: 600, margin: 0 },
	error: { fontSize: 13, color: "var(--dsw-alias-status-error, #d64545)", margin: 0 },
	button: { padding: "6px 14px", borderRadius: 6, cursor: "pointer" },
} as const;

/**
 * @param deps - RPC, locale, the module table and the create action.
 * @returns the component the `main` slot renders under `MAIN_PANEL_KEY`.
 */
export function createBuddyPanel(deps: PanelDeps): () => unknown {
	return function BuddyPanel(): unknown {
		const [sections, setSections] = useState<Partial<Record<PanelSectionId, boolean>> | undefined>(undefined);
		const [error, setError] = useState<string | undefined>(undefined);
		const [busy, setBusy] = useState(false);

		const load = useCallback(async (): Promise<void> => {
			try {
				const prefs = (await deps.call("buddyPersona/preferences", {})) as {
					panel: { sections: Record<PanelSectionId, boolean> };
				};
				setSections(prefs.panel.sections);
			} catch (cause) {
				// Visibility is a convenience: on failure every module shows.
				setSections({});
				setError((cause as Error).message);
			}
		}, []);

		useEffect(() => {
			void load();
		}, [load]);

		const create = async (): Promise<void> => {
			setBusy(true);
			try {
				await deps.newConversation();
				setError(undefined);
			} catch (cause) {
				setError((cause as Error).message);
			} finally {
				setBusy(false);
			}
		};

		return (
			<div style={styles.panel}>
				<div style={styles.header}>
					<span style={styles.title}>{deps.t("panelTitle")}</span>
					<button style={styles.button} type="button" disabled={busy} onClick={() => void create()}>
						{deps.t("newConversation")}
					</button>
				</div>
				<div style={styles.body}>
					{error !== undefined && <p style={styles.error}>{error}</p>}
					{sections !== undefined &&
						visibleModules(deps.modules, sections).map((module) => (
							<section key={module.id} style={styles.card}>
								<h3 style={styles.cardTitle}>{deps.t(module.titleKey)}</h3>
								<module.Component />
							</section>
						))}
				</div>
			</div>
		);
	};
}
```

(Keep `createBuddyIcon` below, unchanged.)

Replace `src/client/settings.tsx`:

```tsx
/**
 * The **Buddy** tab in Settings: settings *about* Buddy's surfaces — which
 * main-panel modules show — and where Buddy's files live. Buddy itself is
 * configured from the main panel.
 * @module dsh-buddy/client/settings
 */
import { useCallback, useEffect, useState } from "react";
import type { Call } from "./call.ts";
import { PANEL_SECTION_IDS, type PanelSectionId } from "../config.ts";

/** Collaborators supplied by the plugin's `apply`. */
export interface SettingsDeps {
	call: Call;
	t(key: string): string;
}

const TITLE_KEYS: Record<PanelSectionId, string> = {
	soul: "soulTitle",
	agents: "agentsTitle",
	model: "modelTitle",
	telegram: "telegramTitle",
};

const styles = {
	page: { display: "flex", flexDirection: "column", gap: 16, padding: "4px 2px" },
	label: { fontSize: 13, fontWeight: 600 },
	hint: { fontSize: 12, color: "var(--dsw-alias-label-secondary)", margin: 0 },
	error: { fontSize: 13, color: "var(--dsw-alias-status-error, #d64545)", margin: 0 },
	row: { display: "flex", alignItems: "center", gap: 8 },
} as const;

/**
 * @param deps - RPC and locale.
 * @returns the component the `settings.section` slot renders.
 */
export function createBuddySettingsSection(deps: SettingsDeps): () => unknown {
	return function BuddySettingsSection(): unknown {
		const [sections, setSections] = useState<Record<PanelSectionId, boolean> | undefined>(undefined);
		const [home, setHome] = useState<string | undefined>(undefined);
		const [error, setError] = useState<string | undefined>(undefined);

		const load = useCallback(async (): Promise<void> => {
			try {
				const [prefs, persona] = await Promise.all([
					deps.call("buddyPersona/preferences", {}),
					deps.call("buddyPersona/persona", {}),
				]);
				setSections((prefs as { panel: { sections: Record<PanelSectionId, boolean> } }).panel.sections);
				setHome((persona as { home: string }).home);
				setError(undefined);
			} catch (cause) {
				setError((cause as Error).message);
			}
		}, []);

		useEffect(() => {
			void load();
		}, [load]);

		const toggle = async (id: PanelSectionId, checked: boolean): Promise<void> => {
			if (sections === undefined) return;
			const next = { ...sections, [id]: checked };
			setSections(next);
			try {
				const prefs = (await deps.call("buddyPersona/updatePreferences", { patch: { panel: { sections: next } } })) as {
					panel: { sections: Record<PanelSectionId, boolean> };
				};
				setSections(prefs.panel.sections);
				setError(undefined);
			} catch (cause) {
				setError((cause as Error).message);
			}
		};

		return (
			<div style={styles.page}>
				<p style={styles.hint}>{deps.t("settingsHint")}</p>
				<div style={styles.label}>{deps.t("sectionsTitle")}</div>
				{sections !== undefined &&
					PANEL_SECTION_IDS.map((id) => (
						<label key={id} style={styles.row}>
							<input
								type="checkbox"
								name={id}
								checked={sections[id]}
								onChange={(event: { target: { checked: boolean } }) => void toggle(id, event.target.checked)}
							/>
							<span>{deps.t(TITLE_KEYS[id])}</span>
						</label>
					))}
				{home !== undefined && <p style={styles.hint}>{`${deps.t("homeLabel")} ${home}`}</p>}
				{error !== undefined && <p style={styles.error}>{error}</p>}
			</div>
		);
	};
}
```

- [ ] **Step 6: Wire `index.tsx`**

In `src/client/index.tsx`:

- imports: add `BUDDY_PRESET_ID` to the `../index.ts` import; add `import { selectionFromDefault } from "../model-selection.ts";`, `import { createDocumentModule } from "./document-module.tsx";`, `import type { PanelModule } from "./modules.ts";`; `createBuddyPanel, createBuddyIcon` from `./panel.tsx`.
- `export const inject = ["slots", "locale", "connection", "layout", "sessions", "remote", "remote.session"];` and extend its doc comment: "`remote.session` creates a buddy conversation with its preset and model".
- dictionaries — replace `en`/`zh` with:

```ts
const en = {
	nav: "Buddy",
	panelTitle: "Buddy",
	newConversation: "New Buddy conversation",
	soulTitle: "Soul",
	soulHint: "Voice, attitude and opinions. Saved to SOUL.md and used by buddy conversations only.",
	agentsTitle: "Agents",
	agentsHint: "Rules Buddy follows. Saved to AGENTS.md, kept separate from voice on purpose.",
	modelTitle: "Model",
	telegramTitle: "Telegram",
	save: "Save",
	homeLabel: "Files:",
	settingsHint: "Choose what the Buddy main panel shows. Buddy itself is configured from the main panel.",
	sectionsTitle: "Main panel modules",
	folderTitle: "Buddy",
	folderEmpty: "No conversations yet",
	untitled: "Untitled",
	fromTelegram: "Telegram",
	expand: "Show conversations",
	collapse: "Hide conversations",
};

const zh: typeof en = {
	nav: "Buddy",
	panelTitle: "Buddy",
	newConversation: "新建 Buddy 对话",
	soulTitle: "Soul",
	soulHint: "声音、态度与观点。保存到 SOUL.md，仅对 buddy 对话生效。",
	agentsTitle: "Agents",
	agentsHint: "Buddy 遵循的规则。保存到 AGENTS.md，与人格刻意分开。",
	modelTitle: "模型",
	telegramTitle: "Telegram",
	save: "保存",
	homeLabel: "文件位置：",
	settingsHint: "选择 Buddy 主界面显示哪些模块。Buddy 本身在主界面里配置。",
	sectionsTitle: "主界面模块",
	folderTitle: "Buddy",
	folderEmpty: "还没有对话",
	untitled: "未命名",
	fromTelegram: "Telegram",
	expand: "展开对话",
	collapse: "收起对话",
};
```

(Task 12 adds model/telegram keys; Task 13 uses the folder keys.)

- in `apply`, replace the panel construction with:

```ts
	const modules: PanelModule<() => unknown>[] = [
		{ id: "soul", order: 10, titleKey: "soulTitle", Component: createDocumentModule({ call, t }, "soul") },
		{ id: "agents", order: 20, titleKey: "agentsTitle", Component: createDocumentModule({ call, t }, "agents") },
	];

	const openSession = (sessionId: string): void => {
		ctx.sessions.open(sessionId);
		// null returns the centre column to the Conversation.
		ctx.layout.selectPanel(null);
	};

	/** Unwrap a `remote.*` RemoteResult. */
	const remoteValue = (result: any, what: string): any => {
		if (result?.ok !== true) throw new Error(result?.error?.message ?? `${what} failed`);
		return result.value;
	};

	const newConversation = async (): Promise<void> => {
		const session = ctx.remote?.session;
		if (session === undefined) throw new Error("remote.session is not mounted");
		const prefs = (await call("buddyPersona/preferences", {})) as {
			model: { provider: string; model: string; reasoningEffort: string };
			conversationCwd: string;
		};
		const created = remoteValue(
			await session.create({ cwd: prefs.conversationCwd, agentPreset: BUDDY_PRESET_ID }),
			"session create",
		) as { sessionId: string };
		const selection = selectionFromDefault(prefs.model);
		if (selection !== undefined) {
			remoteValue(await session.selectModel({ sessionId: created.sessionId, ...selection }), "model selection");
		}
		// A raw remote create bypasses the client list; refresh before opening.
		await ctx.sessions.refresh();
		openSession(created.sessionId);
	};

	const BuddyPanel = createBuddyPanel({ call, t, modules, newConversation });
```

Keep the `main` and `sidebar.panellist` registrations as they are.

- [ ] **Step 7: Run the gate**

Run: `npm run check`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add src/client package.json test/client-ui.test.ts test/client-panel.test.ts test/client-settings.test.ts
git commit -m "feat: modular buddy main panel with soul, agents and new conversation; slim settings tab"
```

---

### Task 12: Model and Telegram modules

**Files:**
- Create: `src/client/model-module.tsx`, `src/client/telegram-module.tsx`
- Modify: `src/client/index.tsx`, `package.json` (`dsh.client.inject`)
- Test: `test/client-panel.test.ts`, `test/client-ui.test.ts`

**Interfaces:**
- Consumes: `ctx.remote.session.modelCatalog()` → `RemoteResult<ModelCatalog>`; `ctx.remote.credentials.set/unset(TELEGRAM_BOT_TOKEN, …)`; `buddyTelegram/status`, `buddyTelegram/config`, `buddyTelegram/updateConfig`.
- Produces:
  - `createModelModule(deps: { call: Call; t(key: string): string; catalog(): Promise<ModelCatalog> }): () => unknown`.
  - `createTelegramModule(deps: { call: Call; t(key: string): string; writeToken(value: string | undefined): Promise<void> }): () => unknown`.
  - Client `inject` gains `"remote.credentials"`.

- [ ] **Step 1: Find the `remote.credentials` declaring package**

```bash
H=/home/panda-nuc/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai
grep -rl "credentials" --include='*.d.ts' "$H"/*/lib/types/client 2>/dev/null | head
```

Record the package that augments `Context` with `remote.credentials`; add it to `dsh.client.inject` if absent and to the provider map in `test/client-ui.test.ts`.

- [ ] **Step 2: Write the failing tests**

In `test/client-ui.test.ts`: inject becomes `[..., "remote", "remote.session", "remote.credentials"]`; add `"remote.credentials"` to the provider map; extend the dictionary key list with every key added in Step 4.

Append to `test/client-panel.test.ts` (reuse `mountPanel`, `button`, `texts`, `PREFS`):

```ts
const ONLY = (id: string) => ({ ...PREFS, panel: { sections: { soul: false, agents: false, model: false, telegram: false, [id]: true } } });

const CATALOG = {
	default: { provider: "g", model: "gm" },
	routableProviders: ["p"],
	groups: [
		{
			id: "p",
			name: "Provider P",
			models: [
				{ id: "m1", name: "Model 1", reasoning: { efforts: [{ id: "low", name: "Low" }, { id: "high", name: "High" }] } },
				{ id: "m2", name: "Model 2" },
			],
		},
	],
	failures: [],
};

test("the model module saves a concrete buddy default", async () => {
	const remote = { session: { modelCatalog: async () => ({ ok: true, value: CATALOG }) } };
	const panel = mountPanel(
		async (endpoint) => ({ ok: true, value: endpoint === "buddyPersona/updatePreferences" ? PREFS : ONLY("model") }),
		remote,
	);
	await settle();
	const follow = elements(panel.tree()).find((e) => e.type === "input" && e.props["name"] === "followDefault");
	assert.equal(follow?.props["checked"], true, "an empty buddy model reads as following the global default");
	(follow?.props["onChange"] as (event: { target: { checked: boolean } }) => void)({ target: { checked: false } });
	const provider = elements(panel.tree()).find((e) => e.type === "select" && e.props["name"] === "provider");
	(provider?.props["onChange"] as (event: { target: { value: string } }) => void)({ target: { value: "p" } });
	const model = elements(panel.tree()).find((e) => e.type === "select" && e.props["name"] === "model");
	(model?.props["onChange"] as (event: { target: { value: string } }) => void)({ target: { value: "m1" } });
	const effort = elements(panel.tree()).find((e) => e.type === "select" && e.props["name"] === "effort");
	(effort?.props["onChange"] as (event: { target: { value: string } }) => void)({ target: { value: "high" } });
	(button(panel.tree(), "settings.buddy:save").props["onClick"] as () => void)();
	await settle();
	const write = panel.calls.find((call) => call.endpoint === "buddyPersona/updatePreferences");
	assert.deepEqual(write?.payload, { args: { patch: { model: { provider: "p", model: "m1", reasoningEffort: "high" } } } });
});

test("following the global default saves an empty model", async () => {
	const remote = { session: { modelCatalog: async () => ({ ok: true, value: CATALOG }) } };
	const panel = mountPanel(
		async () => ({ ok: true, value: { ...ONLY("model"), model: { provider: "p", model: "m2", reasoningEffort: "" } } }),
		remote,
	);
	await settle();
	const follow = elements(panel.tree()).find((e) => e.type === "input" && e.props["name"] === "followDefault");
	assert.equal(follow?.props["checked"], false);
	(follow?.props["onChange"] as (event: { target: { checked: boolean } }) => void)({ target: { checked: true } });
	(button(panel.tree(), "settings.buddy:save").props["onClick"] as () => void)();
	await settle();
	const write = panel.calls.find((call) => call.endpoint === "buddyPersona/updatePreferences");
	assert.deepEqual(write?.payload, { args: { patch: { model: { provider: "", model: "", reasoningEffort: "" } } } });
});

test("the telegram module shows status and saves config through buddyTelegram", async () => {
	const status = { state: "error", detail: "dsh-telegram is still polling this bot; remove it from the profile first", botUsername: "example_dev_bot", token: { configured: true, source: "file", writable: true }, sessions: 2 };
	const config = { enabled: false, ownerUserId: "1000000000", defaultCwd: "~/dsh-telegram", permissionPreset: "workspace-write", renderMarkdown: true, mediaDelivery: "all" };
	const panel = mountPanel(async (endpoint) => {
		if (endpoint === "buddyPersona/preferences") return { ok: true, value: ONLY("telegram") };
		if (endpoint === "buddyTelegram/status") return { ok: true, value: status };
		return { ok: true, value: config };
	});
	await settle();
	assert.ok(texts(panel.tree()).includes(status.detail), "the occupancy detail must be visible");
	const enabled = elements(panel.tree()).find((e) => e.type === "input" && e.props["name"] === "enabled");
	(enabled?.props["onChange"] as (event: { target: { checked: boolean } }) => void)({ target: { checked: true } });
	(button(panel.tree(), "settings.buddy:telegramSave").props["onClick"] as () => void)();
	await settle();
	const write = panel.calls.find((call) => call.endpoint === "buddyTelegram/updateConfig");
	assert.deepEqual(write?.payload, { args: { patch: { enabled: true } } });
});

test("the telegram token is written through remote.credentials and never read back", async () => {
	const writes: unknown[] = [];
	const remote = {
		credentials: {
			set: async (ref: string, value: string) => {
				writes.push({ ref, value });
				return { ok: true };
			},
			unset: async (ref: string) => {
				writes.push({ ref });
				return { ok: true };
			},
		},
	};
	const panel = mountPanel(async (endpoint) => {
		if (endpoint === "buddyPersona/preferences") return { ok: true, value: ONLY("telegram") };
		if (endpoint === "buddyTelegram/status") return { ok: true, value: { state: "off", token: { configured: false, writable: true }, sessions: 0 } };
		return { ok: true, value: { enabled: false, ownerUserId: "", defaultCwd: "", permissionPreset: "workspace-write", renderMarkdown: true, mediaDelivery: "all" } };
	}, remote);
	await settle();
	const input = elements(panel.tree()).find((e) => e.type === "input" && e.props["type"] === "password");
	(input?.props["onChange"] as (event: { target: { value: string } }) => void)({ target: { value: " 123:abc " } });
	(button(panel.tree(), "settings.buddy:tokenSave").props["onClick"] as () => void)();
	await settle();
	assert.deepEqual(writes, [{ ref: "TELEGRAM_BOT_TOKEN", value: "123:abc" }]);
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npm run build && node --test test/client-ui.test.ts test/client-panel.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement**

Create `src/client/model-module.tsx`:

```tsx
/**
 * The Model module: Buddy's default model for new conversations.
 * Empty means "follow the global default"; a chat's own `/model` still wins.
 * @module dsh-buddy/client/model-module
 */
import { useCallback, useEffect, useState } from "react";
import type { Call } from "./call.ts";

/** `dsh-api-session-controller`'s `ModelCatalog`, trimmed to what is read. */
export interface ModelCatalog {
	readonly groups: readonly {
		readonly id: string;
		readonly name: string;
		readonly models: readonly {
			readonly id: string;
			readonly name: string;
			readonly reasoning?: { readonly efforts: readonly { readonly id: string; readonly name: string }[] };
		}[];
	}[];
}

interface Draft {
	provider: string;
	model: string;
	reasoningEffort: string;
}

/** Collaborators supplied by the plugin's `apply`. */
export interface ModelModuleDeps {
	call: Call;
	t(key: string): string;
	catalog(): Promise<ModelCatalog>;
}

const styles = {
	block: { display: "flex", flexDirection: "column", gap: 10 },
	field: { display: "flex", flexDirection: "column", gap: 4 },
	label: { fontSize: 13, fontWeight: 500 },
	hint: { fontSize: 12, color: "var(--dsw-alias-label-secondary)", margin: 0 },
	error: { fontSize: 13, color: "var(--dsw-alias-status-error, #d64545)", margin: 0 },
	input: { fontSize: 13, padding: "6px 8px", borderRadius: 6, border: "0.5px solid var(--dsw-alias-border-l2)" },
	row: { display: "flex", alignItems: "center", gap: 8 },
	button: { padding: "6px 14px", borderRadius: 6, cursor: "pointer" },
} as const;

const EMPTY: Draft = { provider: "", model: "", reasoningEffort: "" };

/**
 * @param deps - RPC, locale and the model catalog.
 * @returns the module component.
 */
export function createModelModule(deps: ModelModuleDeps): () => unknown {
	return function ModelModule(): unknown {
		const [catalog, setCatalog] = useState<ModelCatalog | undefined>(undefined);
		const [draft, setDraft] = useState<Draft | undefined>(undefined);
		const [follow, setFollow] = useState(true);
		const [busy, setBusy] = useState(false);
		const [error, setError] = useState<string | undefined>(undefined);

		const load = useCallback(async (): Promise<void> => {
			try {
				const [prefs, nextCatalog] = await Promise.all([deps.call("buddyPersona/preferences", {}), deps.catalog()]);
				const model = (prefs as { model: Draft }).model;
				setCatalog(nextCatalog);
				setDraft({ ...model });
				setFollow(model.provider === "" || model.model === "");
				setError(undefined);
			} catch (cause) {
				setError((cause as Error).message);
			}
		}, []);

		useEffect(() => {
			void load();
		}, [load]);

		if (draft === undefined || catalog === undefined) {
			return error === undefined ? null : <p style={styles.error}>{error}</p>;
		}

		const group = catalog.groups.find((candidate) => candidate.id === draft.provider);
		const model = group?.models.find((candidate) => candidate.id === draft.model);
		const efforts = model?.reasoning?.efforts ?? [];

		const save = async (): Promise<void> => {
			setBusy(true);
			try {
				await deps.call("buddyPersona/updatePreferences", { patch: { model: follow ? EMPTY : draft } });
				setError(undefined);
			} catch (cause) {
				setError((cause as Error).message);
			} finally {
				setBusy(false);
			}
		};

		return (
			<section style={styles.block}>
				<p style={styles.hint}>{deps.t("modelHint")}</p>
				<label style={styles.row}>
					<input
						type="checkbox"
						name="followDefault"
						checked={follow}
						onChange={(event: { target: { checked: boolean } }) => setFollow(event.target.checked)}
					/>
					<span style={styles.label}>{deps.t("modelFollow")}</span>
				</label>
				{!follow && (
					<>
						<div style={styles.field}>
							<span style={styles.label}>{deps.t("modelProvider")}</span>
							<select
								style={styles.input}
								name="provider"
								value={draft.provider}
								onChange={(event: { target: { value: string } }) =>
									setDraft({ provider: event.target.value, model: "", reasoningEffort: "" })
								}
							>
								<option value="">{deps.t("modelChoose")}</option>
								{catalog.groups.map((candidate) => (
									<option key={candidate.id} value={candidate.id}>
										{candidate.name}
									</option>
								))}
							</select>
						</div>
						<div style={styles.field}>
							<span style={styles.label}>{deps.t("modelModel")}</span>
							<select
								style={styles.input}
								name="model"
								value={draft.model}
								onChange={(event: { target: { value: string } }) =>
									setDraft({ provider: draft.provider, model: event.target.value, reasoningEffort: "" })
								}
							>
								<option value="">{deps.t("modelChoose")}</option>
								{(group?.models ?? []).map((candidate) => (
									<option key={candidate.id} value={candidate.id}>
										{candidate.name}
									</option>
								))}
							</select>
						</div>
						{efforts.length > 0 && (
							<div style={styles.field}>
								<span style={styles.label}>{deps.t("modelEffort")}</span>
								<select
									style={styles.input}
									name="effort"
									value={draft.reasoningEffort}
									onChange={(event: { target: { value: string } }) => setDraft({ ...draft, reasoningEffort: event.target.value })}
								>
									<option value="">{deps.t("modelEffortDefault")}</option>
									{efforts.map((candidate) => (
										<option key={candidate.id} value={candidate.id}>
											{candidate.name}
										</option>
									))}
								</select>
							</div>
						)}
					</>
				)}
				<div style={styles.row}>
					<button
						style={styles.button}
						type="button"
						disabled={busy || (!follow && (draft.provider === "" || draft.model === ""))}
						onClick={() => void save()}
					>
						{deps.t("save")}
					</button>
				</div>
				{error !== undefined && <p style={styles.error}>{error}</p>}
			</section>
		);
	};
}
```

The test harness's JSX stub must render `<>…</>`: `Fragment` is already provided by `createRenderer` (`Symbol.for("react.fragment")`), and `elements()` walks `props.children` regardless of type, so no harness change is needed.

Create `src/client/telegram-module.tsx` by porting `~/repo/dsh-plugins/dsh-telegram/src/client/index.tsx`'s `TelegramSection` component (its lines 238–582) with these exact changes:

1. It is `export function createTelegramModule(deps: { call: Call; t(key: string): string; writeToken(value: string | undefined): Promise<void> }): () => unknown` returning `function TelegramModule(): unknown { … }`; copy the `Config` and `Status` interfaces, `sourceLabel`, and `styles` (drop `pane`, `h2`; the card title comes from the panel).
2. `call` → `deps.call`; `writeToken` → `deps.writeToken`; `t(...)` → `deps.t(...)`.
3. Endpoints: `telegram/config` → `buddyTelegram/config`, `telegram/status` → `buddyTelegram/status`, `telegram/updateConfig` → `buddyTelegram/updateConfig`.
4. Remove the `<h2>{t("title")}</h2>` and the description paragraph from both the loading and loaded returns; the loaded return's outer element is `<div style={{ display: "flex", flexDirection: "column", gap: 16 }}>`.
5. Locale keys are prefixed to live in Buddy's namespace: every `t("x")` becomes `deps.t("telegramX")` with the first letter of `x` upper-cased (`tokenTitle` → `telegramTokenTitle`, `save` → `telegramSave` for the config save button, `statusSessions` → `telegramStatusSessions`, …) — **except** the token Save button, which uses `deps.t("tokenSave")`, and the token Clear button, which uses `deps.t("tokenClear")`.
6. Add `name` props: the owner input `name="ownerUserId"`, cwd `name="defaultCwd"`, preset select `name="permissionPreset"`, markdown checkbox `name="renderMarkdown"`, media select `name="mediaDelivery"`, enabled checkbox `name="enabled"`.
7. The status detail paragraph renders whenever `status.detail !== undefined && status.state !== "running"` (unchanged) — it is how the occupancy message reaches the user.
8. `telegramStatusSessions` is a function key; call it as `(deps.t("telegramStatusSessions") as unknown as (n: number) => string)(status.sessions)`.

In `src/client/index.tsx`:

- `inject` adds `"remote.credentials"`;
- add `import { createModelModule } from "./model-module.tsx";`, `import { createTelegramModule } from "./telegram-module.tsx";`;
- append two module rows:

```ts
		{
			id: "model",
			order: 30,
			titleKey: "modelTitle",
			Component: createModelModule({
				call,
				t,
				catalog: async () => remoteValue(await ctx.remote.session.modelCatalog(), "model catalog"),
			}),
		},
		{
			id: "telegram",
			order: 40,
			titleKey: "telegramTitle",
			Component: createTelegramModule({
				call,
				t,
				writeToken: async (value) => {
					const credentials = ctx.remote?.credentials;
					if (credentials === undefined) throw new Error("remote.credentials is not mounted");
					const result = value === undefined
						? await credentials.unset(TELEGRAM_TOKEN_KEY)
						: await credentials.set(TELEGRAM_TOKEN_KEY, value);
					if (result?.ok !== true) throw new Error(result?.error?.message ?? "credential write failed");
				},
			}),
		},
```

(move `remoteValue` above `modules`; import `TELEGRAM_TOKEN_KEY` from `../telegram/credential-key.ts` — a constant-only module, safe to bundle into the browser).

- dictionaries: add to `en` the Model keys

```ts
	modelHint: "Default model for new Buddy conversations. A chat's own /model choice still wins.",
	modelFollow: "Follow the global default model",
	modelProvider: "Provider",
	modelModel: "Model",
	modelEffort: "Reasoning effort",
	modelEffortDefault: "Model default",
	modelChoose: "Choose…",
```

and the Telegram keys, which are dsh-telegram's `en` dictionary (its lines 126–171) with `nav`, `title`, `description` dropped, every remaining key renamed with the `telegram` prefix rule from item 5 above, plus `tokenSave: "Save token"` and `tokenClear: "Clear token"`. Do the same for `zh` from dsh-telegram's `zh` dictionary (lines 172–214), with `modelHint: "新建 Buddy 对话默认使用的模型。聊天里用 /model 单独选的模型仍然优先。"`, `modelFollow: "跟随全局默认模型"`, `modelProvider: "Provider"`, `modelModel: "模型"`, `modelEffort: "推理强度"`, `modelEffortDefault: "模型默认"`, `modelChoose: "请选择…"`, `tokenSave: "保存 token"`, `tokenClear: "清除 token"`. In `telegramCwdHint` (both languages) replace "Telegram sessions run" / "Telegram 会话在这里跑" with "Buddy's Telegram conversations run" / "Buddy 的 Telegram 对话在这里跑".

- [ ] **Step 5: Run the gate**

Run: `npm run check`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/client package.json test/client-ui.test.ts test/client-panel.test.ts
git commit -m "feat: model and telegram modules on the buddy main panel"
```

---

### Task 13: Sidebar folder above Settings replaces the panellist button

**Files:**
- Create: `src/client/folder.tsx`
- Modify: `src/client/index.tsx`
- Test: `test/client-folder.test.ts`, `test/client-ui.test.ts`

**Interfaces:**
- Consumes: `buddyPersona/sessions` (with `source`), `ctx.sessions.list.{getSnapshot,subscribe}`, `ctx.layout.selectPanel`, `MAIN_PANEL_KEY`, `createBuddyIcon`.
- Produces: `createBuddyFolder(deps: FolderDeps): (props: { wide: boolean }) => unknown` with

```ts
export interface FolderDeps {
	call: Call;
	t(key: string): string;
	openPanel(): void;
	openSession(sessionId: string): void;
	list: { getSnapshot(): { current?: string | undefined }; subscribe(listener: () => void): () => void };
	expanded: { read(): boolean; write(value: boolean): void };
	/** Debounce for reloads triggered by session-list changes; tests pass 0. */
	reloadDelayMs: number;
}
```

- Registration: `sidebar.footer.action`, id `buddy-folder`, `order: -10`, `locale: NS`.

- [ ] **Step 1: Write the failing tests**

In `test/client-ui.test.ts`, replace the pairing/count/icon/"neither alone" tests with:

```ts
test("the browser half registers the settings tab, the main panel and the sidebar folder — no panellist button", () => {
	const client = loadClient();
	const { ctx, registrations, injected } = contextStub();
	client.apply(ctx);
	assert.deepEqual(injected, ["settings.section", "main", "sidebar.footer.action"]);
	assert.equal(registrations.length, 3);
	const folder = registrations.find((r) => r.options.name === "sidebar.footer.action");
	assert.ok(folder !== undefined);
	assert.equal((folder.options as { id: string }).id, "buddy-folder");
	assert.equal((folder.options as { order: number }).order, -10);
	assert.ok(!registrations.some((r) => r.options.name === "sidebar.panellist"));
});

test("no registration happens when the shell has none of the matching slots", () => {
	const client = loadClient();
	const { ctx, registrations, injected } = contextStub({ runSlotCallback: false });
	client.apply(ctx);
	assert.deepEqual(injected, ["settings.section", "main", "sidebar.footer.action"]);
	assert.equal(registrations.length, 0);
});
```

Keep the `MAIN_PANEL_KEY` source-text test; it still pins the import.

Create `test/client-folder.test.ts`:

```ts
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
	assert.deepEqual(folder.calls, []);
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
	folder.changeList("s-tg");
	await settle();
	await settle();
	assert.equal(folder.calls.length, 2);
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run build && node --test test/client-ui.test.ts test/client-folder.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `src/client/folder.tsx`:

```tsx
/**
 * The Buddy folder at the sidebar foot, directly above Settings.
 *
 * The title opens the Buddy main panel; the chevron lists buddy conversations.
 * The client session list carries no preset, so the rows come from the host's
 * `buddyPersona/sessions`, re-read whenever the client list changes.
 * @module dsh-buddy/client/folder
 */
import { useCallback, useEffect, useState } from "react";
import type { Call } from "./call.ts";
import { createBuddyIcon } from "./panel.tsx";

/** One buddy conversation; mirrors the host's `BuddySessionSummary`. */
interface Summary {
	sessionId: string;
	title: string;
	updatedAt: number;
	cwd: string;
	source: "telegram" | "web";
}

/** Collaborators supplied by the plugin's `apply`. */
export interface FolderDeps {
	call: Call;
	t(key: string): string;
	openPanel(): void;
	openSession(sessionId: string): void;
	list: { getSnapshot(): { current?: string | undefined }; subscribe(listener: () => void): () => void };
	expanded: { read(): boolean; write(value: boolean): void };
	/** Debounce for reloads triggered by session-list changes; tests pass 0. */
	reloadDelayMs: number;
}

const styles = {
	root: { width: "100%", display: "flex", flexDirection: "column" },
	header: { display: "flex", alignItems: "center", gap: 4, width: "100%" },
	title: {
		flex: 1,
		display: "flex",
		alignItems: "center",
		gap: 8,
		padding: "6px 8px",
		border: "none",
		background: "transparent",
		color: "inherit",
		cursor: "pointer",
		fontSize: 13,
		textAlign: "left",
	},
	chevron: { border: "none", background: "transparent", color: "inherit", cursor: "pointer", padding: "4px 6px" },
	list: { maxHeight: "40vh", overflowY: "auto", display: "flex", flexDirection: "column", gap: 2, paddingLeft: 20 },
	row: {
		display: "flex",
		alignItems: "center",
		gap: 6,
		padding: "4px 8px",
		borderRadius: 6,
		border: "none",
		background: "transparent",
		color: "inherit",
		cursor: "pointer",
		fontSize: 13,
		textAlign: "left",
	},
	rowCurrent: { background: "var(--dsw-alias-fill-secondary, rgba(127,127,127,.12))" },
	badge: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)" },
	muted: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)", padding: "4px 8px" },
	rail: { border: "none", background: "transparent", color: "inherit", cursor: "pointer", padding: 8 },
} as const;

/**
 * @param deps - RPC, locale, navigation, the client session list and persisted expansion.
 * @returns the `sidebar.footer.action` component.
 */
export function createBuddyFolder(deps: FolderDeps): (props: { wide: boolean }) => unknown {
	const Icon = createBuddyIcon();
	return function BuddyFolder(props: { wide: boolean }): unknown {
		const [open, setOpen] = useState(() => deps.expanded.read());
		const [items, setItems] = useState<Summary[] | undefined>(undefined);
		const [error, setError] = useState<string | undefined>(undefined);
		const [current, setCurrent] = useState(() => deps.list.getSnapshot().current);

		const load = useCallback(async (): Promise<void> => {
			try {
				setItems((await deps.call("buddyPersona/sessions", {})) as Summary[]);
				setError(undefined);
			} catch (cause) {
				setError((cause as Error).message);
			}
		}, []);

		useEffect(() => {
			if (open) void load();
		}, [open, load]);

		useEffect(() => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const unsubscribe = deps.list.subscribe(() => {
				setCurrent(deps.list.getSnapshot().current);
				if (!open) return;
				if (timer !== undefined) clearTimeout(timer);
				timer = setTimeout(() => void load(), deps.reloadDelayMs);
			});
			return () => {
				if (timer !== undefined) clearTimeout(timer);
				unsubscribe();
			};
		}, [open, load]);

		if (!props.wide) {
			return (
				<button style={styles.rail} type="button" aria-label={deps.t("folderTitle")} onClick={() => deps.openPanel()}>
					<Icon size={18} />
				</button>
			);
		}

		const toggle = (): void => {
			deps.expanded.write(!open);
			setOpen(!open);
		};

		return (
			<div style={styles.root}>
				<div style={styles.header}>
					<button style={styles.title} type="button" aria-label={deps.t("folderTitle")} onClick={() => deps.openPanel()}>
						<Icon size={16} />
						<span>{deps.t("folderTitle")}</span>
					</button>
					<button
						style={styles.chevron}
						type="button"
						aria-label={deps.t(open ? "collapse" : "expand")}
						aria-expanded={open ? "true" : "false"}
						onClick={toggle}
					>
						{open ? "▾" : "▸"}
					</button>
				</div>
				{open && (
					<div style={styles.list}>
						{error !== undefined && <div style={styles.muted}>{error}</div>}
						{error === undefined && items !== undefined && items.length === 0 && (
							<div style={styles.muted}>{deps.t("folderEmpty")}</div>
						)}
						{items?.map((item) => {
							const label = item.title.trim() === "" ? deps.t("untitled") : item.title;
							const isCurrent = item.sessionId === current;
							return (
								<button
									key={item.sessionId}
									style={isCurrent ? { ...styles.row, ...styles.rowCurrent } : styles.row}
									type="button"
									aria-label={label}
									aria-current={isCurrent ? "true" : "false"}
									onClick={() => deps.openSession(item.sessionId)}
								>
									<span>{label}</span>
									{item.source === "telegram" && <span style={styles.badge}>{deps.t("fromTelegram")}</span>}
								</button>
							);
						})}
					</div>
				)}
			</div>
		);
	};
}
```

Note: the folder's first `useEffect` loads only when `open`; the test "starts collapsed and loads nothing" relies on `expanded.read()` returning `false` in Node, where `localStorage` is absent.

In `src/client/index.tsx`:

- import `createBuddyFolder` from `./folder.tsx`; drop `createBuddyIcon` from the `./panel.tsx` import;
- replace the `sidebar.panellist` registration with:

```ts
	const EXPANDED_KEY = "dsh-buddy.folder.expanded";
	const BuddyFolder = createBuddyFolder({
		call,
		t,
		openPanel: () => ctx.layout.selectPanel(MAIN_PANEL_KEY),
		openSession,
		list: ctx.sessions.list,
		expanded: {
			// Per-browser convenience only; storage may be absent or throw.
			read: () => {
				try {
					return globalThis.localStorage?.getItem(EXPANDED_KEY) === "1";
				} catch {
					return false;
				}
			},
			write: (value) => {
				try {
					globalThis.localStorage?.setItem(EXPANDED_KEY, value ? "1" : "0");
				} catch {
					// ignored
				}
			},
		},
		reloadDelayMs: 500,
	});

	// Directly above Settings: `sidebar.footer.action` renders in the foot area
	// before `sidebar.settings`. Negative order sorts it ahead of ui-cordis's
	// `cordis-panel` (order 0), which renders nothing unless it has content.
	ctx.slots.inject("sidebar.footer.action", () =>
		ctx.slots.register({ name: "sidebar.footer.action", id: "buddy-folder", order: -10, locale: NS }, BuddyFolder),
	);
```

- update the module doc comment: the pair is now the folder (whose title selects `MAIN_PANEL_KEY`) and the `main` panel; drop the "Task 7/8" history.

`contextStub`'s default `sessions` is `{}`, so `ctx.sessions.list` is `undefined` in tests that do not pass one; `createBuddyFolder` is only *called* on render, but `list: ctx.sessions.list` is read in `apply`. Give `contextStub`'s default `sessions` a `list: { getSnapshot: () => ({}), subscribe: () => () => undefined }` in `test/support/client-harness.ts`.

- [ ] **Step 4: Run the gate**

Run: `npm run check`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client test/client-ui.test.ts test/client-folder.test.ts test/support/client-harness.ts
git commit -m "feat: buddy folder above settings lists buddy conversations"
```

---

### Task 14: Documentation

**Files:**
- Modify: `CLAUDE.md`, `README.md`, `docs/superpowers/specs/2026-09-12-buddy-telegram-design.md`

- [ ] **Step 1: Update `CLAUDE.md`**

- Architecture: "two host cordis rows plus one browser half" → "three host cordis rows (plus the empty `dsh-buddy` anchor row) and one browser half". Add a bullet for **Row `dsh-buddy/telegram`** (`src/telegram/`): absorbed from dsh-telegram at the commit recorded in Task 3; settings `buddy-telegram`, domain `buddy_telegram`, service/typert `buddyTelegram`; sessions always on the `buddy` preset (fail-closed) and model precedence chat `/model` > `buddy.model` > global; refuses to poll while a `dsh-telegram` row is mounted and `telegram.enabled` is on.
- Browser half bullet: Settings → Buddy is module visibility + home only; the `main` panel is a module table (`src/client/modules.ts`); the sidebar entry is a `sidebar.footer.action` folder, not a panellist button.
- Invariants: replace the "One constant, two sides" bullet's "sidebar list id" wording with "the folder title's `selectPanel` target"; add: "**Settings namespaces allow hyphens, storage units allow underscores** — hence `buddy-telegram` vs `buddy_telegram`"; "**The settings plane only describes registered namespaces**: the legacy migration sees `telegram` only while dsh-telegram is mounted"; "**Every string the Telegram bot sends is English** (`test/telegram/english-copy.test.ts`)".
- Merge in the dsh-telegram `AGENTS.md` points not already present: the bot token belongs to the credentials plane, and only `describe()` posture may reach settings, logs or the browser.
- Update `npm run test` note: tests live in `test/*.test.ts` and `test/telegram/*.test.ts`; `test/support/` holds the browser harness.

- [ ] **Step 2: Update `README.md`**

Mirror the architecture changes in the row table (add `dsh-buddy/telegram`, update the browser-half row), remove "Telegram" from the "later phases" sentence, and add a short "Telegram" section: configured in the Buddy main panel's Telegram module; the bot token is shared with dsh-telegram; Buddy will not poll while dsh-telegram is still installed and enabled.

- [ ] **Step 3: Correct the spec's cutover order**

In the spec's §8.2 replace steps 1–3 with:

```markdown
1. 合并到 `master`，重启 `dsh-web`。此时 dsh-telegram 仍挂载：`buddy-telegram` 因占用保护不轮询，但设置迁移在此时完成（settings 平面只能描述已注册的命名空间，dsh-telegram 卸载后就读不到旧节）。
2. 确认 `~/.dsh/settings.yaml` 出现 `buddy-telegram` 节，`ownerUserId` 已迁移、`enabled: false`；Telegram 模块显示占用提示。
3. `dsh plugin --profile web remove dsh-telegram`，重启 `dsh-web`。
```

and renumber the remaining steps. In §4.1 add: "迁移只在 dsh-telegram 仍挂载时可见旧节；若首次启动时已卸载，迁移结果为 `no-legacy`，在 Telegram 模块手动填写 owner 即可。" In §6.2 replace "客户端建会话请求能否携带模型在计划中核实；不能则改走新端点 `buddyPersona/createSession`" with "客户端经 `remote.session.create({ cwd, agentPreset })` 建会话，再以 `remote.session.selectModel` 应用模型；工作目录来自 `buddyPersona/preferences.conversationCwd`（`~/buddy-workspace`）". Replace the §6.2 endpoint list's `buddyPersona/model` / `updateModel` / `modelCatalog` line with `buddyPersona/preferences` / `buddyPersona/updatePreferences`; the catalog comes from `remote.session.modelCatalog()`.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md docs/superpowers/specs/2026-09-12-buddy-telegram-design.md
git commit -m "docs: phase 6 architecture, invariants and corrected cutover order"
```

---

### Task 15: Probe verification (isolated, no real bot)

Nothing here touches `~/.dsh` or the live instance. Record every observation in the task report.

**Files:** none committed (scratch files live under the session scratchpad `$S`).

- [ ] **Step 1: Build and create the probe home**

```bash
npm run check
S=<session scratchpad directory>
T=$S/probe-p6; rm -rf "$T"; mkdir -p "$T/profiles/web"
cd ~/.dsh/profiles/web && cp cordis.yml cordis.patch.yml package.json pnpm-workspace.yaml "$T/profiles/web/"
ln -s ~/.dsh/profiles/web/node_modules "$T/profiles/web/node_modules"
cat > "$T/settings.yaml" <<'EOF'
telegram:
  enabled: false
  ownerUserId: "42"
  defaultCwd: ~/probe-telegram
EOF
date '+%Y-%m-%d %H:%M:%S' > "$T/start"
```

`telegram.enabled: false` in the probe: dsh-telegram must not poll the real token from the probe. The probe's `DSH_HOME` has no credentials file, so neither row can resolve a token anyway — confirm with `ls "$T"` that no `.credentials.yaml` exists before starting.

- [ ] **Step 2: Start the probe**

Run in background: `DSH_HOME=$T ~/.npm-global/bin/dsh --profile web --no-open --port 3099 > $T/log 2>&1`
Wait until `$T/log` contains `token=`.

- [ ] **Step 3: Host checks**

Exchange the token for a cookie (`curl -c $T/jar -L "<url>"`) and POST client-request envelopes (`{"type":"client-request","rpcId":"x","method":"<ns>/<method>","payload":{"args":{}}}`) to `http://127.0.0.1:3099/api/<ns>/<method>`:

1. `buddyPersona/preferences` → `panel.sections` all true, `conversationCwd` ends with `buddy-workspace`.
2. `buddyTelegram/config` → `ownerUserId: "42"`, `defaultCwd: "~/probe-telegram"`, `enabled: false` (migration ran).
3. `grep -A6 '^buddy-telegram:' $T/settings.yaml` shows the migrated section; `grep -A4 '^telegram:' $T/settings.yaml` is unchanged from Step 1.
4. `buddyTelegram/status` → `state: "off"`, `token.configured: false`.
5. Set `telegram.enabled: true` via `telegram/updateConfig` (`{"patch":{"enabled":true}}`) → then `buddyTelegram/status` → `state: "error"`, `detail` = the occupancy message. (dsh-telegram still has no token in the probe, so it cannot poll.) Set it back to `false`.

- [ ] **Step 4: Browser checks with headless Chromium**

Use the CDP driver pattern from this repo's previous verification (headless shell at `~/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell`, `--remote-debugging-port`, `Runtime.evaluate`, `Page.captureScreenshot`) against the probe URL:

1. After dismissing the notice: a button with `aria-label="Buddy"` exists in the sidebar foot, above the Settings button (compare `getBoundingClientRect().top`), and no Buddy entry exists under New Session.
2. Click it → the main panel shows cards titled Soul, Agents, Model, Telegram and a "New Buddy conversation" button; the Telegram card shows "Stopped"/"off" status.
3. Open Settings → Buddy: four checkboxes and the files path, no textareas. Uncheck Telegram → back on the main panel, the Telegram card is gone. Re-check it.
4. Click "New Buddy conversation" (the probe has no model provider key; creation must still succeed). Then `sessionQuery` via `buddyPersona/sessions` lists one session with `source: "web"`; expanding the folder shows it; its session header (`~/.dsh`-relative under `$T/sessions`) has `agentPreset: "buddy"` and `cwd` ending in `buddy-workspace`.
5. Console: no `error`/`exception` entries mentioning buddy.
6. Save screenshots of steps 1–3 to `$T/`.

If step 4's create fails because the harness requires a workspace, record the exact error and stop: that is a design gap to bring back to the user, not something to patch around.

- [ ] **Step 5: Stop the probe and check isolation**

Stop the probe process (find it with `ss -ltnp | grep :3099`, kill that PID). Then:

```bash
find ~/.dsh -newermt "$(cat $T/start)" -not -path '*/node_modules*'
```

Expected: no output. `~/buddy-workspace` may now exist (the probe's `HOME` is the real home) — note it in the report; it is an empty directory.

---

### Task 16: Cutover on the live instance — **requires the user's explicit go-ahead in chat**

Do not start this task on the strength of the plan. Ask the user, show them the Task 15 report, and wait for a yes.

- [ ] **Step 1: Merge into the checkout the live instance loads, then restart**

The live `dsh-web.service` loads `dsh-buddy` through `~/.dsh/profiles/web/node_modules/dsh-buddy`, a symlink to `/home/panda-nuc/repo/dsh-buddy` — the `master` checkout, not this worktree. Merging inside this worktree (`/home/panda-nuc/repo/dsh-buddy-phase6`) never reaches the live instance, and `lib/` is gitignored, so even a merge in the right checkout with no build leaves the old artifacts in place. Do the merge, install and build in the checkout the symlink actually points at:

```bash
cd /home/panda-nuc/repo/dsh-buddy && git merge --ff-only feat/phase-6-telegram
npm install && npm run check
systemctl --user restart dsh-web.service
```

Run the restart immediately after `npm run check` finishes, back to back — not as a separate later step. `npm run check` builds `lib/client.js`, and the browser half hot-reloads on a build while the host half does not: a gap between build and restart is a window where the already-reloaded browser calls `buddyTelegram/*` endpoints the still-running old host process does not serve.

Only remove the `/home/panda-nuc/repo/dsh-buddy-phase6` worktree after the merge above has completed — it is `feat/phase-6-telegram`'s only checkout until `master` has it.

- [ ] **Step 2: Verify with dsh-telegram still installed**

Wait for the `dsh web:` line in `journalctl --user -u dsh-web.service --since <restart time>`.

Verify (cookie + client-request envelope as in Task 15):
- `buddyTelegram/config` → `ownerUserId: "1000000000"`, `enabled: false`.
- `buddyTelegram/status` → `state: "error"` with the occupancy detail: the guard runs on every `sync`, before the enable check, and dsh-telegram's `telegram.enabled` is `true` here.
- `telegram/status` (dsh-telegram) → still `running`.

- [ ] **Step 3: Remove dsh-telegram**

```bash
cd ~/.dsh/profiles/web && ~/.npm-global/bin/dsh plugin --profile web remove dsh-telegram
grep -n telegram ~/.dsh/profiles/web/package.json ~/.dsh/profiles/web/cordis.patch.yml
```

Expected: `dsh-telegram` no longer in `dependencies` or `dsh.profile.bundles`. If a hand-written `dsh-telegram` row remains in `cordis.patch.yml`, show it to the user before removing it.

Restart `dsh-web.service` again and verify `buddyTelegram/status` → `state: "off"` (no occupancy detail) and `telegram/status` → gateway error (endpoint gone).

- [ ] **Step 4: Enable and hand over to the user**

Tell the user to open the Buddy main panel → Telegram and switch it on (or, on their go-ahead, call `buddyTelegram/updateConfig` with `{"patch":{"enabled":true}}`). Verify `buddyTelegram/status` → `state: "running"`, `botUsername: "example_dev_bot"`.

Ask the user to test from their phone and report back:
1. `/help` → the English help text from Task 6.
2. A plain message → a reply in Buddy's voice; the conversation appears in the sidebar folder with the Telegram badge.
3. One approval prompt (e.g. ask Buddy to create a file) → English buttons work.
4. Send a file → saved under `downloads/` in the working directory.

- [ ] **Step 5: Isolation check**

```bash
git -C ~/repo/dsh-plugins/dsh-telegram status --short
```

Expected: identical to before this plan (only its pre-existing `lib/` and `package-lock.json` modifications).

Unlike the Task 15 probe (an isolated `DSH_HOME`, cleaned up as it goes), this cutover runs against the real `~/.dsh` and is expected to leave real, permanent changes there. Confirm exactly these and nothing wider:
- `~/.dsh/settings.yaml`: new `buddy` and `buddy-telegram` sections (the latter migrated from the legacy `telegram` section per Step 2).
- `~/.dsh/storages/buddy_telegram*`: the Telegram row's own storage domain, created on first boot after the merge.
- `~/.dsh/storages/workspace.json`: new entries for the `buddy-workspace` workspace and, once a Telegram chat has run at least one turn, its `cwd`-derived workspace.
- `~/buddy-workspace`: created on disk the first time a buddy conversation (web or Telegram) needs a default working directory.

Rollback, if anything above fails: switch Buddy's Telegram off, `dsh plugin --profile web add dsh-telegram@link:/home/panda-nuc/repo/dsh-plugins/dsh-telegram`, restart. dsh-telegram resumes with its untouched `telegram` settings, token and chat bindings.
