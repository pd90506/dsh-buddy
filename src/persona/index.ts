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
 * it, and only the `buddy` preset's persona row does (`prefix: '{{buddy_soul}}'`).
 * That is what keeps buddy's voice structurally out of ordinary coding sessions
 * — stronger than picking the right scope at registration time.
 * @module dsh-buddy/persona
 */
import { mkdir } from "node:fs/promises";
import { BUDDY_PRESET_ID, SOUL_VARIABLE } from "../index.ts";
import { readPersona, soulForPrompt, writePersona, type PersonaDocument } from "./soul.ts";
import { BuddyPersonaGateway, type BuddySessionSummary, type PersonaView, type PreferencesView } from "./gateway.ts";
import { resolveBuddyPaths, type BuddyPaths } from "../paths.ts";
import type { BuddyConfig } from "../config.ts";

/** Cordis plugin name used by loader diagnostics. */
export const name = "dsh-buddy-persona";

/**
 * Hard dependencies: the buddy home comes from the store, the wire from typert,
 * and the prompt plane is where the persona reaches the model at all.
 *
 * `systemPrompt` is deliberately *not* read with `ctx.get`. Cordis's `get` is
 * strict: it answers `undefined` unless the providing fiber is already active,
 * so a soft read at boot would silently register no variable, and every buddy
 * session would then fail assembly with `unknown prompt variable "{{buddy_soul}}"`.
 * Carrying the persona to the model is this row's whole purpose, and a profile
 * without a prompt plane cannot run an agent at all — so waiting is correct.
 *
 * `sessionQuery` stays soft by contrast: it is read at request time, long after
 * boot, and a profile without it simply has no conversation list.
 */
export const inject = ["buddyStore", "typert", "systemPrompt"];

/** The `systemPrompt` members this row uses. */
interface PromptPlane {
	/**
	 * Register a prompt variable scoped to the calling fiber.
	 * @param name - the reference name.
	 * @param provider - evaluated for each assembly; typed as returning a
	 * `string` rather than `string | undefined` on purpose, because rendering a
	 * section that references a valueless variable fails.
	 * @returns the exact cordis effect disposer.
	 */
	variable(name: string, provider: (context: unknown) => string): () => void;
}

/** The context members this row uses. */
interface PluginContext {
	get(name: string): unknown;
	/**
	 * Both cordis effect forms: a synchronous body returning its disposer, and
	 * the async form (`@deepseek-ai/cordis/lib/types/fiber.d.ts:51`, overload on
	 * `:159`) whose pending task cordis owns and awaits before disposing.
	 */
	effect(effect: () => (() => void) | Promise<() => void>, label?: string): unknown;
	buddyStore: {
		paths: BuddyPaths;
		lastPersonaWriteAt(): string | undefined;
		markPersonaWritten(at: string): Promise<void>;
		config(): BuddyConfig;
		updateConfig(patch: Partial<Pick<BuddyConfig, "model" | "panel">>): Promise<void>;
	};
	systemPrompt: PromptPlane;
}

/** The subset of `ctx.sessionQuery` this row reads. */
interface SessionQuery {
	listSessions(signal?: AbortSignal): Promise<
		readonly {
			header: {
				id: string;
				cwd?: string;
				agentPreset?: string;
				// Both come off the real `SessionHeader`: `childSessionMeta()` writes them
				// on every subagent child, and the filter below reads them.
				origin?: "subagent";
				delegationDepth?: number;
			};
		}[]
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

	// Whether a real write has landed yet. The initial disk read and a wire write
	// can both be in flight at once (the read is slow, or simply hasn't reached
	// its `await` boundary), and the read must never win that race: it started
	// from disk state that a write can since have made stale. Checked after the
	// initial read's `await`, this is the guard for the boot-window write/read
	// race the Task 6 report flagged as a known concern.
	let written = false;

	// Resolves once the initial disk read has landed, so no wire call — read or
	// write — is ever served (or acts on) the `{ soul: "", agents: "" }`
	// placeholder `document` starts as. Every call the gateway takes below awaits
	// this before touching `document`, which also keeps a wire write from racing
	// the boot read's own `readOr` calls against the same files.
	let resolveInitialRead: () => void = () => undefined;
	const initialRead = new Promise<void>((resolve) => {
		resolveInitialRead = resolve;
	});

	const view = (): PersonaView => ({
		soul: document.soul,
		agents: document.agents,
		home: paths.home,
		lastWriteAt: ctx.buddyStore.lastPersonaWriteAt(),
	});

	// The workspace registry is soft and read per request: `archivedSessionIds` is
	// a getter on the service, so it is read off the value `ctx.get` returns, never
	// as a bare property on `ctx`.
	const archivedSessionIds = (): Set<string> => {
		const registry = ctx.get("workspaceRegistry") as { archivedSessionIds?: readonly string[] } | undefined;
		const ids = registry?.archivedSessionIds;
		return new Set(Array.isArray(ids) ? ids.map(String) : []);
	};

