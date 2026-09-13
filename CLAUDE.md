# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Hard constraints (machine)

- **Never scan a whole filesystem.** No recursive read rooted at `/`, at `~/`, or at any other mount root — no `find`, `grep -r`, `rg`, `ls -R`, `du` or glob that starts that wide. Recursing into a *specific* directory you have a reason to look in is fine and expected (`~/.dsh/profiles/web`, `node_modules/@deepseek-ai/dsh-session`, this repo): the rule is about the starting point, not the depth.
- **Never touch the network and backup volumes without a concrete reason.** `/mnt/nas` (NFS, 192.168.68.2) and `/srv/timemachine` are enormous and slow; a traversal that wanders into the NAS can run for **hours** over the network before it returns. Never let a search path fan out into them incidentally, and only read from them when the task is explicitly about a file that lives there.

## Commands

```bash
npm run build       # esbuild → lib/{index,store,persona,telegram}.js (ESM) + lib/client.js (browser factory)
npm run typecheck   # tsc --noEmit
npm test            # pretest runs build, then node --test test/*.test.ts test/telegram/*.test.ts
npm run check       # typecheck + build + test — the gate before any commit
```

Single test file / single case (Node 24 strips types natively; `lib/client.js` must exist for `client-ui.test.ts`, so build first):

```bash
npm run build && node --test test/store.test.ts
node --test --test-name-pattern 'already-open' test/store.test.ts
```

`test/*.test.ts` and `test/telegram/*.test.ts` are the two suites `npm test` runs; `test/support/` holds the browser-half test harness (`createRenderer` and friends) and is only ever imported, never matched by either glob.

## Architecture

A DSH (deepseek-harness) plugin, shipped as one package containing **three host cordis rows (plus the empty `dsh-buddy` anchor row) and one browser half**, all sharing constants from `src/index.ts`.

