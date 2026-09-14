# dsh-buddy

A DSH (DeepSeek Harness) plugin: a persistent personal assistant with an authored persona, its own storage domain, and a dedicated main panel.

Buddy's voice lives in plain Markdown under the buddy home, not in a database and not in the harness's settings document. The plugin's job is to carry that prose to the model **for buddy sessions only**, and to give you somewhere to edit it.

## Status

Phase 1 is a walking skeleton, and it is **finished**: all eleven tasks have landed on `feat/phase-1`, the plugin has been linked into a live `web` profile, and a real-harness boot has served `buddyPersona/persona` over the wire.

- the `buddy` settings section and the buddy home resolution (`<harness home>/buddy` by default);
- the `dsh-buddy/store` row: the `buddy` storage domain, `ctx.buddyStore`, and synchronizing the shipped `buddy` agent preset under the harness home at boot;
- the `dsh-buddy/persona` row: `SOUL.md` / `AGENTS.md` read-write, the `buddy_soul` prompt variable, and the `buddyPersona/*` endpoints (`persona`, `updatePersona`, `sessions`);
- the browser half: the **Settings → Buddy** tab, the sidebar button, and the main panel it selects, listing buddy conversations and handing off to the shipped conversation view;
- the `buddy` agent preset (`assets/preset/`) — the `standard` preset's full toolset plus a persona row whose prefix is `{{buddy_soul}}`, which is what actually carries the authored voice to the model.

Memory, skill evolution, scheduler and board are later phases with their own plans; nothing here starts them because an interface looks ready.

### Two things worth knowing before you touch this

- **The preset is a plugin artifact, not a file you edit in place.** `syncPreset` (`src/store/preset.ts`) writes `assets/preset/` into `~/.dsh/.agent-presets/buddy/` and keys on the `.dsh-buddy-generated` marker it puts there: a marked install is synchronized file by file on every boot, so a corrected template really does reach an install that already ran; an unmarked directory is someone else's `buddy` preset and is left alone entirely; and a marked file whose bytes changed by hand is copied to `<file>.bak` before the plugin overwrites it. To customize the wiring, copy the preset to a new id — the GUI's "copy preset" — and edit that copy rather than the generated one.
- **A prompt variable name is a harness grammar, not a style choice.** `dsh-system-prompt` refuses any name that does not match `/^[a-z][a-z0-9_]*$/` — and it refuses it at **boot**, not at first use: a camelCase `SOUL_VARIABLE` kills the whole loader entry with `invalid prompt variable name`, not just the buddy session. This bit Phase 1 for real (`buddySoul` → `buddy_soul`, see the git history); `test/preset.test.ts` now asserts the constant against this exact regex so it cannot regress silently.

## Architecture

One package, four cordis plugins (three working rows plus the anchor row), one bundle.

| Unit | Kind | Responsibility |
| --- | --- | --- |
| `dsh-buddy/store` | host row | Resolves the buddy home, opens the `buddy` storage domain, publishes `ctx.buddyStore`, and synchronizes the shipped `buddy` agent preset under the harness home at boot — rewriting a marked install, leaving an unmarked directory alone. Hard-injects `storageDomain`; reads `settings` through a scoped injection so it still boots without a settings plane. |
| `dsh-buddy/persona` | host row | Holds the persona in memory, registers the `buddy_soul` prompt variable, serves the `buddyPersona/*` typert endpoints (`persona`, `updatePersona`, `sessions`, `preferences`, `updatePreferences`). Hard-injects `buddyStore`, `typert`, `systemPrompt`; reads `sessionQuery` softly, per request. |
| `dsh-buddy/telegram` | host row | Absorbed from dsh-telegram: the Telegram bridge, bound to buddy sessions. Settings namespace `buddy-telegram`, storage domain `buddy_telegram`, service/typert `buddyTelegram`. Hard-injects `typert`, `storageDomain`, `buddyStore`; everything else (`settings`, `credentials`, `agents`, …) is soft. Idles until enabled with a token, and refuses to poll while a still-mounted, still-enabled `dsh-telegram` row holds the same bot. |
| `dsh-buddy/client` | browser half | The Settings → Buddy tab (module visibility and the buddy home path), the `sidebar.footer.action` Buddy folder (opens the main panel, lists conversations), and the main panel itself — a module table (Soul, Agents, Model, Telegram). Reaches the host only over `rpc.call('/api', 'buddyPersona/…')` plus the platform's own `remote.session` / `remote.credentials`. |
| `buddy` agent preset | preset (`assets/preset/`) | Copied from the shipped `standard` preset, plus a persona row whose prefix is `{{buddy_soul}}`. Synchronized to `~/.dsh/.agent-presets/buddy/` at boot; this is the only thing that puts the authored voice in front of a model. |

