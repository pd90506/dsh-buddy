# hermes-agent — research report

**Identity:** [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) — Python, MIT, `pyproject.toml` `0.21.1`. Docs: [hermes-agent.nousresearch.com/docs](https://hermes-agent.nousresearch.com/docs/).
**Evidence:** read-only `main` tarball at `/tmp/hermes-research/src/hermes-agent-main` (fetched ~2026-09-10) + live docs. `main` moves; re-verify line numbers.

## 1. Architecture

One Python `AIAgent` loop; front-ends: CLI, TUI, Desktop, web dashboard, messaging **gateway** (Telegram/Discord/Slack). State in `~/.hermes/` (per-profile `profiles/<n>/`), durable store = SQLite `state.db` (sessions, FTS5, `gateway_routing`, `session_model_usage`). Platforms and memory backends are plugin rows, not kernel branches. Side tasks are **auxiliary model slots** (`auxiliary.{curator,background_review,vision,…}.{provider,model}`), each pinnable to a cheap model. Self-improvement = **forked `AIAgent`s** on daemon threads inheriting the parent's prompt cache, under a dispatch-side tool whitelist.

## 2. Memory ([docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory))

Two files in `~/.hermes/memories/`, entries joined by literal `"\n§\n"` (`tools/memory_tool_store.py`): **`MEMORY.md`** (2,200 chars) and **`USER.md`** (1,375 chars).

- **Injection:** frozen snapshot at session start with a `[67% — 1,474/2,200 chars]` header. Never updated mid-session — deliberate, preserves prefix cache. Disk writes immediate; tool results show live state.
- **Tool:** `memory(action=add|replace|remove)`. **No `read`.** `replace`/`remove` match by *unique substring* (`old_text`); ambiguous → error.
- **No decay, no auto-compaction.** Overflow returns a hard error carrying `current_entries` + `usage`, instructing consolidation *in the same turn*. `replace` is bounded too.
- **Guards:** duplicate rejection; strict-scope injection/exfil scan; invisible-Unicode block; **drift guard** refusing writes when the on-disk file won't round-trip (saves `.bak`, issue #26045); atomic writes under `fcntl`/`msvcrt` lock. Scoped per profile; two agents per home unsupported.
- **Unbounded tier:** `session_search` over `state.db` **FTS5** — ~20 ms, no LLM, no truncation.
- **External providers (8, one active, additive):** Honcho, OpenViking, Mem0, Hindsight, Holographic, RetainDB, ByteRover, Supermemory. `agent/memory_manager.py` fans duck-typed hooks: prompt injection, pre-turn prefetch, post-response sync, session-end extraction, mirroring of built-in writes, provider tools.
- Pruning UI: `/journey` (`list|delete|edit`).

## 3. Persona ([docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/personality))

`$HERMES_HOME/SOUL.md` = identity in **slot #1** of the system prompt, injected **verbatim**, no wrapper, after injection scan + truncation. Seeded once, never overwritten, loaded **only** from `HERMES_HOME` (never cwd). Empty/unreadable → hardcoded fallback. Separately, `/personality` overlays are named presets in `hermes_cli/personality.py` `BUILTIN_PERSONALITIES` (helpful, concise, technical, kawaii, catgirl, pirate, noir, uwu, hype…), selected via `display.personality`, extended by `agent.personalities`; `agent.system_prompt` is a third user-owned overlay.
**Evolution: none found.** No self-improvement path writes SOUL.md, and memory guidance explicitly tells the agent to skip anything already in SOUL.md/AGENTS.md. **UNCERTAIN:** `apps/desktop/src/plugins/hermes-bots/soul.ts` exists (not read) and may generate SOUL.md for Desktop bots.

## 4. Skill auto-evolution ([curator](https://hermes-agent.nousresearch.com/docs/user-guide/features/curator), [skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills))

**Artifact:** directory with `SKILL.md` (frontmatter `name`, `description`, `version`, `platforms`, `metadata.hermes.{tags,category,config,requires_toolsets}`; body *When to Use / Procedure / Pitfalls / Verification*) + optional `references/ templates/ scripts/ assets/`. Progressive disclosure: `skills_list()` (~3k tok) → `skill_view(name)` → `skill_view(name, path)`.

**Creation triggers:** (a) system-prompt **nudge** every `skills.creation_nudge_interval` iterations (default **10**; memory's `nudge_interval` likewise 10); (b) **background review fork** (`agent/background_review.py`) after each turn replaying the conversation asking "should any skill/memory be saved?" — routable to a cheap model (which replays a *digest* instead of the transcript), disable-able, and **deferred until GPU idle** on the managed local runtime (`defer: auto`, `defer_max_age_s: 1800`); (c) `/learn` (dir/URL/PDF/prose → skill; large sources become knowledge-base skills, re-runs fold in).

**Tool:** `skill_manage` — `create | patch (preferred) | edit | delete | write_file | remove_file`. Advisory linter on `create`/`references` writes (`incident-log-shape`, `references-sprawl` >60 files) warns, never blocks. `skills.write_approval: true` stages writes to `~/.hermes/pending/skills/<id>.json`.

**Retirement:** inactivity-triggered, not cron — at CLI start / gateway housekeeping / `hermes serve` hourly timer, requiring `interval_hours` 168 elapsed **and** `min_idle_hours` 2 idle; first run deferred one full interval. Phase 1 **deterministic, no LLM**: unused ≥30 d → `stale`, ≥90 d → `~/.hermes/skills/.archive/`; **never deletes**. Exempt: pinned, referenced by any cron job (even paused), and `use_count == 0` until ≥30 d old. Phase 2 **LLM consolidation, OFF by default** (`curator.consolidate`): a fork on `auxiliary.curator` keeps/patches/merges into umbrellas/archives — **50–100 API calls** per sweep.

**Decisive scoping rule:** the curator only touches skills whose `~/.hermes/skills/.usage.json` entry has `created_by: "agent"`, and **only the background review fork sets that marker** (origin `"background_review"` via `tools/skill_provenance.py`). Foreground `skill_manage(create)`, hand-written, and pre-marker skills are deliberately unmanaged; `hermes curator adopt` hands them over by declaration. Provenance is declared, never inferred.

**Telemetry/safety:** `.usage.json` sidecar (`use_count`, `view_count`, `patch_count`, `last_used_at`, `state`, `pinned`); bundled/hub excluded. Pre-pass `tar.gz` snapshots (`.curator_backups/<iso>/skills.tar.gz`, keep 5). Append-only `.curator_ledger.jsonl` with actor (`curator|agent|user`), action, `absorbed_into` evidence, per-file `{path, sha256}` before/after over content-addressed blobs → **single-mutation rollback** that can resurrect a hard-deleted skill. Reports at `~/.hermes/logs/curator/<ts>/{run.json,REPORT.md}`; `--dry-run`.

## 5. Cron / proactive ([cron](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron), [heartbeat](https://hermes-agent.nousresearch.com/docs/user-guide/features/heartbeat))

One `cronjob` tool, action-style; storage `~/.hermes/cron/jobs.json` (atomic, 0600, per profile). NL or cron exprs; one-shot/recurring; 0..N attached skills; delivery to origin chat / files / platform targets; **fresh session per tick**; **no-agent mode** (script, stdout verbatim, zero LLM). Model = per-job pin → `cron.model` → global default **snapshotted at creation**, so switching chat models never migrates or silently monetizes the fleet; agent tool cannot set pins. **Preflight** validates key/skills/targets → `blocked_config`, ONE alert, **no LLM call**. Cron sessions cannot create cron jobs. **`/heartbeat`**: one recurring prompt per session, injected as a plain user message only between turns while idle, missed ticks coalesce, min 60 s, survives restart. **`cron/suggestions.py`**: proposals from `catalog|blueprint|usage|integration`, **consent-first — nothing auto-creates**, dismissal latched by `dedup_key`.

## 6. Telegram bridge

Full detail already in the local authoritative doc `dsh-plugins/dsh-telegram/docs/research/hermes-agent-telegram-facts.md`; load-bearing design decisions only:

- **Same-process**: PTB `Application` (`python-telegram-bot[webhooks]==22.8`) on the asyncio loop, agent turns on `ThreadPoolExecutor(max_workers=10)`, session identity via **ContextVar** (not env) so concurrent chats never cross routing ids. Long-poll default; webhook optional and refuses to start without `TELEGRAM_WEBHOOK_SECRET`.
- **Deterministic `build_session_key()`** as single truth: `<ns>:<platform>:<chat_type>[:chat_id][:thread_id][:user]` — DM per chat, group **per user**, forum topic shared.
- **Adapter is command-agnostic**: two handlers (`TEXT & ~COMMAND`, `COMMAND`), zero `CommandHandler`s; dispatch belongs to the gateway's central `COMMAND_REGISTRY` (101 defs, 66 gateway-available).
- **Streaming ON by default** for Telegram (`config_defaults.py:878-888`) contra the stale example config; edit at ≥0.8 s or ≥24 chars; 4096 counted in **UTF-16 code units**, fence-aware; mid-stream truncates and only finalize splits (splitting mid-stream caused infinite duplication).
- Authz chain ends in **default deny** (8-digit DM pairing, 1 h TTL). Approvals: inline keyboards `ea:once|session|always|deny`, **300 s fail-closed**, **resolve-before-render**, duplicates coalesced. `standalone_sender_fn` lets cron deliver with no gateway running.

## 7. Valuable vs. bloat

**Valuable:** (1) hard char budget with a **failing** write instead of silent eviction — the model consolidates with full visibility; (2) frozen prompt snapshot for prefix-cache stability; (3) two-tier memory — tiny curated file + free unlimited FTS5 search, which is *why* the expensive tier stays small; (4) drift guard + atomic/locked writes; (5) deterministic prune phase before any LLM phase, LLM consolidation opt-in because it costs 50–100 calls; (6) **provenance declared, never inferred**, plus the `use_count == 0` grace floor; (7) content-addressed ledger with single-mutation rollback across all actors; (8) telemetry in a sidecar, never in user-authored frontmatter; (9) command-agnostic transport + central registry + deterministic `sessionKey()`; (10) approval fail-closed with resolve-before-render; cron preflight spending zero tokens on misconfigured jobs; model snapshot at creation; consent-first suggestions; (11) `write_approval` staging for the unattended loop.

**Bloat:** (1) 8 external memory providers, one active, each adding schema bloat; (2) ~15 novelty personalities on the identity path; (3) `/journey` star-map across three surfaces — the useful 10% is list/delete/edit; (4) the LLM consolidation pass (Nous defaults it off itself); (5) delivery ledger, DoH fallback IPs, polling watchdog family, `multiplex_profiles` — battle scars, add on evidence; (6) 101 commands for a chat bridge (the 60-cap is the symptom); (7) repo-wide sprawl (pets, skins, Spotify, wake-word, kanban, ACP, LSP) orthogonal to the learning loop.

**Structural critique:** the curator's jurisdiction is so narrow that a typical install is mostly *unmanaged* — the docs' own example shows 43 managed vs. 112 unmanaged. "Self-evolving skills" in practice means "the background fork's own output is garbage-collected", not "your library improves itself".

## Uncertain
- **UNCERTAIN:** whether `hermes-bots/soul.ts` authors SOUL.md programmatically (file exists, unread).
- **UNCERTAIN:** star count / exact commit SHA — GitHub fetch returned navigation chrome only.
- Snapshot predates current `main`; re-check line numbers before quoting.