- `cordis.patch.yml` inserts the three host rows (`buddy-store`, `buddy-persona`, `buddy-telegram`) plus an empty anchor row `buddy-client` (name `dsh-buddy`, `apply` in `src/index.ts`) into a profile's bundle stack; `package.json`'s `dsh.bundle.patch` / `dsh.client` are what make the harness pick them up. The browser half reaches the boot graph through `dsh.client` — but `dsh-client-modules` only reads that declaration for a row named **exactly** the package (`exactPackageSpecifier` skips `dsh-buddy/store`), so the anchor row is load-bearing. Without it the host rows boot, every unit test passes, and the sidebar folder and settings tab silently never appear. `test/patch.test.ts` guards it.
- **Row `dsh-buddy/store`** (`src/store/`): resolves the buddy home (`buddy.home` setting → `dshHomePath('buddy')`), `mkdir`s its `main/` layer, opens the `buddy` storage domain, publishes `ctx.buddyStore`. The home holds `main/` (authored files: `SOUL.md`, `AGENTS.md`) and `main/workspace/` (the cwd buddy conversations run in — see `resolveBuddyPaths` in `src/paths.ts`). Hard-injects `storageDomain` only; `settings` is a *scoped* injection so the row still boots without a settings plane. The boot waits on a barrier for the settings source, bounded by an internal 2 s timeout that is deliberately not a user tunable.
- **Row `dsh-buddy/persona`** (`src/persona/`): hard-injects `buddyStore`, `typert`, `systemPrompt`. Holds the persona in memory (prompt assembly must never touch disk), registers the `buddy_soul` prompt **variable**, and publishes the `buddyPersona` typert endpoints (`persona`, `updatePersona`, `sessions`, `preferences`, `updatePreferences`). `sessionQuery` stays soft (`ctx.get`) and is read per request.
- **Row `dsh-buddy/telegram`** (`src/telegram/`): absorbed from dsh-telegram's working tree at commit `d38a02c` plus an uncommitted credentials-readiness resync fix on top of that import (see `git log` for the "import dsh-telegram host source verbatim" commit). Hard-injects `typert`, `storageDomain`, `buddyStore`; everything else (`settings`, `credentials`, `agents`, `sessionController`, …) stays soft. Settings namespace `buddy-telegram`, storage domain `buddy_telegram`, service/typert `buddyTelegram`. Sessions always mount the `buddy` preset and are fail-closed — a resolve failure refuses to create the session rather than falling back to the global default; model precedence for a new session is chat `/model` > `buddy.model` (Buddy's own default) > the global default. A new session is **not** registered with `workspaceRegistry` and is **not** force-titled: it runs with `meta.cwd` set to the resolved workspace as-is (so it never appears grouped under a Workspaces folder, only under the Buddy folder), and its title is left to the harness's content-based auto-titling (`session.ts` keeps `chatTitle` on `ensure`'s signature only for the caller). Refuses to poll — reporting `error` status instead — while a non-disabled `dsh-telegram` row is mounted and its `telegram.enabled` setting is `true`, since one bot token admits only one long-poller.
- **Browser half** (`src/client/`): registers the Settings → Buddy tab (module visibility and the buddy home path only — Buddy's own configuration lives in the main panel), the `sidebar.footer.action` folder (`buddy-folder`, not a `sidebar.panellist` button) that opens the main panel and lists conversations, and the `main` panel itself — a module table (`src/client/modules.ts`) of Soul, Agents, Model and Telegram. `src/client/call.ts` is plain `.ts` (not `.tsx`) so tests can drive the RPC envelope unwrap directly.

Three data planes, strictly separated: **settings** (`~/.dsh/settings.yaml`, only user-tunable non-secrets) / **files on disk** (`<buddy home>/main/SOUL.md`, `<buddy home>/main/AGENTS.md` — authored prose, greppable and diffable) / **storage domain** `buddy` (derived state nothing can reconstruct, e.g. `lastPersonaWriteAt`).

Persona reaches the model *only* through the `buddy` agent preset, whose persona row carries the literal `{{buddy_soul}}`. That is what structurally keeps Buddy's voice out of ordinary coding sessions — not a scope choice at registration time.

Design specs: `docs/superpowers/specs/2026-09-12-dsh-buddy-design.md` (Phase 1) and `docs/superpowers/specs/2026-09-12-buddy-telegram-design.md` (Phase 6, absorbing dsh-telegram). Task plans, with the full rationale behind each of the rules below: `docs/superpowers/plans/2026-09-12-dsh-buddy-phase-1.md` and `docs/superpowers/plans/2026-09-12-dsh-buddy-phase-6-telegram.md`. Phase 1 stopped at the walking skeleton and Phase 6 absorbed Telegram; memory, skill evolution, scheduler and board are still later phases with their own plans — do not start them because an interface looks ready.

## Invariants (violating these passes tests and breaks the live harness)

- **No `#` private fields in a class registered as a cordis service.** Cordis hands services out as traceable proxies and dispatches with `Reflect.apply`; a `#` field's brand cannot cross a proxy. Use TypeScript `private`. `test/gateway.test.ts` dispatches through a proxy to catch it.
- **Soft dependencies are read with `ctx.get('name')`**, never as a property. A bare property read of a service missing from `inject` throws `cannot get property "x" without inject`. `inject` is for hard dependencies only.
- **Registration is effect.** Every contribution goes through `ctx.effect()` / `ctx.on()` / a `register()` disposer — never a hand-rolled `removeListener` / `clearInterval`. Prefer cordis's async effect form (`async () => disposer`) for anything with an awaited boot, so a dispose mid-boot still unwinds.
- **DSH transpiles nothing.** TypeScript and JSX must be gone from the artifacts. Host entries stay ESM with every `@deepseek-ai/*` external — module identity is load-bearing for the typert registry and the domain spec. The browser entry is CJS inside the `window.__ModuleLoader__.load({ id, factory })` envelope with React and `@deepseek-ai/dsh-client-ui-primitives` external.
- **Controls are the harness's own.** Buttons, toggles, text fields and menus are `Button` / `Switch` / `Input` / `Menu` from `@deepseek-ai/dsh-client-ui-primitives` (a platform seed, typed by hand in `src/client/primitives.d.ts`, stubbed in `test/support/client-harness.ts`). The kit has no select or textarea: dropdowns go through `src/client/select.tsx` (a `Menu` on a pill anchor, the host's LanguageRow pattern) and textareas use `FORM_CLASS.textarea`. Everything else is styled by the class stylesheets in `src/client/form-css.ts` and `src/client/folder-css.ts` — both on `--dsw-*` tokens, installed through `ctx.effect` — because host CSS-module class names are hashed per build. No `<select>`, no checkbox, no inline `style` in `src/client/`. New host rows are added explicitly to `hostEntries` in `build.mjs`; it never scans a directory.
- **Endpoints register through `ctx.typert.register(...)` at runtime, never `@Remote` decorators** — a nested `dsh-typert-protocol` copy's decorator table is not the gateway's.
- **Never serialize live harness data** (services, Sessions, Slots). Read the leaf fields and build a small owned object — see `listSessions` in `src/persona/index.ts`.
- **Opening an already-open domain rejects**; `openStore` adopts the live handle on `code === 'already-open'` (hot reload). Domain and settings names are lowercase `buddy`.
- **One constant, two sides.** The folder title's `selectPanel` target and the main panel key are both `MAIN_PANEL_KEY` from `src/index.ts`; `selectPanel` throws on a key the main slot never registered, so the folder and the panel are registered together or not at all.
- **No test file may import a `.tsx` module** — Node's type stripping does not handle JSX. Browser behaviour is asserted against the built `lib/client.js` (`test/client-ui.test.ts`), which also proves it compiles.
- **Never edit shipped presets** under `@deepseek-ai/dsh-agent-presets/presets/`. Authored presets go to `~/.dsh/.agent-presets/<id>/`.
- **A prompt variable name must match `/^[a-z][a-z0-9_]*$/`** (`dsh-system-prompt`'s own `VARIABLE_NAME` regex). This is checked at **boot**, not at first render: a camelCase `SOUL_VARIABLE` kills the whole loader entry with `invalid prompt variable name` before any session using it ever starts. Bit Phase 1 for real — `buddySoul` had to become `buddy_soul` after a real-harness boot failure — and `test/preset.test.ts` now asserts the constant against this exact regex.
- **`installPreset` never repairs an existing install.** It only writes when `~/.dsh/.agent-presets/buddy/` is absent or empty; once a copy exists — including the one this plugin ships — a later version's template fix does not reach it. Do not assume editing `assets/preset/agent.cordis.yml` changes anyone's already-installed preset; the shipped `~/.dsh` copy on this machine is kept manually in sync (see the comment above `assets/preset/agent.cordis.yml`'s twin).
- **Settings namespaces allow hyphens, storage units allow underscores.** A name containing a hyphen is valid only for a settings namespace, and one containing an underscore only for a storage unit — so a multi-word name has to be spelled differently in each, which is why the Telegram row is `buddy-telegram` (settings) vs `buddy_telegram` (storage domain). A single-word name like `buddy` needs no such split, which is why the store/persona rows use the same `buddy` for both planes.
- **The settings plane only describes registered namespaces**: the legacy migration sees `telegram` only while dsh-telegram is mounted. Removing dsh-telegram before the one-shot migration runs leaves nothing to copy from — the cutover order in the design spec exists because of this.
- **Every string the Telegram bot sends is English** (`test/telegram/english-copy.test.ts`, walking TypeScript AST leaf tokens rather than regex, so comments are excluded structurally and a CJK character after a `//` inside a string or URL is still caught).
- **The bot token belongs to the credentials plane, never settings.** Only `describeToken`'s posture (`configured` / `source` / `writable` — `TokenPosture` in `src/telegram/credentials.ts`) may reach settings, logs or the browser — the token value itself never does, in dsh-telegram's own working code and unchanged here.
- **Main-panel modules render as components (`<Module />`), never called as functions.** Calling one as a function merges its hooks into the panel's own hook list instead of giving it independent storage, which crashes real React (and `test/support/client-harness.ts`'s `createRenderer`, which enforces the Rules of Hooks per component instance).

## Verifying against the real harness

Under the `web` profile, plugin logs reach neither stdout nor any file, so never ask the user to read logs, and never restart their live instance to test. Use an isolated probe profile instead:

```bash
T=/tmp/dsh-probe; mkdir -p $T/profiles/web; cd ~/.dsh/profiles/web
cp cordis.yml cordis.patch.yml package.json pnpm-workspace.yaml $T/profiles/web/
ln -s ~/.dsh/profiles/web/node_modules $T/profiles/web/node_modules
DSH_HOME=$T dsh --profile web --no-open --port 3099
```

Then exchange the printed `?token=` for a cookie and POST to `/api/buddyPersona/<method>`. Afterwards `find ~/.dsh -newermt '<probe start>'` must come back empty. Host-half changes need a dsh restart; the browser half hot-reloads after a build.
