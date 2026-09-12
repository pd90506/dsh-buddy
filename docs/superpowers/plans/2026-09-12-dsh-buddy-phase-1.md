# dsh-buddy Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a walking skeleton of dsh-buddy: a left-sidebar button above Settings that takes over the centre panel with a working buddy conversation list, a Settings tab that edits a persona, and that persona genuinely reaching the model in buddy sessions only.

**Architecture:** One repo, multiple cordis plugin rows, one bundle. Two host rows (`dsh-buddy/store` publishes `ctx.buddyStore`; `dsh-buddy/persona` publishes `ctx.buddyPersona`, registers the `buddy_soul` prompt variable, and serves typert endpoints) plus one browser half declared through `dsh.client`, plus a `buddy` agent preset that references `{{buddy_soul}}` through the shipped `@deepseek-ai/dsh-persona` row. Human/agent-authored content lives in plain files under the buddy home; derived state lives in the `buddy` storage domain.

**Tech Stack:** TypeScript compiled away by esbuild (DSH transforms nothing), `@deepseek-ai/cordis`, `@deepseek-ai/dsh-storage-domain`, `@deepseek-ai/dsh-home-paths`, `@deepseek-ai/schemastery`, React 19 (external), `node:test` + `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-09-12-dsh-buddy-design.md`

## Global Constraints

- **Never use `#` private fields in a class registered as a Cordis service.** Cordis hands services out as traceable proxies and dispatches endpoints with `Reflect.apply(method, proxy, args)`; a `#` field's brand is bound to the instance and is unreachable through any proxy. Use TypeScript `private`. Tests holding the raw instance will not catch this — `test/gateway.test.ts` dispatches through the proxy specifically to catch it.
- **Never read a soft-dependency service as a property.** Use `ctx.get('name')` and handle `undefined`. Cordis's Guard throws `cannot get property "x" without inject` on a bare property read of any service not declared in `inject`. `inject` is only for hard dependencies.
- **Registration is effect.** Every contribution goes through `ctx.effect()`, `ctx.on()`, or a `register()` that returns a disposer. Never `removeListener`/`clearInterval` by hand.
- **DSH transforms nothing.** TypeScript and JSX must be gone by the time artifacts land. Host halves are ESM with every `@deepseek-ai/*` left external (module identity matters for typert and storage-domain specs). The browser half is CJS wrapped in the `window.__ModuleLoader__.load({ id, factory })` factory with React external.
- **Endpoints register through `ctx.typert.register(...)` at runtime, never `@Remote` decorators.** Decorators write markers into the module-private table of whichever `dsh-typert-protocol` copy attached them; an out-of-tree plugin's nested copy is not the API gateway's.
- **A preset row may not publish a service** without an `isolate` realm. All services in this plan are host-plane. The `buddy` preset contributes only prompt sections and tools.
- **Never edit the shipped preset install.** `standard`, `minimal`, `ptc`, `cordis` under `@deepseek-ai/dsh-agent-presets/presets/` are read-only. Authored presets go to `~/.dsh/.agent-presets/<id>/`.
- **Do not serialize live data.** Services, Sessions, Slots and their derivatives are never `JSON.stringify`d or deep-copied. Read only the leaf fields needed and build a small owned object.
- Settings namespace: `buddy` (lowercase). Storage domain name: `buddy` (lowercase, per `UNIT_NAME_RE`).
- Prompt variable name: `buddy_soul`. Main panel key and sidebar list id: both exactly `dsh-buddy`.
- Node target `node22`; browser target `es2022`.

> **Prompt variable name corrected in Task 11.** This plan, the spec, and eight
> completed tasks originally pinned this value as the camelCase pairing of
> `buddy` and a capitalized `Soul`, no separator. Real-harness boot in Task 11
> failed there: `dsh-system-prompt`'s own `variable()` guard rejects any name
> that does not match `VARIABLE_NAME = /^[a-z][a-z0-9_]*$/`
> (`dsh-system-prompt/lib/index.js:58,295-296`), and camelCase fails that
> regex. The value is `buddy_soul`; every occurrence below has been updated to
> match, including the suggested commit message in Task 6's own instructions.
> That does not rewrite the real Task 6 commit already in git history — it
> still carries the old camelCase spelling verbatim in its message, since git
> history is immutable and this rename only touches working-tree content and
> documentation going forward.

---

## File Structure

```
dsh-buddy/
├── package.json            # exports subpaths per row; dsh.bundle.patch + dsh.client
├── tsconfig.json
├── build.mjs               # esbuild: 4 entries (index, store, persona, client)
├── cordis.patch.yml        # inserts the two host rows
├── assets/
│   └── preset/             # validated buddy preset template, shipped and installed on first load
│       ├── agent.cordis.yml
│       └── preset.yml
├── src/
│   ├── index.ts            # shared constants only — NO apply(); not a plugin
│   ├── paths.ts            # buddy home + file path resolution (pure)
│   ├── config.ts           # settings schema, namespace `buddy`
│   ├── store/
│   │   ├── domain.ts       # domain spec + openStore (already-open fallback)
│   │   ├── preset.ts       # install the preset template, never overwriting
│   │   └── index.ts        # ROW dsh-buddy/store — publishes ctx.buddyStore
│   ├── persona/
│   │   ├── soul.ts         # SOUL.md / AGENTS.md read+write, default baseline
│   │   ├── gateway.ts      # typert endpoints buddy/*
│   │   └── index.ts        # ROW dsh-buddy/persona — publishes ctx.buddyPersona
│   └── client/
│       ├── index.tsx       # browser half: registers all three slots
│       ├── panel.tsx       # BuddyPanel — conversation list
│       └── settings.tsx    # BuddySettingsSection — persona editor
└── test/
    ├── paths.test.ts
    ├── config.test.ts
    ├── domain.test.ts
    ├── soul.test.ts
    ├── gateway.test.ts        # dispatches through the service proxy
    ├── mount.test.ts          # real cordis context, both rows
    ├── preset-install.test.ts # never overwrites a user's preset
    └── client-ui.test.ts      # asserts on the built browser bundle
```

**Responsibility boundaries.** `paths.ts` and `config.ts` are pure and depend on nothing. `store/` owns durable derived state and knows nothing about personas. `persona/` owns file content and the prompt variable, and consumes `buddyStore` for its paths. `client/` never touches the host directly — only `rpc.call('/api', 'buddy/…')` and the client services.

---

## Task 1: Repo scaffold, build pipeline, and path resolution

**Files:**
- Create: `package.json`, `tsconfig.json`, `build.mjs`, `src/index.ts`, `src/paths.ts`
- Test: `test/paths.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `BUDDY_DOMAIN_NAME = 'buddy'`, `SETTINGS_NAMESPACE = 'buddy'`, `SOUL_VARIABLE = 'buddy_soul'`, `MAIN_PANEL_KEY = 'dsh-buddy'` (from `src/index.ts`)
  - `interface BuddyPaths { readonly home: string; readonly soul: string; readonly agents: string }`
  - `resolveBuddyPaths(configuredHome: string): BuddyPaths`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "dsh-buddy",
  "version": "0.1.0",
  "private": true,
  "description": "DSH plugin: a persistent personal assistant with persona, memory and a dedicated main panel",
  "type": "module",
  "license": "MIT",
  "main": "lib/index.js",
  "exports": {
    ".": { "default": "./lib/index.js" },
    "./store": { "default": "./lib/store.js" },
    "./persona": { "default": "./lib/persona.js" },
    "./client": { "default": "./lib/client.js" },
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "files": ["lib", "src", "cordis.patch.yml"],
  "scripts": {
    "build": "node build.mjs",
    "prepare": "node build.mjs",
    "pretest": "node build.mjs",
    "typecheck": "tsc",
    "test": "node --test test/*.test.ts",
    "check": "npm run typecheck && npm run build && npm test"
  },
  "keywords": ["dsh", "dsh-plugin", "deepseek-harness", "assistant"],
  "engines": { "node": "^22.19.0 || >=24.0.0" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-connection",
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-api-session-controller",
        "@deepseek-ai/dsh-client-ui-renderer",
        "@deepseek-ai/dsh-client-ui-settings",
        "@deepseek-ai/dsh-client-ui-sidebar",
        "@deepseek-ai/dsh-client-ui-layout"
      ]
    }
  },
  "dependencies": {
    "zod": "^4.4.3"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.2",
    "@deepseek-ai/schemastery": "^3.18.2",
    "@deepseek-ai/dsh-home-paths": ">=0.1.0-rc.8 <0.2.0",
    "@deepseek-ai/dsh-session": ">=0.1.0-rc.8 <0.2.0",
    "@deepseek-ai/dsh-session-query": ">=0.1.0-rc.8 <0.2.0",
    "@deepseek-ai/dsh-settings": ">=0.1.0-rc.8 <0.2.0",
    "@deepseek-ai/dsh-storage-domain": ">=0.1.0-rc.8 <0.2.0",
    "@deepseek-ai/dsh-system-prompt": ">=0.1.0-rc.8 <0.2.0",
    "@deepseek-ai/dsh-typert-protocol": ">=0.1.0-rc.8 <0.2.0"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "^4.0.2",
    "@deepseek-ai/schemastery": "^3.18.2",
    "@deepseek-ai/dsh-home-paths": "^0.1.5-rc.1",
    "@deepseek-ai/dsh-session": "^0.1.5-rc.1",
    "@deepseek-ai/dsh-session-query": "^0.1.5-rc.1",
    "@deepseek-ai/dsh-settings": "^0.1.5-rc.1",
    "@deepseek-ai/dsh-storage-domain": "^0.1.5-rc.1",
    "@deepseek-ai/dsh-system-prompt": "^0.1.5-rc.1",
    "@deepseek-ai/dsh-typert-protocol": "^0.1.5-rc.1",
    "@types/node": "^22.20.2",
    "@types/react": "^19.3.0",
    "esbuild": "^0.25.0",
    "react": "^19.3.0",
    "typescript": "^5.9.3"
  }
}
```