The three host rows are inserted by `cordis.patch.yml` and are deliberately separate: each has its own effect scope, so a failure in one does not take the others down, and any of them can be disabled from a profile's own patch without touching code. The browser half reaches the boot graph through the package's `dsh.client` declaration, which the harness only reads for a row named exactly `dsh-buddy` — hence a fourth, empty `buddy-client` row that registers nothing.

## Where data lives

Three planes, and the split is load-bearing:

| Plane | Holds | Example |
| --- | --- | --- |
| Settings (`~/.dsh/settings.yaml`) | User-tunable non-secrets only | `buddy.home` |
| Files under the buddy home | Prose a human or the agent authors | `SOUL.md` (voice), `AGENTS.md` (operating rules) |
| Storage domain `buddy` | Derived state nothing can reconstruct | `lastPersonaWriteAt` |

Authored content stays as ordinary Markdown on purpose: self-evolution edits it with plain file tools, and files stay greppable, diffable and backup-able. `SOUL.md` and `AGENTS.md` are two files rather than one because only the voice reaches the prompt variable — merging them would push operating rules into `{{buddy_soul}}`.

## Telegram

Configured from the **Telegram** module in the Buddy main panel, not from a separate settings tab: the bot token, owner id, working directory, permission level, Markdown rendering and media delivery all live there. The bot token is shared with the standalone `dsh-telegram` plugin (same credential key), so the two cannot run at once — Buddy will not poll while `dsh-telegram` is still installed in the profile and enabled, and its Telegram module says so instead of failing silently with a 409 from Telegram's own API.

## Development

```bash
npm run build       # esbuild → lib/{index,store,persona,telegram}.js (ESM) + lib/client.js (browser factory)
npm run typecheck   # tsc --noEmit
npm test            # pretest builds first, then node --test test/*.test.ts test/telegram/*.test.ts
npm run check       # typecheck + build + test — the gate before any commit
```

A single file, or a single case (build first: `test/client-ui.test.ts` asserts against the built bundle):

```bash
npm run build && node --test test/store.test.ts
node --test --test-name-pattern 'already-open' test/store.test.ts
```

Requires Node `^22.19 || >=24` — the harness's own supported range. Tests are plain `node:test` with native type stripping; no test may import a `.tsx` module, because type stripping does not handle JSX.

Static checks from the [`dsh-plugin-guide`](https://github.com/PerryLink/dsh-plugin-guide) toolkit:

```bash
dsh-plugin-dev check --cwd .
```

Two of its findings are refused on purpose: five-language READMEs are that toolkit's publishing convention (this package is `private`), and the `packageManager` pin wants pnpm while this repo is npm-managed.

## Installing into a profile

Done for the `web` profile on this machine; the steps below are how to repeat it anywhere else.

1. Add `"dsh-buddy": "link:/path/to/dsh-buddy"` to `~/.dsh/profiles/<name>/package.json` and append `"dsh-buddy"` to `dsh.profile.bundles`.
2. `dsh plugin --profile <name> install`
3. `dsh --profile <name> --dump-config | grep -A2 buddy` — both rows should appear with no `FAILED` in the startup log.

Every boot also synchronizes `~/.dsh/.agent-presets/buddy/` from `assets/preset/`: the directory is created if it is absent, a marked install is rewritten when the template has moved on, and an unmarked directory is left untouched — see the preset note in Status above.

Host-half changes need a dsh restart; the browser half hot-reloads after a build. Verify host behaviour in an **isolated probe profile**, never by restarting the live instance: under the web profile, plugin logs reach neither stdout nor any file. The recipe is in `CLAUDE.md`.

## Layout

```
src/index.ts        shared constants — exports no apply(), so it cannot be mounted as a row
src/paths.ts        buddy home + file resolution (pure)
src/config.ts       the `buddy` settings schema
src/store/          domain spec, openStore, the store row, shipping and synchronizing the agent preset
src/persona/        SOUL.md/AGENTS.md IO, typert gateway, the persona row
src/client/         browser half: settings tab, sidebar button + main panel, RPC envelope unwrap
assets/preset/      the frozen `buddy` agent preset template (agent.cordis.yml, preset.yml)
docs/superpowers/   the design spec (中文) and the Phase 1 implementation plan
```

`CLAUDE.md` carries the invariants that pass tests and still break the live harness — no `#` private fields in a service, `ctx.get` for soft dependencies, registration-is-effect, and the rest. Read it before changing a row.

## License

MIT
