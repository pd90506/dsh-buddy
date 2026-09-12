# dsh-buddy

A DSH (DeepSeek Harness) plugin: a persistent personal assistant with an authored persona, its own storage domain, and — once Phase 1 finishes — a dedicated main panel.

Buddy's voice lives in plain Markdown under the buddy home, not in a database and not in the harness's settings document. The plugin's job is to carry that prose to the model **for buddy sessions only**, and to give you somewhere to edit it.

## Status

Phase 1 is a walking skeleton, and it is **not finished**. Tasks 1–7 have landed on `feat/phase-1`:

- the `buddy` settings section and the buddy home resolution (`<harness home>/buddy` by default);
- the `dsh-buddy/store` row: the `buddy` storage domain, `ctx.buddyStore`;
- the `dsh-buddy/persona` row: `SOUL.md` / `AGENTS.md` read-write, the `buddySoul` prompt variable, and the `buddyPersona/*` endpoints (`persona`, `updatePersona`, `sessions`);
- the browser half's **Settings → Buddy** tab, which edits both documents.

Still to come: the sidebar button and the main panel it selects (Task 8), the `buddy` agent preset that actually references `{{buddySoul}}` (Tasks 9–10), and installation into a live profile with real-harness verification (Task 11).

Until the preset exists, **the persona reaches no model**. The variable is registered and inert — which is the designed state, not a defect: a variable nobody references renders nowhere.

## Architecture

One package, three cordis plugins, one bundle.

| Unit | Kind | Responsibility |
| --- | --- | --- |
| `dsh-buddy/store` | host row | Resolves the buddy home, opens the `buddy` storage domain, publishes `ctx.buddyStore`. Hard-injects `storageDomain`; reads `settings` through a scoped injection so it still boots without a settings plane. |
| `dsh-buddy/persona` | host row | Holds the persona in memory, registers the `buddySoul` prompt variable, serves the `buddyPersona/*` typert endpoints. Hard-injects `buddyStore`, `typert`, `systemPrompt`; reads `sessionQuery` softly, per request. |
| `dsh-buddy/client` | browser half | The Settings tab today; the sidebar button and main panel next. Reaches the host only over `rpc.call('/api', 'buddyPersona/…')`. |

The two host rows are inserted by `cordis.patch.yml` and are deliberately separate: each has its own effect scope, so a failure in one does not take the other down, and either can be disabled from a profile's own patch without touching code. The browser half is **not** a patch row — it reaches the boot graph through the package's `dsh.client` declaration.

## Where data lives

Three planes, and the split is load-bearing:

| Plane | Holds | Example |
| --- | --- | --- |
| Settings (`~/.dsh/settings.yaml`) | User-tunable non-secrets only | `buddy.home` |
| Files under the buddy home | Prose a human or the agent authors | `SOUL.md` (voice), `AGENTS.md` (operating rules) |
| Storage domain `buddy` | Derived state nothing can reconstruct | `lastPersonaWriteAt` |

Authored content stays as ordinary Markdown on purpose: self-evolution edits it with plain file tools, and files stay greppable, diffable and backup-able. `SOUL.md` and `AGENTS.md` are two files rather than one because only the voice reaches the prompt variable — merging them would push operating rules into `{{buddySoul}}`.

## Development

```bash
npm run build       # esbuild → lib/{index,store,persona}.js (ESM) + lib/client.js (browser factory)
npm run typecheck   # tsc --noEmit
npm test            # pretest builds first, then node --test test/*.test.ts
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

Not yet done — this is Task 11, and the plugin is incomplete before it. When it happens:

1. Add `"dsh-buddy": "link:/path/to/dsh-buddy"` to `~/.dsh/profiles/<name>/package.json` and append `"dsh-buddy"` to `dsh.profile.bundles`.
2. `dsh plugin --profile <name> install`
3. `dsh --profile <name> --dump-config | grep -A2 buddy` — both rows should appear with no `FAILED` in the startup log.

Host-half changes need a dsh restart; the browser half hot-reloads after a build. Verify host behaviour in an **isolated probe profile**, never by restarting the live instance: under the web profile, plugin logs reach neither stdout nor any file. The recipe is in `CLAUDE.md`.

## Layout

```
src/index.ts        shared constants — exports no apply(), so it cannot be mounted as a row
src/paths.ts        buddy home + file resolution (pure)
src/config.ts       the `buddy` settings schema
src/store/          domain spec, openStore, the store row
src/persona/        SOUL.md/AGENTS.md IO, typert gateway, the persona row
src/client/         browser half: settings tab, RPC envelope unwrap
docs/superpowers/   the design spec (中文) and the Phase 1 implementation plan
```

`CLAUDE.md` carries the invariants that pass tests and still break the live harness — no `#` private fields in a service, `ctx.get` for soft dependencies, registration-is-effect, and the rest. Read it before changing a row.

## License

MIT