> **Manifest corrections (applied 2026-09-12, after `dsh-plugin-dev check`).** Four fields differ from this plan's original draft; the reasons, so nobody reverts them:
> - `@deepseek-ai/schemastery` moved from `dependencies` to `peerDependencies` (and into `devDependencies` for the local build). `@deepseek-ai/dsh-settings` declares it a peer itself, and `Config` is a schemastery instance handed across that boundary — a second nested copy is the "cordis 双副本" hazard. Both planes are duck-typed (`schema.toJSON()`, `safeParse`; no `instanceof`), so today it would merely drift, not crash. `zod` stays a plain dependency: `dsh-storage-domain` declares zod as a dependency, not a peer.
> - Harness peer ranges widened from `^0.1.5-rc.1` to `>=0.1.0-rc.8 <0.2.0`. Semver's prerelease rule means `^0.1.5-rc.1` matches `0.1.5-rc.2` but **not** `0.1.6-rc.1`, and the harness ships on an rc cadence.
> - `engines.node` added as `^22.19.0 || >=24.0.0` — the harness's own supported range (`references/official-docs/AGENTS.md`), not merely `>=22`.
> - `main` added as `lib/index.js` (no `./` prefix — the checker's `files` matcher compares literally). The rows still resolve through `exports`; this is only the fallback for a resolver that ignores `exports`.
>
> Two `dsh-plugin-dev check` findings are **deliberately not fixed**: `readme-five-langs` (five-language READMEs are that toolkit's own publishing convention; this plugin is `private`) and `packageManager` (it wants pnpm pinned; this repo is npm-managed with a `package-lock.json`).

> **`dsh.client.inject` corrected in Task 8.** This list as originally drafted named two packages that do not exist in the DSH install — `@deepseek-ai/dsh-client-runtime` and `@deepseek-ai/dsh-client-ui-slots` — and omitted the packages that actually declare two of the services the browser half injects. The list is a bundle **arrival-order** declaration (`@deepseek-ai/dsh-client-modules/lib/client.js:265-268` walks it and *silently ignores* any entry absent from the graph), not a per-service provider contract, which is why a phantom entry never produced a symptom and why the shipped `dsh-telegram` carries the same dead `dsh-client-runtime` entry to this day. `ctx.slots` is declared by `dsh-client-ui-renderer`, `ctx.sessions` by `dsh-api-session-controller`. `test/client-ui.test.ts` now pins every injected service to its declaring package with no exemptions.

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "jsx": "react-jsx",
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["node"],
    "lib": ["ES2022", "DOM"]
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "test/**/*.ts"]
}
```

- [ ] **Step 3: Create `build.mjs`**

```js
/**
 * Build every half.
 *
 * Host rows are bundled to `lib/<row>.js` as ESM with every `@deepseek-ai/*`
 * dependency left external, so the plugin shares the harness's own copies of the
 * settings, storage and typert services rather than loading a second one —
 * module identity is load-bearing for the typert registry and the domain spec.
 *
 * The browser half is bundled to `lib/client.js` in dsh's `__ModuleLoader__`
 * factory format: a CJS body wrapped in a factory whose `require` resolves
 * platform seeds (`react`, `react/jsx-runtime`).
 *
 * DSH transforms nothing it loads, so TypeScript and JSX must both be gone by
 * the time the artifacts land.
 */
import { build } from "esbuild";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { dependencies = {}, peerDependencies = {} } = require("./package.json");

/** Runtime deps stay external so the harness supplies one shared copy. */
const hostExternal = [...Object.keys(dependencies), ...Object.keys(peerDependencies), "node:*"];

/**
 * Host entries. Each row is its own artifact so a profile can disable one
 * without loading the other. Tasks 3 and 6 append to this list as the rows
 * are written; it is deliberately explicit rather than a directory scan, so a
 * mistyped path fails the build instead of silently producing no artifact.
 */
const hostEntries = [["src/index.ts", "lib/index.js"]];

for (const [entry, outfile] of hostEntries) {
	await build({
		entryPoints: [entry],
		outfile,
		bundle: true,
		format: "esm",
		platform: "node",
		target: "node22",
		external: hostExternal,
		logLevel: "info",
	});
}
```

The browser build is added in Task 7, when `src/client/index.tsx` first exists.

- [ ] **Step 4: Create `src/index.ts` (shared constants, deliberately not a plugin)**

```ts
/**
 * Names shared by both halves and by the agent preset.
 *
 * This module exports no `apply`, so it cannot be mounted as a cordis row by
 * mistake — the rows are `dsh-buddy/store` and `dsh-buddy/persona`.
 * @module dsh-buddy
 */

/** Storage domain name. Lowercase, per the domain grammar's `UNIT_NAME_RE`. */
export const BUDDY_DOMAIN_NAME = "buddy";

/** Settings namespace. Lowercase, per the settings grammar. */
export const SETTINGS_NAMESPACE = "buddy";

/**
 * The prompt variable the `buddy` agent preset interpolates.
 *
 * The preset's persona row carries the literal text `{{buddy_soul}}`; this host
 * plugin registers the variable that fills it. Substituted values are NOT
 * scanned again by the renderer, so SOUL.md may contain `{{` freely.
 */
export const SOUL_VARIABLE = "buddy_soul";

/**
 * The main-panel key AND the sidebar panel-list id.
 *
 * These must be the same string: the sidebar addresses the main panel by its
 * own list id, and `ctx.layout.selectPanel` throws on a key the main slot
 * never registered.
 */
export const MAIN_PANEL_KEY = "dsh-buddy";

/** The agent preset id whose sessions this plugin treats as buddy conversations. */
export const BUDDY_PRESET_ID = "buddy";
```

- [ ] **Step 5: Write the failing test `test/paths.test.ts`**

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveBuddyPaths } from "../src/paths.ts";

test("an empty configured home falls back to the harness home", () => {
	const paths = resolveBuddyPaths("");
	assert.equal(paths.home.endsWith(join("buddy")), true, "default home must sit under the harness home");
	assert.equal(paths.soul, join(paths.home, "SOUL.md"));
	assert.equal(paths.agents, join(paths.home, "AGENTS.md"));
});

test("a whitespace-only configured home is treated as unset", () => {
	assert.equal(resolveBuddyPaths("   ").home, resolveBuddyPaths("").home);
});

test("a tilde-prefixed configured home expands against the OS home", () => {
	const paths = resolveBuddyPaths("~/buddy-test");
	assert.equal(paths.home, join(homedir(), "buddy-test"));
});

test("a relative configured home resolves to an absolute path", () => {
	const paths = resolveBuddyPaths("./rel-buddy");
	assert.equal(paths.home.startsWith("/") || /^[A-Za-z]:/.test(paths.home), true);
});

test("an absolute configured home is kept verbatim", () => {
	const paths = resolveBuddyPaths("/tmp/buddy-abs");
	assert.equal(paths.home, "/tmp/buddy-abs");
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `node --test test/paths.test.ts` (Node 22+ strips TypeScript types natively; every test file in this plan is plain `.ts` and imports no JSX, precisely so this works).
Expected: FAIL with `Cannot find module '../src/paths.ts'`.

- [ ] **Step 7: Write `src/paths.ts`**

```ts
/**
 * Where buddy's human-and-agent-authored files live.
 *
 * Content a person or the agent writes — the persona, the rules, later the
 * memory files — belongs on disk as plain Markdown, not in the storage domain:
 * self-evolution edits these with ordinary file tools, and files stay
 * greppable, diffable and backup-able. Derived machine state goes to the
 * `buddy` domain instead (see `store/domain.ts`).
 *
 * The harness home is never hardcoded. `dshHomePath` applies the deployment's
 * own precedence (explicit configuration, then `$DSH_HOME`, then `~/.dsh`).
 * @module dsh-buddy/paths
 */
import { isAbsolute, join, resolve } from "node:path";
import { dshHomePath, expandHomePath } from "@deepseek-ai/dsh-home-paths";

/** Absolute locations of buddy's authored files. */
export interface BuddyPaths {
	/** The buddy home directory itself. */
	readonly home: string;
	/** Persona: voice, attitude, opinions. */
	readonly soul: string;
	/** Operating rules, kept separate from voice on purpose. */
	readonly agents: string;
}

/**
 * Resolve the buddy home and the files inside it.
 *
 * @param configuredHome - the `buddy.home` setting; empty or whitespace means
 * "use the harness home", which is the documented default.
 * @returns absolute paths; the directory is not created here (see `ensureBuddyHome`).
 */
export function resolveBuddyPaths(configuredHome: string): BuddyPaths {
	const raw = configuredHome.trim();
	const home = raw === "" ? dshHomePath("buddy") : absolute(expandHomePath(raw));
	return { home, soul: join(home, "SOUL.md"), agents: join(home, "AGENTS.md") };
}

/**
 * Force an absolute path, because a relative buddy home would follow the
 * process working directory and silently move between launches.
 * @param path - an expanded path that may still be relative.
 * @returns the absolute form.
 */
