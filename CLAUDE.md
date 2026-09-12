# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Hard constraints (machine)

- **Never scan a whole filesystem.** No recursive read rooted at `/`, at `~/`, or at any other mount root — no `find`, `grep -r`, `rg`, `ls -R`, `du` or glob that starts that wide. Recursing into a *specific* directory you have a reason to look in is fine and expected (`~/.dsh/profiles/web`, `node_modules/@deepseek-ai/dsh-session`, this repo): the rule is about the starting point, not the depth.
- **Never touch the network and backup volumes without a concrete reason.** `/mnt/nas` (NFS, 192.168.68.2) and `/srv/timemachine` are enormous and slow; a traversal that wanders into the NAS can run for **hours** over the network before it returns. Never let a search path fan out into them incidentally, and only read from them when the task is explicitly about a file that lives there.

## Commands

```bash
npm run build       # esbuild → lib/{index,store,persona}.js (ESM) + lib/client.js (browser factory)
npm run typecheck   # tsc --noEmit
npm test            # pretest runs build, then node --test test/*.test.ts
npm run check       # typecheck + build + test — the gate before any commit
```

Single test file / single case (Node 24 strips types natively; `lib/client.js` must exist for `client-ui.test.ts`, so build first):

```bash
npm run build && node --test test/store.test.ts
node --test --test-name-pattern 'already-open' test/store.test.ts
```

## Architecture

A DSH (deepseek-harness) plugin, shipped as one package containing **two host cordis rows plus one browser half**, all sharing constants from `src/index.ts`.

- `cordis.patch.yml` inserts the two host rows (`buddy-store`, `buddy-persona`) into a profile's bundle stack; `package.json`'s `dsh.bundle.patch` / `dsh.client` are what make the harness pick them up. The browser half is **not** a patch row — it reaches the boot graph through `dsh.client`.
- **Row `dsh-buddy/store`** (`src/store/`): resolves the buddy home (`buddy.home` setting → `dshHomePath('buddy')`), `mkdir`s it, opens the `buddy` storage domain, publishes `ctx.buddyStore`. Hard-injects `storageDomain` only; `settings` is a *scoped* injection so the row still boots without a settings plane. The boot waits on a barrier for the settings source, bounded by an internal 2 s timeout that is deliberately not a user tunable.
- **Row `dsh-buddy/persona`** (`src/persona/`): hard-injects `buddyStore`, `typert`, `systemPrompt`. Holds the persona in memory (prompt assembly must never touch disk), registers the `buddySoul` prompt **variable**, and publishes the `buddyPersona` typert endpoints (`persona`, `updatePersona`, `sessions`). `sessionQuery` stays soft (`ctx.get`) and is read per request.
- **Browser half** (`src/client/`): registers the Settings → Buddy tab; later tasks add the `sidebar.panellist` button and the `main` panel. `src/client/call.ts` is plain `.ts` (not `.tsx`) so tests can drive the RPC envelope unwrap directly.

Three data planes, strictly separated: **settings** (`~/.dsh/settings.yaml`, only user-tunable non-secrets) / **files on disk** (`<buddy home>/SOUL.md`, `AGENTS.md` — authored prose, greppable and diffable) / **storage domain** `buddy` (derived state nothing can reconstruct, e.g. `lastPersonaWriteAt`).

Persona reaches the model *only* through the `buddy` agent preset, whose persona row carries the literal `{{buddySoul}}`. That is what structurally keeps Buddy's voice out of ordinary coding sessions — not a scope choice at registration time.

Design spec: `docs/superpowers/specs/2026-09-12-dsh-buddy-design.md`. Phase-1 task plan (with the full rationale behind each of the rules below): `docs/superpowers/plans/2026-09-12-dsh-buddy-phase-1.md`. Phase 1 stops at the walking skeleton — memory, skill evolution, scheduler, board and Telegram are later phases with their own plans; do not start them because an interface looks ready.

## Invariants (violating these passes tests and breaks the live harness)

- **No `#` private fields in a class registered as a cordis service.** Cordis hands services out as traceable proxies and dispatches with `Reflect.apply`; a `#` field's brand cannot cross a proxy. Use TypeScript `private`. `test/gateway.test.ts` dispatches through a proxy to catch it.
- **Soft dependencies are read with `ctx.get('name')`**, never as a property. A bare property read of a service missing from `inject` throws `cannot get property "x" without inject`. `inject` is for hard dependencies only.
- **Registration is effect.** Every contribution goes through `ctx.effect()` / `ctx.on()` / a `register()` disposer — never a hand-rolled `removeListener` / `clearInterval`. Prefer cordis's async effect form (`async () => disposer`) for anything with an awaited boot, so a dispose mid-boot still unwinds.
- **DSH transpiles nothing.** TypeScript and JSX must be gone from the artifacts. Host entries stay ESM with every `@deepseek-ai/*` external — module identity is load-bearing for the typert registry and the domain spec. The browser entry is CJS inside the `window.__ModuleLoader__.load({ id, factory })` envelope with React external. New host rows are added explicitly to `hostEntries` in `build.mjs`; it never scans a directory.
- **Endpoints register through `ctx.typert.register(...)` at runtime, never `@Remote` decorators** — a nested `dsh-typert-protocol` copy's decorator table is not the gateway's.
- **Never serialize live harness data** (services, Sessions, Slots). Read the leaf fields and build a small owned object — see `listSessions` in `src/persona/index.ts`.
- **Opening an already-open domain rejects**; `openStore` adopts the live handle on `code === 'already-open'` (hot reload). Domain and settings names are lowercase `buddy`.
- **One constant, two sides.** The sidebar list id and the main panel key are both `MAIN_PANEL_KEY` from `src/index.ts`; `selectPanel` throws on a key the main slot never registered, so the button and the panel are registered together or not at all.
- **No test file may import a `.tsx` module** — Node's type stripping does not handle JSX. Browser behaviour is asserted against the built `lib/client.js` (`test/client-ui.test.ts`), which also proves it compiles.
- **Never edit shipped presets** under `@deepseek-ai/dsh-agent-presets/presets/`. Authored presets go to `~/.dsh/.agent-presets/<id>/`.

## Verifying against the real harness

Under the `web` profile, plugin logs reach neither stdout nor any file, so never ask the user to read logs, and never restart their live instance to test. Use an isolated probe profile instead:

```bash
T=/tmp/dsh-probe; mkdir -p $T/profiles/web; cd ~/.dsh/profiles/web
cp cordis.yml cordis.patch.yml package.json pnpm-workspace.yaml $T/profiles/web/
ln -s ~/.dsh/profiles/web/node_modules $T/profiles/web/node_modules
DSH_HOME=$T dsh --profile web --no-open --port 3099
```

Then exchange the printed `?token=` for a cookie and POST to `/api/buddyPersona/<method>`. Afterwards `find ~/.dsh -newermt '<probe start>'` must come back empty. Host-half changes need a dsh restart; the browser half hot-reloads after a build.