	const archiveSession = async (sessionId: string): Promise<BuddySessionSummary[]> => {
		const registry = ctx.get("workspaceRegistry") as { archiveSession(id: string): Promise<void> } | undefined;
		if (registry === undefined) {
			throw new Error("dsh-buddy: the workspace registry is unavailable, cannot archive this conversation");
		}
		await registry.archiveSession(sessionId);
		return await listSessions();
	};

	const listSessions = async (): Promise<BuddySessionSummary[]> => {
		// Soft, and read at request time rather than at boot: a profile without
		// the session plane still gets a mounted row and an empty list.
		const query = ctx.get("sessionQuery") as SessionQuery | undefined;
		if (query === undefined) return [];
		const records = await query.listSessions();
		// Archived conversations drop out of the listing the same way an ordinary
		// session row does — the record is kept, only hidden. The workspace registry
		// is soft: without it, nothing is archived and nothing is filtered.
		const archived = archivedSessionIds();
		const mine = records.filter(
			(record) =>
				record.header.agentPreset === BUDDY_PRESET_ID &&
				// 后台 review 跑的是真子会话，`childSessionMeta()` 会把父的
				// `agentPreset: 'buddy'` 继承下来（design.md §4.4、§13.2 item 3）：不过滤就会每次
				// 自动总结都在 Buddy 文件夹里留一条幽灵对话。两个条件是同一个事实的两种标记，
				// 与 skills 行那两处跳过背景回合的守卫保持同一条谓词。
				record.header.origin !== "subagent" &&
				(record.header.delegationDepth ?? 0) === 0 &&
				!archived.has(record.header.id),
		);
		// Soft and per request: without the Telegram row every conversation is a web one.
		const telegram = ctx.get("buddyTelegram") as { telegramSessionIds(): Promise<string[]> } | undefined;
		const fromTelegram = new Set((await telegram?.telegramSessionIds().catch(() => [])) ?? []);
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
					source: fromTelegram.has(record.header.id) ? "telegram" : "web",
				};
			}),
		);
		return summaries.sort((first, second) => second.updatedAt - first.updatedAt);
	};

	const preferences = async (): Promise<PreferencesView> => {
		const config = ctx.buddyStore.config();
		// Derived from the buddy home so it honours a user-set `buddy.home`: buddy
		// conversations run in `<home>/main/workspace`, a sibling of the authored
		// files, never their directory.
		const conversationCwd = resolveBuddyPaths(config.home).workspace;
		// Created here, not by the caller: the browser cannot mkdir, and the session
		// store rejects a cwd that does not exist.
		await mkdir(conversationCwd, { recursive: true });
		return { model: { ...config.model }, panel: { sections: { ...config.panel.sections } }, conversationCwd };
	};

	// Exactly once: the gateway registers the `dsh-buddy` typert package, and a
	// duplicate registration throws. A missing `typert` throws out of here too,
	// deliberately uncaught — a row whose endpoints are invisible on the wire is
	// a failure to report, not to survive.
	new BuddyPersonaGateway(ctx, {
		readPersona: async () => {
			await initialRead;
			return view();
		},
		writePersona: async (patch) => {
			await initialRead;
			document = await writePersona(paths, patch);
			written = true;
			await ctx.buddyStore.markPersonaWritten(new Date().toISOString());
			return view();
		},
		listSessions,
		archiveSession,
		readPreferences: preferences,
		writePreferences: async (patch) => {
			await ctx.buddyStore.updateConfig(patch);
			return await preferences();
		},
		currentConfig: () => ctx.buddyStore.config(),
	});

	// A variable rather than a section: inert until the buddy preset's persona
	// row references `{{buddy_soul}}`. The renderer does not re-scan substituted
	// values, so a persona containing `{{` is carried through verbatim.
	//
	// Registered before the initial read, and `soulForPrompt` is non-empty on
	// every path including this one: the renderer throws on a referenced
	// variable with no value for the assembly, and an empty value would shadow
	// the deployment persona away without putting anything in its place.
	ctx.effect(
		() => ctx.systemPrompt.variable(SOUL_VARIABLE, () => soulForPrompt(document)),
		"dsh-buddy: soul prompt variable",
	);

	// Async effect form: cordis owns the pending read and awaits it before
	// running the disposer, so a dispose landing mid-read still unwinds cleanly.
	// `readPersona` degrades rather than throwing, so a damaged persona costs the
	// authored voice for this run and never the row.
	ctx.effect(async (): Promise<() => void> => {
		const loaded = await readPersona(paths);
		// A write gated on `initialRead` cannot land before this point, but the
		// flag stays as the documented invariant rather than an unstated ordering
		// assumption: whichever landed first, on disk, must be what survives.
		if (!written) document = loaded;
		resolveInitialRead();
		return () => undefined;
	}, "dsh-buddy: persona load");
}