function absolute(path: string): string {
	return isAbsolute(path) ? path : resolve(path);
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm run typecheck && node --test test/paths.test.ts`
Expected: 5 passing, typecheck clean.

- [ ] **Step 9: Verify the build produces the constants artifact**

Run: `npm run build && ls lib/`
Expected: exactly `index.js`. The other three artifacts appear as Tasks 3, 6 and 7 add their entries.

- [ ] **Step 10: Commit**

```bash
git add package.json tsconfig.json build.mjs src/index.ts src/paths.ts test/paths.test.ts
git commit -m "feat: scaffold dsh-buddy and resolve the buddy home"
```

---

## Task 2: Settings schema

**Files:**
- Create: `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: `SETTINGS_NAMESPACE` from `src/index.ts`.
- Produces:
  - `interface BuddyConfig { home: string }`
  - `Config: z<Partial<BuddyConfig>, BuddyConfig>`
  - `FALLBACK_CONFIG: BuddyConfig`

- [ ] **Step 1: Write the failing test `test/config.test.ts`**

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { Config, FALLBACK_CONFIG } from "../src/config.ts";

test("a silent document produces the documented defaults", () => {
	const resolved = Config({});
	assert.equal(resolved.home, "");
});

test("the fallback matches the schema defaults", () => {
	assert.deepEqual({ ...FALLBACK_CONFIG }, { ...Config({}) });
});

test("an explicit home survives resolution", () => {
	assert.equal(Config({ home: "~/elsewhere" }).home, "~/elsewhere");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/config.test.ts`
Expected: FAIL with `Cannot find module '../src/config.ts'`.

- [ ] **Step 3: Write `src/config.ts`**

```ts
/**
 * The `buddy` settings section.
 *
 * Only non-secret, user-tunable values live here (`ctx.settings`, landing in
 * `~/.dsh/settings.yaml`). Authored prose goes to files under the buddy home,
 * and derived state goes to the storage domain — neither belongs in settings.
 *
 * Nothing tunable may be hardcoded elsewhere: if a value should be changeable
 * from `cordis.yml` or the settings document, it gets a field here.
 * @module dsh-buddy/config
 */
import z from "@deepseek-ai/schemastery";
import { SETTINGS_NAMESPACE } from "./index.ts";

export { SETTINGS_NAMESPACE };

/** Shape of the `buddy` settings section. */
export interface BuddyConfig {
	/**
	 * Buddy home directory. Empty means the harness home's `buddy/`, which is
	 * what almost every deployment wants; a `~` prefix is expanded.
	 */
	home: string;
}

/** Defaults used before the settings section resolves. */
export const FALLBACK_CONFIG: BuddyConfig = { home: "" };

/**
 * The settings schema; defaults apply when the user document is silent.
 *
 * Two type arguments, not one: schemastery declares `Schemastery<S = any, T = S>`
 * (S = input, T = output), so the conventional `z<BuddyConfig>` would make every
 * field required on input and turn `Config({})` into a type error. The two-arg
 * form states what the schema actually does — a partial document in, a complete
 * config out. Collapsing it back breaks `test/config.test.ts`.
 */
export const Config: z<Partial<BuddyConfig>, BuddyConfig> = z.object({
	home: z
		.string()
		.default("")
		.description("Buddy home directory holding SOUL.md and AGENTS.md; empty means <harness home>/buddy"),
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run typecheck && node --test test/config.test.ts`
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat: add the buddy settings schema"
```

---

## Task 3: `dsh-buddy/store` row

**Files:**
- Create: `src/store/domain.ts`, `src/store/index.ts`, `cordis.patch.yml`
- Modify: `build.mjs` (restore the `src/store/index.ts` entry if Task 1 Step 9 removed it)
- Test: `test/domain.test.ts`

**Interfaces:**
- Consumes: `BuddyPaths`/`resolveBuddyPaths` (Task 1), `BuddyConfig`/`Config`/`FALLBACK_CONFIG`/`SETTINGS_NAMESPACE` (Task 2), `BUDDY_DOMAIN_NAME` (Task 1).
- Produces:
  - `interface BuddyGlobal { lastPersonaWriteAt?: string }`
  - `interface BuddyDomainHandle { readonly global: DomainGlobal<BuddyGlobal>; close(): Promise<void> }`
  - `openStore(ctx: StoreContext): Promise<BuddyDomainHandle>`
  - `class BuddyStore extends Service` published as `ctx.buddyStore`, with:
    - `readonly paths: BuddyPaths`
    - `lastPersonaWriteAt(): string | undefined`
    - `markPersonaWritten(at: string): Promise<void>`

- [ ] **Step 1: Write the failing test `test/domain.test.ts`**

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { BUDDY_DOMAIN_NAME, buddyDomainSpec, openStore } from "../src/store/domain.ts";

/** A minimal live domain stand-in matching the accessors openStore uses. */
function domainStub(): unknown {
	let global: Record<string, unknown> = {};
	return {
		name: BUDDY_DOMAIN_NAME,
		global: {
			get: () => global,
			set: async (next: Record<string, unknown>) => {
				global = next;
			},
		},
		close: async () => undefined,
	};
}

test("the domain spec is named and versioned", () => {
	assert.equal(BUDDY_DOMAIN_NAME, "buddy");
	assert.equal(buddyDomainSpec.name, "buddy");
	assert.equal(buddyDomainSpec.version, 1);
});

test("a missing storageDomain facility fails loudly", async () => {
	await assert.rejects(() => openStore({ get: () => undefined }), /storageDomain/);
});

test("opening the domain returns its accessors", async () => {
	const handle = await openStore({ get: () => ({ open: async () => domainStub(), get: () => undefined }) });
	assert.equal(typeof handle.global.get, "function");
	await handle.close();
});

test("an already-open domain is adopted instead of failing (hot reload)", async () => {
	const live = domainStub();
	const facility = {
		open: async () => {
			throw Object.assign(new Error("already open"), { code: "already-open" });
		},
		get: (name: string) => (name === BUDDY_DOMAIN_NAME ? live : undefined),
	};
	const handle = await openStore({ get: () => facility });
	assert.equal(typeof handle.global.get, "function");
});

test("an open failure that is not already-open propagates", async () => {
	const facility = {
		open: async () => {
			throw Object.assign(new Error("invalid record"), { code: "invalid-record" });
		},
		get: () => undefined,
	};
	await assert.rejects(() => openStore({ get: () => facility }), /invalid record/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/domain.test.ts`
Expected: FAIL with `Cannot find module '../src/store/domain.ts'`.

- [ ] **Step 3: Write `src/store/domain.ts`**

```ts
/**
 * Buddy's durable *derived* state, in the harness's own storage plane.
 *
 * Authored prose is not here — it is on disk under the buddy home. What lives
 * in the domain is state nothing else can reconstruct: for Phase 1 that is the
 * timestamp of the last persona write, which the settings tab reports and which
 * is neither a setting nor file content.
 *
 * One domain name exists per process and opening an already-open name rejects,
 * so {@link openStore} adopts the live handle instead of failing: after a hot
 * reload the previous fiber may not have closed yet.
 * @module dsh-buddy/store/domain
 */
import { z } from "zod";
import { defineDomain } from "@deepseek-ai/dsh-storage-domain";
import type { Domain, DomainGlobal } from "@deepseek-ai/dsh-storage-domain";
import { BUDDY_DOMAIN_NAME } from "../index.ts";

export { BUDDY_DOMAIN_NAME };

/** Domain-wide singletons. */
export const globalSchema = z.object({
	/** ISO-8601 timestamp of the last successful persona write. */
	lastPersonaWriteAt: z.string().optional(),
});

/** Stored shape of the domain global. */
export type BuddyGlobal = z.infer<typeof globalSchema>;

/** The domain declaration: identity, version, and the global schema. */
export const buddyDomainSpec = defineDomain({
	name: BUDDY_DOMAIN_NAME,
	version: 1,
	global: { schema: globalSchema, initial: {} },
	tables: {},
});

/** An opened domain plus the accessors the rest of the plugin uses. */
export interface BuddyDomainHandle {
	/** Domain-wide singletons. */
	readonly global: DomainGlobal<BuddyGlobal>;
	/** Release the backend unit. Called from the owning `ctx.effect`. */
	close(): Promise<void>;
}

/** The slice of `ctx` this module needs. */
export interface StoreContext {
	get(name: string): unknown;
}

/**
 * Open (or adopt) the `buddy` domain.
 *
 * @param ctx - the plugin fiber's context.
 * @returns the opened domain's accessors.
 * @throws when the storage facility is not mounted, or the stored data fails
 * its schema — schema drift is a real failure and must not be silently swallowed.
 */
export async function openStore(ctx: StoreContext): Promise<BuddyDomainHandle> {
	const facility = ctx.get("storageDomain") as
		| {
				open(spec: typeof buddyDomainSpec): Promise<Domain<typeof buddyDomainSpec>>;
				get(name: string): unknown;
		  }
		| undefined;
	if (facility === undefined) {
		throw new Error("dsh-buddy: the storageDomain service is unavailable (load @deepseek-ai/dsh-storage-domain)");
	}
	let domain: Domain<typeof buddyDomainSpec>;
	try {
		domain = await facility.open(buddyDomainSpec);
	} catch (error) {
		if ((error as { code?: string }).code !== "already-open") throw error;
		// Another fiber (a hot-reloaded earlier instance) still holds the name.
		// Sharing its handle is correct: it is the same on-disk unit.
		domain = facility.get(BUDDY_DOMAIN_NAME) as Domain<typeof buddyDomainSpec>;
	}
	return {
		global: domain.global,
		close: async (): Promise<void> => {
			await domain.close();
		},
	};
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run typecheck && node --test test/domain.test.ts`
Expected: 5 passing.

- [ ] **Step 5: Write `src/store/index.ts` (the row)**

```ts
/**
 * Host row `dsh-buddy/store`: the foundation both other halves stand on.
 *
 * It resolves the buddy home, guarantees the directory exists, opens the
 * `buddy` storage domain, and publishes `ctx.buddyStore`. Every other buddy row
 * declares `buddyStore` as a hard dependency, so cordis holds them in waiting
 * until this one is ready and unloads them again if it goes away.
 *
 * `storageDomain` is the only hard dependency here. `settings` is read through a
 * scoped injection so the row still mounts in a profile without the settings
 * plane — it simply uses the documented defaults there.
 * @module dsh-buddy/store
 */
import { mkdir } from "node:fs/promises";
import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import { Config, FALLBACK_CONFIG, SETTINGS_NAMESPACE, type BuddyConfig } from "../config.ts";
import { resolveBuddyPaths, type BuddyPaths } from "../paths.ts";
import { openStore, type BuddyDomainHandle } from "./domain.ts";

/** Cordis plugin name used by loader diagnostics. */
export const name = "dsh-buddy-store";

/** Hard dependency: without storage there is nowhere to keep derived state. */
export const inject = ["storageDomain"];

/**
 * The `buddyStore` service.
 *
 * Fields are TypeScript-`private`, never `#`-private: cordis hands this service
 * out as a traceable proxy and dispatches through `Reflect.apply`, which
 * substitutes a shadow receiver for `this`. A `#` field is bound to the instance
 * object itself and is unreachable through any proxy.
 */
export class BuddyStore extends Service {
	/** Absolute locations of buddy's authored files. */
	public readonly paths: BuddyPaths;

	private readonly handle: BuddyDomainHandle;

	/**
	 * @param ctx - the plugin fiber's context; the service registers immediately.
	 * @param paths - resolved buddy file locations.
	 * @param handle - the opened `buddy` domain.
	 */
	constructor(ctx: Context, paths: BuddyPaths, handle: BuddyDomainHandle) {
		super(ctx, "buddyStore");
		this.paths = paths;
		this.handle = handle;
	}

	/**
	 * When the persona was last written.
	 * @returns an ISO-8601 timestamp, or `undefined` if it never has been.
	 */
	lastPersonaWriteAt(): string | undefined {
		return this.handle.global.get().lastPersonaWriteAt;
	}

	/**
	 * Record a successful persona write.
	 * @param at - ISO-8601 timestamp of the write.
	 */
	async markPersonaWritten(at: string): Promise<void> {
		await this.handle.global.set({ ...this.handle.global.get(), lastPersonaWriteAt: at });
	}
}

/** The context members this row uses. */
interface PluginContext {
	get(name: string): unknown;
	effect(effect: () => (() => void) | void, label?: string): void;
	inject(services: string[], callback: (scoped: PluginContext) => void): void;
	settings?: {
		installSection(
			owner: unknown,
			ns: string,
			schema: unknown,
			entry: unknown,
			hooks: { setSource(current: () => BuddyConfig): void; onChange(): void },
		): void;
	};
}

/**
 * Resolve configuration, open storage, and publish the service.
 * @param ctx - the plugin fiber's context.
 */
export function apply(ctx: PluginContext): void {
	let readConfig: () => BuddyConfig = () => FALLBACK_CONFIG;

	// Scoped injection so the row still mounts without the settings plane.
	ctx.inject(["settings"], (scoped) => {
		scoped.settings?.installSection(ctx, SETTINGS_NAMESPACE, Config, {}, {
			setSource: (source) => {
				readConfig = source;
			},
			// Phase 1 reads `home` once at boot: moving the home under a live
			// plugin would strand the open domain and the editor's file handles.
			// A change takes effect on the next start, which the settings tab says.
			onChange: () => undefined,
		});
	});

	ctx.effect(() => {
		let handle: BuddyDomainHandle | undefined;
		void (async (): Promise<void> => {
			handle = await openStore(ctx);
			const paths = resolveBuddyPaths(readConfig().home);
			await mkdir(paths.home, { recursive: true });
			new BuddyStore(ctx as unknown as Context, paths, handle);
		})().catch((error: unknown) => {
			// A store that cannot open is fatal for every dependent row, and
			// cordis keeps them waiting rather than half-mounting them. Surfacing
			// the reason is the only way a user can act on it.
			console.error(`dsh-buddy-store: boot failed: ${(error as Error).message}`);
		});
		return () => {
			void handle?.close().catch(() => undefined);
		};
	}, "dsh-buddy: store");
}
```

- [ ] **Step 6: Create `cordis.patch.yml`**

```yaml
# dsh-buddy bundle layer, appended to the profile's bundle stack by
# `dsh plugin --profile <name> add` (via the package's dsh.bundle.patch
# declaration).
#
# Two host rows, deliberately separate: the store owns the buddy home and the
# `buddy` storage domain, and the persona row stands on it. Each row has its own
# effect scope, so a failure in one does not take the other down, and either can
# be turned off from a profile's own cordis.patch.yml without touching code:
#
#   - id: buddy-persona
#     disabled: true
#
# The browser half is not a row here: it reaches the boot graph through the
# package's `dsh.client` declaration.
#
# Nothing here does anything on its own. With no SOUL.md written, the plugin
# mounts, registers its settings section and its endpoints, and idles.
- insert:
    - id: buddy-store
      name: 'dsh-buddy/store'
      config: {}
    - id: buddy-persona
      name: 'dsh-buddy/persona'
      config: {}
```

- [ ] **Step 7: Add the store entry to `build.mjs` and build**

Change the `hostEntries` list to:

```js
const hostEntries = [
	["src/index.ts", "lib/index.js"],
	["src/store/index.ts", "lib/store.js"],
];
```

Run: `npm run typecheck && npm run build && ls lib/`
Expected: `index.js  store.js`; no TypeScript errors.

- [ ] **Step 8: Commit**

```bash
git add src/store/ cordis.patch.yml build.mjs test/domain.test.ts
git commit -m "feat: add the buddy-store row and the buddy storage domain"
```

---

## Task 4: Persona file IO

**Files:**
- Create: `src/persona/soul.ts`
- Test: `test/soul.test.ts`

**Interfaces:**
- Consumes: `BuddyPaths` (Task 1).
- Produces:
  - `DEFAULT_SOUL: string`
  - `interface PersonaDocument { readonly soul: string; readonly agents: string }`
  - `readPersona(paths: BuddyPaths): Promise<PersonaDocument>`
  - `writePersona(paths: BuddyPaths, next: Partial<PersonaDocument>): Promise<PersonaDocument>`
  - `soulForPrompt(document: PersonaDocument): string`

- [ ] **Step 1: Write the failing test `test/soul.test.ts`**

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SOUL, readPersona, soulForPrompt, writePersona } from "../src/persona/soul.ts";
import type { BuddyPaths } from "../src/paths.ts";

/** A real temporary buddy home, because this module's whole job is file IO. */
async function paths(): Promise<BuddyPaths> {
	const home = await mkdtemp(join(tmpdir(), "dsh-buddy-"));
	return { home, soul: join(home, "SOUL.md"), agents: join(home, "AGENTS.md") };
}

test("an absent SOUL.md reads as the default persona, never empty", async () => {
	const document = await readPersona(await paths());
	assert.equal(document.soul, DEFAULT_SOUL);
	assert.equal(document.agents, "");
});

test("a written persona round-trips", async () => {
	const p = await paths();
	await writePersona(p, { soul: "You are terse.", agents: "Never guess." });
	const document = await readPersona(p);
	assert.equal(document.soul, "You are terse.");
	assert.equal(document.agents, "Never guess.");
	assert.equal(await readFile(p.soul, "utf8"), "You are terse.");
});

test("a partial write leaves the other file alone", async () => {
	const p = await paths();
	await writePersona(p, { soul: "A", agents: "B" });
	await writePersona(p, { soul: "C" });
	const document = await readPersona(p);
	assert.equal(document.soul, "C");
	assert.equal(document.agents, "B");
});

test("an unreadable SOUL.md degrades to the default instead of throwing", async () => {
	const p = await paths();
	// A directory where the file should be: readFile fails with EISDIR.
	await writePersona(p, { agents: "" });
	const { mkdir } = await import("node:fs/promises");
	await mkdir(p.soul, { recursive: true });
	const document = await readPersona(p);
	assert.equal(document.soul, DEFAULT_SOUL);
});

test("prompt text is never empty, so the persona row never shadows itself away", async () => {
	assert.notEqual(soulForPrompt({ soul: "", agents: "" }).trim(), "");
	assert.equal(soulForPrompt({ soul: "Voice.", agents: "" }), "Voice.");
});

test("rules are appended under their own heading when present", async () => {
	const text = soulForPrompt({ soul: "Voice.", agents: "Rule one." });
	assert.equal(text.includes("Voice."), true);
	assert.equal(text.includes("Rule one."), true);
	assert.equal(text.indexOf("Voice.") < text.indexOf("Rule one."), true);
});

test("a persona containing template braces is carried verbatim", async () => {
	const p = await paths();
	await writePersona(p, { soul: "Literal {{notAVariable}} stays." });
	const document = await readPersona(p);
	assert.equal(document.soul, "Literal {{notAVariable}} stays.");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/soul.test.ts`
Expected: FAIL with `Cannot find module '../src/persona/soul.ts'`.

- [ ] **Step 3: Write `src/persona/soul.ts`**

```ts
/**
 * Reading and writing buddy's authored persona.
 *
 * Two files, deliberately separate — the split both reference products
 * converged on independently:
 *
 * - `SOUL.md` is voice, attitude and opinions;
 * - `AGENTS.md` is operating rules.
 *
 * Everything here degrades rather than throws on read. A damaged or missing
 * persona must not be able to stop a session from starting; the worst outcome
 * is the default voice, which is always non-empty for the reason in
 * {@link soulForPrompt}.
 * @module dsh-buddy/persona/soul
 */
import { readFile, writeFile } from "node:fs/promises";
import type { BuddyPaths } from "../paths.ts";

/**
 * The voice a freshly installed buddy speaks in.
 *
 * This is never the empty string. The preset's persona row renders the prompt
 * variable as its `prefix`, and an empty prefix shadows the deployment persona
 * away without putting anything in its place — a session with no identity at all.
 */
export const DEFAULT_SOUL =
	"You are Buddy, a personal assistant running inside the user's own harness. " +
	"You are direct, concrete, and allergic to filler. You remember that you are a " +
	"guest on this machine: you say what you are about to do before you do it.";

/** The authored persona as two independent documents. */
export interface PersonaDocument {
	/** Voice, attitude, opinions. Falls back to {@link DEFAULT_SOUL}. */
	readonly soul: string;
	/** Operating rules. Empty when the user has written none. */
	readonly agents: string;
}

/**
 * Read one file, treating every failure as absence.
 * @param path - the file to read.
 * @param fallback - what an unreadable or missing file means.
 * @returns the file's text, or the fallback.
 */
async function readOr(path: string, fallback: string): Promise<string> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return fallback;
	}
}

/**
 * Read the authored persona.
 * @param paths - resolved buddy file locations.
 * @returns the persona, with the default voice when none is written.
 */
export async function readPersona(paths: BuddyPaths): Promise<PersonaDocument> {
	const [soul, agents] = await Promise.all([readOr(paths.soul, DEFAULT_SOUL), readOr(paths.agents, "")]);
	return { soul, agents };
}

/**
 * Write the parts of the persona the caller supplied.
 *
 * A partial write must not blank the other file: the settings tab edits the two
 * independently, and an omitted field means "unchanged", not "empty".
 * @param paths - resolved buddy file locations.
 * @param next - the fields to change.
 * @returns the persona as it reads after the write.
 */
export async function writePersona(paths: BuddyPaths, next: Partial<PersonaDocument>): Promise<PersonaDocument> {
	if (next.soul !== undefined) await writeFile(paths.soul, next.soul, "utf8");
	if (next.agents !== undefined) await writeFile(paths.agents, next.agents, "utf8");
	return await readPersona(paths);
}

/**
 * Render the persona as the single block the prompt variable carries.
 *
 * The renderer does not scan substituted values again, so this text may contain
 * `{{` freely — a persona the agent itself will later edit must never be able to
 * break prompt assembly.
 * @param document - the authored persona.
 * @returns non-empty prompt text.
 */
export function soulForPrompt(document: PersonaDocument): string {
	const voice = document.soul.trim() === "" ? DEFAULT_SOUL : document.soul.trim();
	const rules = document.agents.trim();
	return rules === "" ? voice : `${voice}\n\n## Operating rules\n\n${rules}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run typecheck && node --test test/soul.test.ts`
Expected: 7 passing.

- [ ] **Step 5: Commit**

```bash
git add src/persona/soul.ts test/soul.test.ts
git commit -m "feat: read and write the buddy persona files"
```

---

## Task 5: Persona typert gateway

**Files:**
- Create: `src/persona/gateway.ts`
- Test: `test/gateway.test.ts`

**Interfaces:**
- Consumes: `PersonaDocument` (Task 4).
- Produces:
  - `BUDDY_SERVICE = 'buddyPersona'`
  - `interface BuddySessionSummary { readonly sessionId: string; readonly title: string; readonly updatedAt: number; readonly cwd: string }`
  - `interface PersonaView { readonly soul: string; readonly agents: string; readonly home: string; readonly lastWriteAt?: string }`
  - `class BuddyPersonaGateway extends TypertRemoteService` with `persona(): Promise<PersonaView>`, `updatePersona(patch: Record<string, unknown>): Promise<PersonaView>`, `sessions(): Promise<BuddySessionSummary[]>`
  - `interface GatewayDeps { readPersona(): Promise<PersonaView>; writePersona(patch: Partial<PersonaDocument>): Promise<PersonaView>; listSessions(): Promise<BuddySessionSummary[]> }`

- [ ] **Step 1: Write the failing test `test/gateway.test.ts`**

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { BuddyPersonaGateway, BUDDY_SERVICE, type GatewayDeps, type PersonaView } from "../src/persona/gateway.ts";

const VIEW: PersonaView = { soul: "Voice.", agents: "", home: "/tmp/buddy" };

/** Deps that record what reached them. */
function deps(): GatewayDeps & { patches: Partial<{ soul: string; agents: string }>[] } {
	const patches: Partial<{ soul: string; agents: string }>[] = [];
	return {
		patches,
		readPersona: async () => VIEW,
		writePersona: async (patch) => {
			patches.push(patch);
			return VIEW;
		},
		listSessions: async () => [{ sessionId: "s1", title: "First", updatedAt: 1, cwd: "/tmp" }],
	};
}

/** A context stub exposing only what the gateway reads. */
function ctxStub(registered: unknown[]): unknown {
	return { get: (n: string) => (n === "typert" ? { register: (c: unknown) => registered.push(c) } : undefined) };
}

/**
 * Dispatch the way the api-gateway does: applied with a *proxy* as `this`.
 * A `#` private field in the service would pass a direct call and fail here.
 */
function dispatch(service: object, method: string, args: unknown[]): unknown {
	const proxy = new Proxy(service, {});
	const found = (proxy as Record<string, unknown>)[method];
	assert.equal(typeof found, "function", `${method} must be callable`);
	return Reflect.apply(found as (...a: unknown[]) => unknown, proxy, args);
}

test("constructing the gateway registers the typert contribution", () => {
	const registered: unknown[] = [];
	new BuddyPersonaGateway(ctxStub(registered) as never, deps());
	assert.equal(registered.length, 1);
});

test("a missing typert registry fails loudly", () => {
	assert.throws(() => new BuddyPersonaGateway({ get: () => undefined } as never, deps()), /typert/);
});

test("every endpoint survives proxy dispatch (no # private fields)", async () => {
	const gateway = new BuddyPersonaGateway(ctxStub([]) as never, deps());
	assert.deepEqual(await dispatch(gateway, "persona", []), VIEW);
	assert.deepEqual(await dispatch(gateway, "sessions", []), [
		{ sessionId: "s1", title: "First", updatedAt: 1, cwd: "/tmp" },
	]);
	assert.deepEqual(await dispatch(gateway, "updatePersona", [{ soul: "New." }]), VIEW);
});

test("updatePersona accepts only known string fields", async () => {
	const d = deps();
	const gateway = new BuddyPersonaGateway(ctxStub([]) as never, d);
	await dispatch(gateway, "updatePersona", [{ soul: "A", agents: "B", evil: "C", n: 5 }]);
	assert.deepEqual(d.patches, [{ soul: "A", agents: "B" }]);
});

test("an empty patch performs no write", async () => {
	const d = deps();
	const gateway = new BuddyPersonaGateway(ctxStub([]) as never, d);
	await dispatch(gateway, "updatePersona", [{ nothing: true }]);
	assert.deepEqual(d.patches, []);
});

test("the service name is the typert namespace", () => {
	assert.equal(BUDDY_SERVICE, "buddyPersona");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/gateway.test.ts`
Expected: FAIL with `Cannot find module '../src/persona/gateway.ts'`.

- [ ] **Step 3: Write `src/persona/gateway.ts`**

```ts
/**
 * The host endpoints backing the dsh-buddy panel and settings tab.
 *
 * Endpoints are registered through the shared `typert` registry at runtime
 * rather than with `@Remote` decorators. Decorators write their markers into a
 * module-private table of whichever `dsh-typert-protocol` copy attached them,
 * and an out-of-tree plugin's nested copy is not the API gateway's — while
 * `ctx.typert.register` is an ordinary service call, immune to module identity.
 * @module dsh-buddy/persona/gateway
 */
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import type { PersonaDocument } from "./soul.ts";

/** Cordis service key; also the typert wire namespace. */
export const BUDDY_SERVICE = "buddyPersona";

/** Package identity for the strict typert contribution. */
const TYPERT_PACKAGE = "dsh-buddy";

/** One buddy conversation as the panel lists it. Owned data, never a live Session. */
export interface BuddySessionSummary {
	/** The session to open when the row is clicked. */
	readonly sessionId: string;
	/** Resolved title, or a placeholder when the session has none yet. */
	readonly title: string;
	/** Unix epoch milliseconds of the latest title event, for ordering. */
	readonly updatedAt: number;
	/** Working directory the session was created in; empty when it has none. */
	readonly cwd: string;
}

/** What the settings tab renders and edits. */
export interface PersonaView {
	/** Voice, attitude, opinions. */
	readonly soul: string;
	/** Operating rules. */
	readonly agents: string;
	/** Absolute buddy home, shown so the user can find the files. */
	readonly home: string;
	/** ISO-8601 timestamp of the last write, when there has been one. */
	readonly lastWriteAt?: string | undefined;
}

/** The contribution that puts `buddyPersona/*` on the wire. */
function typertContribution(): unknown {
	const shared = {
		namespace: BUDDY_SERVICE,
		service: BUDDY_SERVICE,
		invocation: { kind: "direct" },
		result: { mode: "src-json" },
	};
	const json = { source: "json", codec: { mode: "src-json" } } as const;
	return {
		package: TYPERT_PACKAGE,
		face: "host",
		schemas: [],
		invocations: [
			{ ...shared, id: `${TYPERT_PACKAGE}#persona`, method: "persona", parameters: [] },
			{ ...shared, id: `${TYPERT_PACKAGE}#sessions`, method: "sessions", parameters: [] },
			{
				...shared,
				id: `${TYPERT_PACKAGE}#updatePersona`,
				method: "updatePersona",
				parameters: [{ name: "patch", wire: "patch", ...json }],
			},
		],
	};
}

/** The context slice this service needs. */
export interface GatewayContext {
	get(name: string): unknown;
}

/** Host-side collaborators. */
export interface GatewayDeps {
	/** The persona as it currently reads. */
	readonly readPersona: () => Promise<PersonaView>;
	/** Apply a partial persona write. */
	readonly writePersona: (patch: Partial<PersonaDocument>) => Promise<PersonaView>;
	/** Buddy conversations, newest first. */
	readonly listSessions: () => Promise<BuddySessionSummary[]>;
}

/** Backs `buddyPersona/persona`, `buddyPersona/updatePersona`, `buddyPersona/sessions`. */
export class BuddyPersonaGateway extends TypertRemoteService {
	/**
	 * TypeScript-`private`, deliberately not `#`-private — see the Global
	 * Constraints. `test/gateway.test.ts` dispatches through a proxy to pin it.
	 */
	private readonly deps: GatewayDeps;

	/**
	 * @param ctx - the plugin fiber's context.
	 * @param deps - persona and session accessors.
	 */
	constructor(ctx: GatewayContext, deps: GatewayDeps) {
		super(ctx as never, BUDDY_SERVICE);
		this.deps = deps;
		const typert = ctx.get("typert") as { register(contribution: unknown): void } | undefined;
		if (typert === undefined) throw new Error("dsh-buddy: the typert registry service is unavailable");
		typert.register(typertContribution());
	}

	/**
	 * The persona the settings tab edits.
	 * @returns the current persona view.
	 */
	async persona(): Promise<PersonaView> {
		return await this.deps.readPersona();
	}

	/**
	 * Buddy conversations for the main panel's list.
	 * @returns owned summaries, newest first.
	 */
	async sessions(): Promise<BuddySessionSummary[]> {
		return await this.deps.listSessions();
	}

	/**
	 * Write the persona.
	 *
	 * Only known string fields are accepted, so a malformed client cannot write
	 * arbitrary files or blank a document by sending the wrong type.
	 * @param patch - the fields to change.
	 * @returns the persona after the write.
	 */
	async updatePersona(patch: Record<string, unknown>): Promise<PersonaView> {
		const clean: Partial<PersonaDocument> = {};
		if (typeof patch["soul"] === "string") clean.soul = patch["soul"];
		if (typeof patch["agents"] === "string") clean.agents = patch["agents"];
		if (Object.keys(clean).length === 0) return await this.deps.readPersona();
		return await this.deps.writePersona(clean);
	}
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run typecheck && node --test test/gateway.test.ts`
Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add src/persona/gateway.ts test/gateway.test.ts
git commit -m "feat: add the buddy persona typert endpoints"
```

---

## Task 6: `dsh-buddy/persona` row and the `buddy_soul` prompt variable

**Files:**
- Create: `src/persona/index.ts`
- Test: `test/mount.test.ts`

**Interfaces:**
- Consumes: `BuddyStore` (Task 3), `readPersona`/`writePersona`/`soulForPrompt` (Task 4), `BuddyPersonaGateway`/`GatewayDeps`/`BuddySessionSummary` (Task 5), `SOUL_VARIABLE`/`BUDDY_PRESET_ID` (Task 1).
- Produces: the mounted row. No new exported types beyond `name`, `inject`, `apply`.

- [ ] **Step 1: Write the failing test `test/mount.test.ts`**

```ts
/**
 * The mount test: both rows inside a real cordis app.
 *
 * A hand-written stub has no cordis rules — reading a service as a plain
 * property works there and throws in production. Here the services belong to
 * *sibling* fibers, which is what arms cordis's inject Guard.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import * as storeRow from "../src/store/index.ts";
import * as personaRow from "../src/persona/index.ts";
import { SOUL_VARIABLE } from "../src/index.ts";
import { DEFAULT_SOUL } from "../src/persona/soul.ts";

/** What the test observes from outside the plugins. */
interface Mounted {
	readonly persona: Record<string, (...args: unknown[]) => unknown>;
	readonly variables: Map<string, (context: unknown) => string | undefined>;
	readonly sections: string[];
}

/** Let asynchronous boot settle. */
async function settle(): Promise<void> {
	for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Mount both rows beside sibling service plugins on a real context. */
async function mount(): Promise<Mounted> {
	const home = await mkdtemp(join(tmpdir(), "dsh-buddy-mount-"));
	const root = new Context();
	const sections: string[] = [];
	const variables = new Map<string, (context: unknown) => string | undefined>();
	let global: Record<string, unknown> = {};

	const sibling = (pluginName: string, provide: (ctx: unknown) => void): void => {
		(root as unknown as { plugin(plugin: unknown): unknown }).plugin({
			name: pluginName,
			apply: (ctx: unknown) => provide(ctx),
		});
	};
	const give = (ctx: unknown, key: string, value: unknown): void => {
		(ctx as { reflect: { provide(name: string, value: unknown): void } }).reflect.provide(key, value);
	};

	sibling("fake-typert", (ctx) => give(ctx, "typert", { register: () => undefined }));
	sibling("fake-storage", (ctx) =>
		give(ctx, "storageDomain", {
			open: async () => ({
				name: "buddy",
				global: {
					get: () => global,
					set: async (next: Record<string, unknown>) => {
						global = next;
					},
				},
				close: async () => undefined,
			}),
			get: () => undefined,
		}),
	);
	sibling("fake-settings", (ctx) =>
		give(ctx, "settings", {
			installSection: (
				_o: unknown,
				ns: string,
				_s: unknown,
				_e: unknown,
				hooks: { setSource(source: () => { home: string }): void },
			) => {
				sections.push(ns);
				hooks.setSource(() => ({ home }));
			},
		}),
	);
	sibling("fake-system-prompt", (ctx) =>
		give(ctx, "systemPrompt", {
			variable: (varName: string, provider: (context: unknown) => string | undefined) => {
				variables.set(varName, provider);
				return () => variables.delete(varName);
			},
		}),
	);
	sibling("fake-session-query", (ctx) => give(ctx, "sessionQuery", { listSessions: async () => [] }));

	// Spread rather than passing the module namespace: namespace objects are
	// sealed, and cordis annotates the plugin object it is handed.
	const mountRow = (row: { name: string; inject: string[]; apply: (ctx: never) => void }): void => {
		(root as unknown as { plugin(p: unknown): unknown }).plugin({
			name: row.name,
			inject: row.inject,
			apply: row.apply,
		});
	};
	mountRow(storeRow as never);
	mountRow(personaRow as never);
	await settle();
	return {
		persona: root.get("buddyPersona") as unknown as Record<string, (...args: unknown[]) => unknown>,
		variables,
		sections,
	};
}

test("both rows mount and publish their services", async () => {
	const { persona } = await mount();
	assert.notEqual(persona, undefined, "the persona row must publish buddyPersona");
	for (const method of ["persona", "updatePersona", "sessions"]) {
		assert.equal(typeof persona[method], "function", `${method} must be callable through the service`);
	}
});

test("the store installs its settings section", async () => {
	const { sections } = await mount();
	assert.deepEqual(sections, ["buddy"]);
});

test("the buddy_soul prompt variable is registered and never returns undefined", async () => {
	const { variables } = await mount();
	const provider = variables.get(SOUL_VARIABLE);
	assert.notEqual(provider, undefined, "the persona row must register the prompt variable");
	assert.equal(provider?.({}), DEFAULT_SOUL);
});

test("the variable reflects a persona write without a remount", async () => {
	const { persona, variables } = await mount();
	await Reflect.apply(persona["updatePersona"] as never, persona, [{ soul: "Terse." }]);
	assert.equal(variables.get(SOUL_VARIABLE)?.({}), "Terse.");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/mount.test.ts`
Expected: FAIL with `Cannot find module '../src/persona/index.ts'`.

- [ ] **Step 3: Write `src/persona/index.ts`**

```ts
/**
 * Host row `dsh-buddy/persona`.
 *
 * It does three things: keeps the authored persona in memory so prompt assembly
 * never touches the disk, registers the `buddy_soul` prompt variable the `buddy`
 * agent preset interpolates, and serves the endpoints behind the panel and the
 * settings tab.
 *
 * The persona reaches the model only through the preset. This row registers a
 * *variable*, not a section: a variable is inert until some section references
 * it, and only the `buddy` preset's persona row does. That is what keeps the
 * persona out of ordinary coding sessions.
 * @module dsh-buddy/persona
 */
import { BUDDY_PRESET_ID, SOUL_VARIABLE } from "../index.ts";
import { readPersona, soulForPrompt, writePersona, type PersonaDocument } from "./soul.ts";
import { BuddyPersonaGateway, type BuddySessionSummary, type PersonaView } from "./gateway.ts";
import type { BuddyPaths } from "../paths.ts";

/** Cordis plugin name used by loader diagnostics. */
export const name = "dsh-buddy-persona";

/** Hard dependencies: the buddy home comes from the store, the wire from typert. */
export const inject = ["buddyStore", "typert"];

/** The context members this row uses. */
interface PluginContext {
	get(name: string): unknown;
	effect(effect: () => (() => void) | void, label?: string): void;
	buddyStore: { paths: BuddyPaths; lastPersonaWriteAt(): string | undefined; markPersonaWritten(at: string): Promise<void> };
}

/** The subset of `ctx.sessionQuery` this row reads. */
interface SessionQuery {
	listSessions(signal?: AbortSignal): Promise<
		{ header: { id: string; cwd?: string; agentPreset?: string } }[]
	>;
	readTitle?(sessionId: string, signal?: AbortSignal): Promise<{ title: string; updatedAt: number } | undefined>;
}

/**
 * Register the prompt variable, the endpoints, and the in-memory persona.
 * @param ctx - the plugin fiber's context.
 */
export function apply(ctx: PluginContext): void {
	// `buddyStore` is a declared hard dependency, so a plain property read is
	// correct here — the Guard only rejects undeclared services.
	const paths = ctx.buddyStore.paths;

	// The persona is held in memory and refreshed on write. Prompt assembly runs
	// on every model step and must never wait on the filesystem; a snapshot also
	// keeps one turn's identity stable while the user edits the file underneath.
	let document: PersonaDocument = { soul: "", agents: "" };

	const view = (): PersonaView => ({
		soul: document.soul,
		agents: document.agents,
		home: paths.home,
		lastWriteAt: ctx.buddyStore.lastPersonaWriteAt(),
	});

	const listSessions = async (): Promise<BuddySessionSummary[]> => {
		const query = ctx.get("sessionQuery") as SessionQuery | undefined;
		if (query === undefined) return [];
		const records = await query.listSessions();
		const mine = records.filter((record) => record.header.agentPreset === BUDDY_PRESET_ID);
		const summaries = await Promise.all(
			mine.map(async (record): Promise<BuddySessionSummary> => {
				// Only leaf fields are read and a fresh object is built: session
				// records are live harness data and are never serialized wholesale.
				const title = await query.readTitle?.(record.header.id).catch(() => undefined);
				return {
					sessionId: record.header.id,
					title: title?.title ?? "",
					updatedAt: title?.updatedAt ?? 0,
					cwd: record.header.cwd ?? "",
				};
			}),
		);
		return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
	};

	new BuddyPersonaGateway(ctx, {
		readPersona: async () => view(),
		writePersona: async (patch) => {
			document = await writePersona(paths, patch);
			await ctx.buddyStore.markPersonaWritten(new Date().toISOString());
			return view();
		},
		listSessions,
	});

	// A variable rather than a section: inert until the buddy preset's persona
	// row references `{{buddy_soul}}`. The renderer does not re-scan substituted
	// values, so a persona containing `{{` is carried through safely.
	ctx.effect(() => {
		const prompt = ctx.get("systemPrompt") as
			| { variable(name: string, provider: (context: unknown) => string | undefined): () => void }
			| undefined;
		if (prompt === undefined) return undefined;
		// Never `undefined`: the renderer throws on a referenced variable with no
		// value for the assembly, which would break every buddy session.
		return prompt.variable(SOUL_VARIABLE, () => soulForPrompt(document));
	}, "dsh-buddy: soul prompt variable");

	ctx.effect(() => {
		void readPersona(paths)
			.then((loaded) => {
				document = loaded;
			})
			.catch(() => undefined);
		return undefined;
	}, "dsh-buddy: persona load");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run typecheck && node --test test/mount.test.ts`
Expected: 4 passing.

- [ ] **Step 5: Add the persona entry to `build.mjs` and run the whole suite**

Change the `hostEntries` list to:

```js
const hostEntries = [
	["src/index.ts", "lib/index.js"],
	["src/store/index.ts", "lib/store.js"],
	["src/persona/index.ts", "lib/persona.js"],
];
```

Run: `npm run check && ls lib/`
Expected: `index.js  persona.js  store.js`; typecheck clean; all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/persona/index.ts test/mount.test.ts build.mjs
git commit -m "feat: add the buddy-persona row and the buddy_soul prompt variable"
```

---

## Task 7: Browser half — settings tab

**Files:**
- Create: `src/client/settings.tsx`, `src/client/index.tsx`
- Test: `test/client-ui.test.ts`

**Interfaces:**
- Consumes: `MAIN_PANEL_KEY`, `SETTINGS_NAMESPACE` (Task 1); endpoints `buddyPersona/persona`, `buddyPersona/updatePersona` (Task 5).
- Produces:
  - `createBuddySettingsSection(deps: SettingsDeps): () => unknown`
  - `interface SettingsDeps { call(endpoint: string, args: unknown): Promise<unknown>; t(key: string): string }`
  - from `src/client/index.tsx`: `inject: string[]`, `apply(ctx: any): void`

- [ ] **Step 1: Write the failing test `test/client-ui.test.ts`**

The assertion runs against the **built** `lib/client.js`, not the source. Node's
type stripping does not handle JSX, so no test in this plan may import a `.tsx`
file; asserting on the bundle also proves the browser half actually compiles.
`npm test` runs `pretest`, which builds, so the artifact is present.

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { MAIN_PANEL_KEY } from "../src/index.ts";

/** The built browser bundle. */
async function bundle(): Promise<string> {
	return await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
}

test("the browser half is wrapped in the module-loader factory", async () => {
	assert.match(await bundle(), /^window\.__ModuleLoader__\.load\(\{/);
});

test("the settings section is registered", async () => {
	assert.match(await bundle(), /settings\.section/);
});

test("the shared panel key is the one the sidebar and main slot both use", async () => {
	assert.equal(MAIN_PANEL_KEY, "dsh-buddy");
	assert.match(await bundle(), /dsh-buddy/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/client-ui.test.ts`
Expected: FAIL — `lib/client.js` does not exist yet (`ENOENT`).

- [ ] **Step 3: Write `src/client/settings.tsx`**

```tsx
/**
 * The **Buddy** tab in the Settings left nav.
 *
 * It edits two files through this plugin's own `buddyPersona/*` endpoints:
 * SOUL.md (voice) and AGENTS.md (rules). Nothing secret passes through here, so
 * there is no credentials traffic — the persona is ordinary authored prose.
 * @module dsh-buddy/client/settings
 */
import { useCallback, useEffect, useState } from "react";

/** What the tab renders; mirrors the host's `PersonaView`. */
interface PersonaView {
	soul: string;
	agents: string;
	home: string;
	lastWriteAt?: string;
}

/** Collaborators supplied by the plugin's `apply`. */
export interface SettingsDeps {
	/** Unwrapped RPC: resolves the endpoint's payload or throws. */
	call(endpoint: string, args: unknown): Promise<unknown>;
	/** Locale lookup bound to this plugin's namespace. */
	t(key: string): string;
}

const styles = {
	page: { display: "flex", flexDirection: "column", gap: 20, padding: "4px 2px" },
	block: { display: "flex", flexDirection: "column", gap: 8 },
	label: { fontSize: 13, fontWeight: 600 },
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
 * Build the settings section component.
 * @param deps - RPC and locale collaborators.
 * @returns the component the slot renders.
 */
export function createBuddySettingsSection(deps: SettingsDeps): () => unknown {
	return function BuddySettingsSection(): unknown {
		const [view, setView] = useState<PersonaView | undefined>(undefined);
		const [soul, setSoul] = useState("");
		const [agents, setAgents] = useState("");
		const [busy, setBusy] = useState(false);
		const [error, setError] = useState<string | undefined>(undefined);

		const load = useCallback(async (): Promise<void> => {
			try {
				const next = (await deps.call("buddyPersona/persona", {})) as PersonaView;
				setView(next);
				setSoul(next.soul);
				setAgents(next.agents);
				setError(undefined);
			} catch (cause) {
				setError((cause as Error).message);
			}
		}, []);

		useEffect(() => {
			void load();
		}, [load]);

		const save = async (): Promise<void> => {
			setBusy(true);
			try {
				const next = (await deps.call("buddyPersona/updatePersona", { patch: { soul, agents } })) as PersonaView;
				setView(next);
				setError(undefined);
			} catch (cause) {
				setError((cause as Error).message);
			} finally {
				setBusy(false);
			}
		};

		return (
			<div style={styles.page}>
				<section style={styles.block}>
					<div style={styles.label}>{deps.t("soulTitle")}</div>
					<p style={styles.hint}>{deps.t("soulHint")}</p>
					<textarea
						style={styles.area}
						value={soul}
						onChange={(event: { target: { value: string } }) => setSoul(event.target.value)}
					/>
				</section>

				<section style={styles.block}>
					<div style={styles.label}>{deps.t("rulesTitle")}</div>
					<p style={styles.hint}>{deps.t("rulesHint")}</p>
					<textarea
						style={styles.area}
						value={agents}
						onChange={(event: { target: { value: string } }) => setAgents(event.target.value)}
					/>
				</section>

				<div style={styles.row}>
					<button style={styles.button} type="button" disabled={busy} onClick={() => void save()}>
						{deps.t("save")}
					</button>
					{view !== undefined && <span style={styles.hint}>{`${deps.t("homeLabel")} ${view.home}`}</span>}
				</div>
				{error !== undefined && <p style={styles.error}>{error}</p>}
			</div>
		);
	};
}
```

- [ ] **Step 4: Write `src/client/index.tsx` (settings registration only for now)**

```tsx
/**
 * Browser half of dsh-buddy.
 *
 * Three registrations, and the first two are a pair that must not be split:
 * `sidebar.panellist` contributes the button, `main` contributes the panel it
 * selects, and the sidebar addresses the panel by the button's own list id. A
 * button without a panel throws on click, so both are registered here or neither is.
 * @module dsh-buddy/client
 */
import { MAIN_PANEL_KEY } from "../index.ts";
import { createBuddySettingsSection } from "./settings.tsx";

/** Dictionary namespace owned by this plugin. */
const NS = "settings.buddy";

/** Section id in the settings left nav. */
const SECTION_ID = "buddy";

/** Nav position: after Telegram (26), before Plugin Market (40). */
const SECTION_ORDER = 27;

/**
 * Required services (cordis fiber inject).
 *
 * `connection` carries the RPC caller for this plugin's own `buddyPersona/*`
 * endpoints; `layout` selects the main panel; `sessions` opens a conversation.
 */
export const inject = ["slots", "locale", "connection", "layout", "sessions"];

const en = {
	nav: "Buddy",
	soulTitle: "Persona",
	soulHint: "Voice, attitude and opinions. Saved to SOUL.md and used by buddy sessions only.",
	rulesTitle: "Operating rules",
	rulesHint: "Rules the assistant follows. Saved to AGENTS.md, kept separate from voice on purpose.",
	save: "Save",
	homeLabel: "Files:",
	panelTitle: "Buddy",
	conversations: "Conversations",
	empty: "No buddy conversations yet. Start one with the buddy agent preset.",
	untitled: "Untitled",
	refresh: "Refresh",
};

const zh: typeof en = {
	nav: "Buddy",
	soulTitle: "人格",
	soulHint: "声音、态度与观点。保存到 SOUL.md，仅对 buddy 会话生效。",
	rulesTitle: "行为规则",
	rulesHint: "助理遵循的规则。保存到 AGENTS.md，与人格刻意分开。",
	save: "保存",
	homeLabel: "文件位置：",
	panelTitle: "Buddy",
	conversations: "对话",
	empty: "还没有 buddy 对话。用 buddy agent preset 新建一个。",
	untitled: "未命名",
	refresh: "刷新",
};

/**
 * Mount the browser half.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: any): void {
	const { rpc } = ctx.get("connection");
	const t = ctx.locale.bind(NS);
	ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-buddy: dictionaries");

	// rpc.call resolves with the gateway's { ok, value | error } envelope —
	// unwrap it here so the rest of the UI deals in payloads only, instead of
	// silently treating a failure as a success.
	const call = async (endpoint: string, args: unknown): Promise<any> => {
		const result = await rpc.call("/api", endpoint, { args });
		if (result?.ok !== true) {
			const error = result?.error;
			throw new Error(
				error?.message !== undefined ? `${endpoint} failed: ${error.code}: ${error.message}` : `${endpoint} failed`,
			);
		}
		return result.value;
	};

	const BuddySettingsSection = createBuddySettingsSection({ call, t });

	ctx.slots.inject("settings.section", () =>
		ctx.slots.register(
			{ name: "settings.section", id: SECTION_ID, order: SECTION_ORDER, label: () => t("nav"), locale: NS },
			BuddySettingsSection,
		),
	);
}
```

- [ ] **Step 5: Add the browser build to `build.mjs`**

Append after the host loop:

```js
const banner = `window.__ModuleLoader__.load({
	id: "dsh-buddy",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;`;

const footer = `		return module.exports;
	}
});`;

await build({
	entryPoints: ["src/client/index.tsx"],
	outfile: "lib/client.js",
	bundle: true,
	format: "cjs",
	platform: "browser",
	target: "es2022",
	jsx: "automatic",
	external: ["react", "react/jsx-runtime"],
	banner: { js: banner },
	footer: { js: footer },
	logLevel: "info",
});
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run check`
Expected: typecheck clean; `lib/` holds all four artifacts; the three client-ui tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/client/ test/client-ui.test.ts build.mjs
git commit -m "feat: add the Buddy settings tab"
```

---

## Task 8: Browser half — sidebar button, main panel, conversation list

**Files:**
- Create: `src/client/panel.tsx`
- Modify: `src/client/index.tsx` (add the `sidebar.panellist` and `main` registrations)

**Interfaces:**
- Consumes: `SettingsDeps`-shaped `call` and `t` (Task 7); endpoint `buddyPersona/sessions` (Task 5); client services `layout`, `sessions`.
- Produces:
  - `createBuddyPanel(deps: PanelDeps): () => unknown`
  - `createBuddyIcon(): () => unknown`
  - `interface PanelDeps { call(endpoint: string, args: unknown): Promise<unknown>; t(key: string): string; openSession(sessionId: string): void }`

- [ ] **Step 1: Write `src/client/panel.tsx`**

```tsx
/**
 * The dsh-buddy main panel: the command centre, not a chat client.
 *
 * Clicking a conversation hands off to the shipped conversation view rather
 * than rendering messages here. That is a deliberate scope decision: the
 * official view already owns message rendering, tool cards, approvals,
 * streaming and attachments, and re-implementing them would both cost thousands
 * of lines and drift behind the product.
 * @module dsh-buddy/client/panel
 */
import { useCallback, useEffect, useState } from "react";

/** One buddy conversation; mirrors the host's `BuddySessionSummary`. */
interface BuddySessionSummary {
	sessionId: string;
	title: string;
	updatedAt: number;
	cwd: string;
}

/** Collaborators supplied by the plugin's `apply`. */
export interface PanelDeps {
	/** Unwrapped RPC: resolves the endpoint's payload or throws. */
	call(endpoint: string, args: unknown): Promise<unknown>;
	/** Locale lookup bound to this plugin's namespace. */
	t(key: string): string;
	/** Open a session in the shipped conversation view and leave this panel. */
	openSession(sessionId: string): void;
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
	body: { flex: 1, minHeight: 0, overflowY: "auto", padding: "12px 20px" },
	sectionLabel: { fontSize: 12, fontWeight: 600, color: "var(--dsw-alias-label-secondary)", margin: "4px 0 8px" },
	row: {
		display: "flex",
		flexDirection: "column",
		gap: 2,
		width: "100%",
		textAlign: "left",
		padding: "10px 12px",
		marginBottom: 6,
		borderRadius: 8,
		border: "1px solid transparent",
		background: "var(--dsw-alias-fill-secondary, rgba(127,127,127,.08))",
		cursor: "pointer",
		color: "inherit",
	},
	rowTitle: { fontSize: 14 },
	rowMeta: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" },
	empty: { fontSize: 13, color: "var(--dsw-alias-label-secondary)" },
	error: { fontSize: 13, color: "var(--dsw-alias-status-error, #d64545)" },
	button: { padding: "4px 12px", borderRadius: 6, cursor: "pointer" },
} as const;

/**
 * Build the main-panel component.
 * @param deps - RPC, locale and navigation collaborators.
 * @returns the component the `main` slot renders under the `dsh-buddy` key.
 */
export function createBuddyPanel(deps: PanelDeps): () => unknown {
	return function BuddyPanel(): unknown {
		const [items, setItems] = useState<BuddySessionSummary[] | undefined>(undefined);
		const [error, setError] = useState<string | undefined>(undefined);

		const load = useCallback(async (): Promise<void> => {
			try {
				setItems((await deps.call("buddyPersona/sessions", {})) as BuddySessionSummary[]);
				setError(undefined);
			} catch (cause) {
				setError((cause as Error).message);
			}
		}, []);

		useEffect(() => {
			void load();
		}, [load]);

		return (
			<div style={styles.panel}>
				<div style={styles.header}>
					<span style={styles.title}>{deps.t("panelTitle")}</span>
					<button style={styles.button} type="button" onClick={() => void load()}>
						{deps.t("refresh")}
					</button>
				</div>
				<div style={styles.body}>
					<div style={styles.sectionLabel}>{deps.t("conversations")}</div>
					{error !== undefined && <div style={styles.error}>{error}</div>}
					{error === undefined && items !== undefined && items.length === 0 && (
						<div style={styles.empty}>{deps.t("empty")}</div>
					)}
					{items?.map((item) => (
						<button
							key={item.sessionId}
							style={styles.row}
							type="button"
							onClick={() => deps.openSession(item.sessionId)}
						>
							<span style={styles.rowTitle}>{item.title.trim() === "" ? deps.t("untitled") : item.title}</span>
							{item.cwd !== "" && <span style={styles.rowMeta}>{item.cwd}</span>}
						</button>
					))}
				</div>
			</div>
		);
	};
}

/**
 * Build the sidebar row's icon.
 *
 * The sidebar owns the button, its label and its selected state; an occupant
 * supplies only the glyph, sized to the geometry the row asks for.
 * @returns the component the `sidebar.panellist` slot renders.
 */
export function createBuddyIcon(): (props: { size?: number }) => unknown {
	return function BuddyIcon(props: { size?: number }): unknown {
		const size = props.size ?? 16;
		return (
			<svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
				<circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
				<circle cx="9" cy="10.5" r="1.2" fill="currentColor" />
				<circle cx="15" cy="10.5" r="1.2" fill="currentColor" />
				<path d="M8.5 15c1 1 2.2 1.5 3.5 1.5s2.5-.5 3.5-1.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
			</svg>
		);
	};
}
```

- [ ] **Step 2: Add the two paired registrations to `src/client/index.tsx`**

Add the import beside the existing settings import:

```tsx
import { createBuddyIcon, createBuddyPanel } from "./panel.tsx";
```

Then append to `apply`, after the `settings.section` registration:

```tsx
	// The button and the panel are one unit. `ctx.layout.selectPanel` throws on a
	// key the main slot never registered — and preserves the current selection —
	// so a button registered without its panel is a button that throws on click.
	const BuddyPanel = createBuddyPanel({
		call,
		t,
		openSession: (sessionId: string) => {
			ctx.sessions.open(sessionId);
			// null returns the centre column to the Conversation.
			ctx.layout.selectPanel(null);
		},
	});
	const BuddyIcon = createBuddyIcon();

	// One shared constant for both registrations, so the id and the key cannot
	// drift apart in a later edit.
	ctx.slots.inject("main", function* () {
		yield ctx.slots.register({ name: "main", key: MAIN_PANEL_KEY }, BuddyPanel);
	});

	ctx.slots.inject("sidebar.panellist", () =>
		ctx.slots.register(
			{ name: "sidebar.panellist", id: MAIN_PANEL_KEY, order: 10, label: () => t("nav"), locale: NS },
			BuddyIcon,
		),
	);
```

- [ ] **Step 3: Extend `test/client-ui.test.ts` with the pairing assertion**

```ts
test("the button and the panel are both registered — neither alone", async () => {
	// A sidebar row without a main entry throws on click, because
	// ctx.layout.selectPanel rejects a key the main slot never registered.
	const built = await bundle();
	assert.match(built, /sidebar\.panellist/);
	assert.match(built, /"main"|'main'/);
});
```

- [ ] **Step 4: Run the whole suite**

Run: `npm run check`
Expected: typecheck clean, all tests pass, four artifacts written.

- [ ] **Step 5: Commit**

```bash
git add src/client/panel.tsx src/client/index.tsx
git commit -m "feat: add the dsh-buddy sidebar button, main panel and conversation list"
```

---

## Task 9: The `buddy` agent preset

**Files:**
- Create: `~/.dsh/.agent-presets/buddy/preset.yml`, `~/.dsh/.agent-presets/buddy/agent.cordis.yml` (copied from the shipped `standard`, then edited)
- Create: `assets/preset/agent.cordis.yml`, `assets/preset/preset.yml` (the validated result, shipped as the template Task 10 installs from)
- Modify: `package.json` (`files` must include `assets`)

**Interfaces:**
- Consumes: the `buddy_soul` prompt variable (Task 6).
- Produces: a mountable preset with id `buddy`, which stamps `SessionHeader.agentPreset === 'buddy'` on its sessions — the exact field Task 6's `listSessions` filters on; plus the shipped template `assets/preset/*`.

**Why copy rather than author:** the composition skill warns that "a composition
written from scratch usually forgets a group realm or a consumer row; a copy
starts loadable". So the template is not hand-written — it is produced here by
copying the shipped `standard`, adding one row, and mount-validating the result.
Only a composition that actually mounted gets committed as the template.

- [ ] **Step 1: Copy the shipped `standard` preset into the user root**

The shipped install is read-only; never edit it in place.

```bash
SRC=/home/panda-nuc/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-presets/presets/standard
mkdir -p ~/.dsh/.agent-presets
cp -r "$SRC" ~/.dsh/.agent-presets/buddy
ls -la ~/.dsh/.agent-presets/buddy
```
Expected: `agent.cordis.yml` and `preset.yml` present.

- [ ] **Step 2: Replace `~/.dsh/.agent-presets/buddy/preset.yml`**

The roster `order` belongs to the shipped set only; a copy drops it.

```yaml
name: Buddy
description: 常驻个人助理：使用 SOUL.md 的人格与 AGENTS.md 的规则，对话计入 dsh-buddy 面板。
```

- [ ] **Step 3: Add the persona row at the top of `~/.dsh/.agent-presets/buddy/agent.cordis.yml`**

Insert this as the **first** row, before every row copied from `standard`:

```yaml
# The buddy persona.
#
# `@deepseek-ai/dsh-persona` is scope-only: mounted inside a preset it shadows
# the deployment persona for this one session, which is exactly the boundary
# that keeps Buddy's voice out of ordinary coding sessions.
#
# The prefix is a single reference to the `buddy_soul` prompt variable, which the
# host row `dsh-buddy/persona` registers from SOUL.md and AGENTS.md. The
# renderer does not scan substituted values again, so a persona containing `{{`
# is carried through verbatim — which matters because the agent will eventually
# edit this file itself.
#
# If the dsh-buddy plugin is not installed, the variable is unregistered and
# prompt assembly fails loudly with `unknown prompt variable "{{buddy_soul}}"`.
# That is the intended failure: a silent fallback would leave a session claiming
# to be Buddy with none of Buddy's identity.
- id: buddy-persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: '{{buddy_soul}}'
```

- [ ] **Step 4: Mount-validate the preset**

`standingKeyFor(id)` composes the preset's plugin subtree for real — the same mount a session start performs. Define and run a throwaway probe plugin:

```js
// cordis_define host half, then cordis_run
return {
  name: 'buddy-preset-probe',
  inject: ['agentPresets', 'tools'],
  apply(ctx) {
    harness.registerTool(ctx, harness.defineTool({
      name: 'preset_check',
      description: 'Mount-validate one preset by id.',
      parameters: { id: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render(_a, v) { return [{ type: 'text', text: v }] } },
      async execute(args) {
        try {
          await ctx.agentPresets.standingKeyFor(args.id)
          return 'mounted OK'
        } catch (error) {
          return error.message
        }
      },
    }))
  },
}
```

Run `preset_check` with `id: "buddy"`.
Expected: `mounted OK`. A failure names its own cause — an unresolved package, an invalid config, a row that never activated, or a service published into the root realm. Fix and re-run. Then `cordis_undefine` the probe: it is a probe, not a capability to leave behind.

**Do not proceed to Step 5 until this returns `mounted OK`.** The whole point of
the copy-then-validate order is that only a proven-loadable composition becomes
the shipped template.

- [ ] **Step 5: Freeze the validated composition as the shipped template**

```bash
mkdir -p assets/preset
cp ~/.dsh/.agent-presets/buddy/agent.cordis.yml assets/preset/agent.cordis.yml
cp ~/.dsh/.agent-presets/buddy/preset.yml assets/preset/preset.yml
```

Add `"assets"` to the `files` array in `package.json`, so the template ships with
the package:

```json
"files": ["lib", "src", "assets", "cordis.patch.yml"],
```

- [ ] **Step 6: Commit the template**

```bash
git add assets/preset/ package.json
git commit -m "feat: add the validated buddy agent preset template"
```

---

## Task 10: Install the preset from the plugin on first load

**Files:**
- Create: `src/store/preset.ts`
- Modify: `src/store/index.ts` (call the installer during boot)
- Test: `test/preset-install.test.ts`

**Interfaces:**
- Consumes: `assets/preset/*` (Task 9).
- Produces:
  - `presetTargetDir(dshHome: string): string`
  - `installPreset(targetDir: string, templateDir: string): Promise<'installed' | 'kept'>`

- [ ] **Step 1: Write the failing test `test/preset-install.test.ts`**

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installPreset, presetTargetDir } from "../src/store/preset.ts";

/** A stand-in template directory. */
async function template(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "dsh-buddy-tpl-"));
	await writeFile(join(dir, "agent.cordis.yml"), "- id: persona\n", "utf8");
	await writeFile(join(dir, "preset.yml"), "name: Buddy\n", "utf8");
	return dir;
}

test("the preset lands under the harness home's authored-preset root", () => {
	assert.equal(presetTargetDir("/home/u/.dsh"), join("/home/u/.dsh", ".agent-presets", "buddy"));
});

test("an absent preset directory is created from the template", async () => {
	const target = join(await mkdtemp(join(tmpdir(), "dsh-buddy-home-")), ".agent-presets", "buddy");
	assert.equal(await installPreset(target, await template()), "installed");
	assert.equal(await readFile(join(target, "agent.cordis.yml"), "utf8"), "- id: persona\n");
	assert.equal(await readFile(join(target, "preset.yml"), "utf8"), "name: Buddy\n");
});

test("an existing preset is never overwritten", async () => {
	const target = join(await mkdtemp(join(tmpdir(), "dsh-buddy-home-")), ".agent-presets", "buddy");
	await mkdir(target, { recursive: true });
	await writeFile(join(target, "agent.cordis.yml"), "MINE\n", "utf8");
	assert.equal(await installPreset(target, await template()), "kept");
	assert.equal(await readFile(join(target, "agent.cordis.yml"), "utf8"), "MINE\n");
});

test("installing twice is idempotent and keeps the first result", async () => {
	const target = join(await mkdtemp(join(tmpdir(), "dsh-buddy-home-")), ".agent-presets", "buddy");
	const tpl = await template();
	assert.equal(await installPreset(target, tpl), "installed");
	assert.equal(await installPreset(target, tpl), "kept");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/preset-install.test.ts`
Expected: FAIL with `Cannot find module '../src/store/preset.ts'`.

- [ ] **Step 3: Write `src/store/preset.ts`**

```ts
/**
 * Shipping the `buddy` agent preset with the plugin.
 *
 * The preset is what makes a session a buddy session — it stamps
 * `SessionHeader.agentPreset` and carries the persona row — so requiring the
 * user to hand-copy a directory would make the plugin useless until they did.
 *
 * The template is a composition that was produced by copying the shipped
 * `standard` preset and proven to mount before it was committed; it is never
 * hand-authored, because a composition written from scratch tends to forget an
 * isolate realm or a consumer row.
 *
 * **Never overwrite.** Once the directory exists it belongs to the user, who may
 * have edited it. An upgrade that silently reverted their preset would be a far
 * worse failure than an out-of-date template.
 * @module dsh-buddy/store/preset
 */
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

/** The files the template consists of. */
const PRESET_FILES = ["agent.cordis.yml", "preset.yml"] as const;

/**
 * Where an authored preset named `buddy` belongs.
 * @param dshHome - the resolved harness home.
 * @returns the preset directory path.
 */
export function presetTargetDir(dshHome: string): string {
	return join(dshHome, ".agent-presets", "buddy");
}

/**
 * Install the preset if, and only if, nothing is there yet.
 *
 * Presence is judged on the directory having any entry at all, not on one file:
 * a user who deleted `preset.yml` on purpose should not have it restored.
 * @param targetDir - where the preset belongs.
 * @param templateDir - the shipped template directory.
 * @returns `installed` when files were written, `kept` when the user's own copy was left alone.
 */
export async function installPreset(targetDir: string, templateDir: string): Promise<"installed" | "kept"> {
	const existing = await readdir(targetDir).catch(() => undefined);
	if (existing !== undefined && existing.length > 0) return "kept";
	await mkdir(targetDir, { recursive: true });
	for (const file of PRESET_FILES) await copyFile(join(templateDir, file), join(targetDir, file));
	return "installed";
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run typecheck && node --test test/preset-install.test.ts`
Expected: 4 passing.

- [ ] **Step 5: Call the installer from the store row's boot**

In `src/store/index.ts`, add the imports:

```ts
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { installPreset, presetTargetDir } from "./preset.ts";
```

and, inside the async boot IIFE, after `await mkdir(paths.home, { recursive: true });`:

```ts
			// The template ships beside the built artifact: lib/store.js → ../assets/preset.
			const templateDir = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "preset");
			// The preset root follows the harness home, not the buddy home: it is the
			// harness that reads it, and a relocated buddy home must not hide the preset.
			await installPreset(presetTargetDir(dshHomePath()), templateDir).catch((error: unknown) => {
				// A missing preset degrades the product but must not stop the store:
				// the panel, the settings tab and the endpoints all still work.
				console.error(`dsh-buddy-store: preset install skipped: ${(error as Error).message}`);
			});
```

- [ ] **Step 6: Run the whole suite**

Run: `npm run check`
Expected: typecheck clean; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/store/preset.ts src/store/index.ts test/preset-install.test.ts
git commit -m "feat: install the buddy agent preset on first load, never overwriting"
```

---

## Task 11: Install into the profile and verify on the real harness

**Files:**
- Modify: `~/.dsh/profiles/web/package.json` (add the link dependency and the bundle entry)

**Interfaces:**
- Consumes: everything above.
- Produces: a running dsh-buddy in the live GUI.

- [ ] **Step 1: Link the package into the web profile**

Add to `~/.dsh/profiles/web/package.json` `dependencies`:

```json
"dsh-buddy": "link:/home/panda-nuc/repo/dsh-buddy"
```

and append `"dsh-buddy"` to `dsh.profile.bundles`.

- [ ] **Step 2: Install**

```bash
dsh plugin --profile web install
```
Expected: completes without error; `~/.dsh/profiles/web/node_modules/dsh-buddy` exists.

- [ ] **Step 3: Verify the rows reached the composition**

```bash
dsh --profile web --dump-config | grep -A2 buddy
```
Expected: both `buddy-store` and `buddy-persona` rows appear; no `FAILED` in the startup log.

- [ ] **Step 4: Verify host behaviour in an isolated profile**

Never restart the user's live instance to test, and never ask them to read logs — under the web profile, plugin logs reach neither stdout nor any file.

```bash
T=/tmp/dsh-probe; mkdir -p $T/profiles/web; cd ~/.dsh/profiles/web
cp cordis.yml cordis.patch.yml package.json pnpm-workspace.yaml $T/profiles/web/
ln -s ~/.dsh/profiles/web/node_modules $T/profiles/web/node_modules
DSH_HOME=$T dsh --profile web --no-open --port 3099
```

The startup line prints `http://127.0.0.1:3099/?token=<token>`. Exchange it for a cookie, then call the endpoints directly:

```bash
curl -s -c /tmp/c.txt -o /dev/null 'http://127.0.0.1:3099/?token=<token>'
curl -s -b /tmp/c.txt -X POST http://127.0.0.1:3099/api/buddyPersona/persona \
  -H 'content-type: application/json' \
  -d '{"type":"client-request","rpcId":"1","method":"buddyPersona/persona","payload":{"args":{}}}'
```
Expected: an `ok: true` envelope whose value carries `soul`, `agents`, and a `home` under `/tmp/dsh-probe`.

Confirm the real harness home was untouched:
```bash
find ~/.dsh -newermt '<probe start time>'
```
Expected: empty.

- [ ] **Step 5: Restart the live harness and walk the acceptance list**

Host-half changes require a dsh restart; the browser half hot-reloads after a build.

Confirm each spec §11 criterion:
1. The dsh-buddy button appears in the left sidebar above Settings.
2. Clicking it replaces the centre column with the Buddy panel.
3. The panel lists buddy conversations; clicking one opens it in the conversation view.
4. Settings shows a Buddy tab; the persona editor saves without error.
5. `cat ~/.dsh/buddy/SOUL.md` matches what was typed.
6. The `buddy` preset appears in the preset picker; a new session on it shows the persona in its behaviour, and an existing coding session on `standard` is completely unaffected.
7. **Editing the persona takes effect without any reload** — save, then start another new buddy session and see the change. (This is what the prompt-variable mechanism buys; a genuinely static prefix would fail here.)
8. `dsh --profile web --dump-config` shows both rows; startup shows no `FAILED`.
9. `npm run check` is green.

- [ ] **Step 6: Commit any fixes found during verification**

```bash
git add -A
git commit -m "fix: corrections from real-harness verification"
```

---

## Notes for the executor

- **Do not claim a step passed without running it.** Every "Expected:" line is a real assertion to observe.
- **The browser half is a cordis plugin but not a patch row.** It reaches the boot graph through the package's `dsh.client` declaration; only the two host rows appear in `cordis.patch.yml`.
- **No test file may import a `.tsx` module.** Node's type stripping does not handle JSX. Browser-half behaviour is asserted against the built `lib/client.js`, which also proves it compiles.
- **The preset is inert until Task 11.** Task 9 writes it into the live user root while the plugin is not yet in the profile; a buddy session started in that window fails prompt assembly with `unknown prompt variable "{{buddy_soul}}"`. That is the designed loud failure, not a bug — finish Task 11.
- **If `readTitle` is absent** from the live `sessionQuery` surface, Task 6's `listSessions` already degrades: the optional call is guarded and the summary falls back to an empty title, which the panel renders as "Untitled". Do not add a hard dependency on it.
- **Phase 1 stops here.** Memory, skill curation, the scheduler, the board, and Telegram are later phases with their own plans. Do not start them because an interface looks ready.
