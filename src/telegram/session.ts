/**
 * The chat ↔ session binding, and the turn it produces.
 *
 * Three facts from `docs/research/dsh-host-api-facts.md` shape this module:
 *
 * 1. **`agents.create()` is the only path that persists.** `sessions.create()`
 *    alone leaves a session in memory, invisible to the GUI and gone on restart,
 *    so every Telegram session is created through the agent registry.
 * 2. **`cwd` is immutable after creation**, and a session *without* one is
 *    filtered out of the GUI list. Telegram sessions therefore always carry an
 *    absolute `cwd` — that is what makes them resumable and visible.
 * 3. **`followup()` returns void and there is no per-turn promise.** Completion
 *    is `whenIdle()`, which waits for *whole-agent* quiescence: a second message
 *    queued on the same session extends it. So one chat runs one turn at a time,
 *    and the reply is folded from the turn that opened after our own baseline
 *    seq — a GUI message typed into the same session meanwhile belongs to a later
 *    turn and must not be delivered to Telegram.
 *
 * The agent/session surfaces are typed structurally rather than imported: this
 * is an out-of-tree plugin whose `@deepseek-ai/*` copies must stay external, and
 * only a documented slice of each object is used here.
 * @module dsh-telegram/session
 */
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { brandString } from "@deepseek-ai/dsh-brand";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { SessionId } from "@deepseek-ai/dsh-session";
import { resolveModelSelection, type ModelSelection as BuddyModelSelection } from "../model-selection.ts";
import type { AttachmentRefLike } from "./telegram/media.ts";
import type { ChatRecord, TelegramStore } from "./store.ts";

/** One event as it comes back from `session.snapshotEvents()`. */
export interface SessionEventLike {
	readonly seq: number;
	readonly type: string;
	readonly data: unknown;
}

/** The slice of a harness session this module uses. */
export interface SessionLike {
	/** Log length; used as a turn baseline. */
	readonly seq: number;
	/** Events at or after `fromSeq`. */
	snapshotEvents(fromSeq?: number): readonly SessionEventLike[];
	/**
	 * Storage metadata, read for two things: the session's working directory
	 * (media paths are resolved against it) and the agent preset it was composed
	 * from (a resume must join the same one).
	 */
	readonly header?:
		| {
				readonly cwd?: string | undefined;
				readonly agentPreset?: string | undefined;
		  }
		| undefined;
}

/** The slice of a harness agent this module uses. */
export interface AgentLike {
	readonly session: SessionLike;
	readonly status: string;
	followup(message: unknown): void;
	steer(message: unknown): void;
	cancel(cause: { kind: "user" }): void;
	whenIdle(): Promise<void>;
}

/** A chat-local model choice. */
export interface ModelSelection {
	readonly provider: string;
	readonly model: string;
	readonly reasoningEffort?: string | undefined;
}

/** A chat resolved to a live agent. */
export interface ResolvedChat {
	/** The session backing this chat. */
	readonly sessionId: SessionId;
	/** The live agent driving it. */
	readonly agent: AgentLike;
	/** True when this call created the session (and labelled it). */
	readonly created: boolean;
}

/** Services this module needs from the plugin context. */
export interface SessionDeps {
	/** `ctx.get` for the optional services below. */
	readonly get: (name: string) => unknown;
	/** The opened storage domain. */
	readonly store: TelegramStore;
	/** Diagnostic sink; never receives the token. */
	readonly log: (line: string) => void;
	/** The only preset this manager composes sessions from. */
	readonly presetId: string;
	/** Buddy's default model, read at creation time. */
	readonly buddyModel: () => BuddyModelSelection | undefined;
}

/** Handle returned by `agents.create` / `agents.resume`. */
interface AgentHandleLike {
	readonly agent: AgentLike;
	dispose(): void;
}

/** The `ctx.agents` slice used here. */
interface AgentRegistryLike {
	get(id: SessionId): AgentLike | undefined;
	create(options: Record<string, unknown>): Promise<AgentHandleLike>;
	resume(options: Record<string, unknown>): Promise<AgentHandleLike>;
}

/** The `ctx.sessions` slice used here. */
interface SessionStoreLike {
	flush(session: unknown): Promise<void>;
}

/** One preset id, as the roster reports it. */
export interface AgentPresetRef {
	/** The resolved preset id. */
	readonly id: string;
}

/**
 * The `ctx.agentPresets` slice used here.
 *
 * Both members are load-bearing: `resolve` is used only to confirm Buddy's own
 * preset id resolves (this manager always passes one, never `undefined`), and
 * `mount` is the harness's one supported way to bring a preset into an agent —
 * it must be called from the agent factory's `setup` hook, while the agent is
 * still unpublished, so a broken preset rolls the creation back instead of
 * publishing a bare agent.
 */
export interface AgentPresetsLike {
	/** Preset mounted when a caller names none. */
	readonly defaultId: string;
	/**
	 * Resolve a preset id, or the configured default when omitted.
	 * @param id - requested preset, or undefined for the configured default.
	 */
	resolve(id?: string): Promise<AgentPresetRef>;
	/**
	 * Ensure the preset's standing mount and parent this agent's scope to it.
	 * @param agentCtx - the unpublished agent's scoped context.
	 * @param id - the preset to join.
	 */
	mount(agentCtx: unknown, id?: string): Promise<unknown>;
}

/** The pre-publication hook the agent factory calls while composing an agent. */
type AgentSetupHook = (agentCtx: unknown, agent: unknown) => Promise<void>

/** Mutable selection ref handed to `installModelSelection`. */
interface SelectionRefLike {
	current: ModelSelection | undefined;
	assembled: ModelSelection | undefined;
}

/**
 * Concatenate the text blocks of one message.
 * @param message - an assistant message from a log event.
 * @returns its visible text, with non-text blocks dropped.
 */
export function messageText(message: unknown): string {
	const content = (message as { content?: readonly unknown[] } | undefined)?.content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			const typed = block as { type?: string; text?: string };
			return typed.type === "text" ? typed.text ?? "" : "";
		})
		.join("");
}

/**
 * Fold a turn's assistant output out of a session log.
 *
 * The first `turn/start` at or after `baseline` is the turn this delivery owns,
 * and only its events are folded. A GUI message typed into the same session
 * meanwhile belongs to a later turn and must not be delivered to Telegram — that
 * is acceptance criterion AC-13, and it is also why the older "last message
 * after the baseline" fallback is gone: it could hand the GUI's answer to the
 * phone.
 * @param events - events from `snapshotEvents(baseline)`.
 * @param baseline - the log length captured before the message was queued.
 * @returns the reply text, possibly empty.
 */
export function foldTurnOutput(events: readonly SessionEventLike[], baseline: number): string {
	return foldTurnParts(events, baseline)
		.flatMap((part) => (part.kind === "text" ? [part.text] : []))
		.join("\n\n");
}

/** One image or file a turn produced, and how to find its bytes. */
export type TurnMediaRef =
	| { readonly kind: "attachment"; readonly attachment: AttachmentRefLike }
	| { readonly kind: "path"; readonly path: string };

/**
 * One piece of a turn's output, in reading order.
 *
 * Text and media are separate parts because they leave as different Bot API
 * calls: text is rendered and split, media is uploaded, and their order is the
 * order the agent wrote them in — a chart appears where the sentence pointing at
 * it appears, not in a pile at the end.
 */
export type TurnPart =
	| { readonly kind: "text"; readonly text: string }
	| {
			readonly kind: "media";
			/** Which signal produced it: an explicit `present`, or a tool result. */
			readonly via: "presented" | "tool";
			readonly source: TurnMediaRef;
			/** Alt text (markdown) or the declaration's caption, when either exists. */
			readonly caption?: string | undefined;
	  };

/** Tools whose images the agent looked at rather than produced. */
const INSPECTION_TOOLS: readonly string[] = ["read_image"];

/**
 * Fold a turn into the parts that will be delivered.
 *
 * Three signals can carry media, and all three are explicit in the log:
 *
 * 1. `deliverables/presented` — the agent called `present`, which is the
 *    harness's own "these files are for the user" declaration.
 * 2. `tool/result` blocks of type `image` — a generated chart or picture; the
 *    bytes live in the attachment store, so no path is needed.
 * 3. (Text-level `![alt](src)` references are lifted out by the renderer, not
 *    here: they are prose, and only the renderer knows where in the sentence.)
 *
 * Images a tool only *read* are dropped: `read_image` exists so the model can
 * look at a file, and forwarding every screenshot it inspects would turn the
 * chat into a log.
 * @param events - events from `snapshotEvents(baseline)`.
 * @param baseline - the log length captured before the message was queued.
 * @returns the text and media parts, in log order.
 */
export function foldTurnParts(events: readonly SessionEventLike[], baseline: number): TurnPart[] {
	const owned = ownedTurn(events, baseline);
	if (owned === undefined) return [];
	const parts: TurnPart[] = [];
	const toolNames = new Map<string, string>();

	for (const event of events) {
		if (event.seq < baseline) continue;
		const data = asRecord(event.data);
		if (data === undefined || numberField(data, "turn") !== owned) continue;

		if (event.type === "tool/call") {
			const callId = stringField(data, "callId");
			const name = stringField(data, "name");
			if (callId !== undefined && name !== undefined) toolNames.set(callId, name);
			continue;
		}

		if (event.type === "assistant/message") {
			const text = messageText((data as { message?: unknown }).message);
			if (text.trim() !== "") appendText(parts, text);
			continue;
		}

		if (event.type === "deliverables/presented") {
			for (const file of presentedFiles(data)) parts.push(file);
			continue;
		}

		if (event.type === "tool/result") {
			for (const image of toolImages(data, toolNames)) parts.push(image);
		}
	}

	return parts;
}

/** Append text to the last text part, or start a new one. */
function appendText(parts: TurnPart[], text: string): void {
	const last = parts[parts.length - 1];
	if (last?.kind === "text") {
		parts[parts.length - 1] = { kind: "text", text: `${last.text}\n\n${text}` };
		return;
	}
	parts.push({ kind: "text", text });
}

/** The turn this delivery owns: the first one that opened at or after `baseline`. */
function ownedTurn(events: readonly SessionEventLike[], baseline: number): number | undefined {
	for (const event of events) {
		if (event.type !== "turn/start" || event.seq < baseline) continue;
		return numberField(asRecord(event.data) ?? {}, "turn");
	}
	return undefined;
}

/** The files one `deliverables/presented` event declared. */
function presentedFiles(data: Record<string, unknown>): TurnPart[] {
	const files = (data as { files?: unknown }).files;
	if (!Array.isArray(files)) return [];
	const parts: TurnPart[] = [];
	for (const entry of files) {
		const file = asRecord(entry);
		const path = file === undefined ? undefined : stringField(file, "path");
		if (path === undefined || path === "") continue;
		const description = stringField(file ?? {}, "description");
		parts.push({
			kind: "media",
			via: "presented",
			source: { kind: "path", path },
			...(description === undefined || description === "" ? {} : { caption: description }),
		});
	}
	return parts;
}

/** The image blocks inside one tool result, minus the inspection tools. */
function toolImages(data: Record<string, unknown>, toolNames: ReadonlyMap<string, string>): TurnPart[] {
	const message = asRecord((data as { message?: unknown }).message);
	if (message === undefined) return [];
	const parts: TurnPart[] = [];
	collectImages((message as { content?: unknown }).content, undefined, toolNames, parts);
	return parts;
}

/**
 * Walk content blocks — `tool-result` nests its own — collecting images.
 *
 * The call id lives on the enclosing `tool-result` block, not on the image, so it
 * is carried down the recursion: without it the tool behind an image is unknown
 * and an inspection result would be forwarded.
 * @param content - the block array to walk.
 * @param callId - the enclosing tool result's call id, when there is one.
 * @param toolNames - call id to tool name, from this turn's `tool/call` events.
 * @param out - collects the media parts.
 */
function collectImages(
	content: unknown,
	callId: string | undefined,
	toolNames: ReadonlyMap<string, string>,
	out: TurnPart[],
): void {
	if (!Array.isArray(content)) return;
	for (const entry of content) {
		const block = asRecord(entry);
		if (block === undefined) continue;
		const type = stringField(block, "type");
		if (type === "tool-result") {
			collectImages(block["content"], stringField(block, "toolCallId") ?? callId, toolNames, out);
			continue;
		}
		if (type !== "image") continue;
		const attachment = asRecord(block["attachment"]);
		if (attachment === undefined) continue;
		const attachmentId = stringField(attachment, "attachmentId");
		const mediaType = stringField(attachment, "mediaType");
		if (attachmentId === undefined || mediaType === undefined) continue;
		const owner = stringField(block, "toolCallId") ?? callId;
		const tool = owner === undefined ? undefined : toolNames.get(owner);
		if (tool !== undefined && INSPECTION_TOOLS.includes(tool)) continue;
		const bytes = numberField(attachment, "bytes") ?? 0;
		const width = numberField(attachment, "width");
		const height = numberField(attachment, "height");
		const name = stringField(attachment, "name");
		out.push({
			kind: "media",
			via: "tool",
			source: {
				kind: "attachment",
				attachment: {
					attachmentId,
					mediaType,
					bytes,
					...(width === undefined ? {} : { width }),
					...(height === undefined ? {} : { height }),
					...(name === undefined ? {} : { name }),
				},
			},
			...(name === undefined || name === "" ? {} : { caption: name }),
		});
	}
}

/** Narrow an unknown value to a plain record. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

/** A numeric field of a record, when it holds one. */
function numberField(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A non-empty string field of a record, when it holds one. */
function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Owns every chat → session binding, the live agents behind them, and the
 * chat-local model selections.
 */
export class SessionManager {
	readonly #deps: SessionDeps;
	readonly #handles = new Map<string, AgentHandleLike>();
	readonly #selections = new Map<string, SelectionRefLike>();

	/**
	 * @param deps - context access, the storage domain, and a logger.
	 */
	constructor(deps: SessionDeps) {
		this.#deps = deps;
	}

	/** The registry, or a clear failure when the profile lacks it. */
	#agents(): AgentRegistryLike {
		const agents = this.#deps.get("agents") as AgentRegistryLike | undefined;
		if (agents === undefined) throw new Error("telegram: the agents service is unavailable");
		return agents;
	}

	/**
	 * Resolve a chat to a live agent, creating the session on first contact.
	 *
	 * Order matters: a session already live in this process must be adopted
	 * through `agents.get`. Calling `resume` on it would reject with
	 * `SessionAlreadyOwnedError`, because a live agent holds the single write
	 * handle — and the GUI, which shares this process, may be holding it.
	 * @param chatId - the Telegram chat id, as a string.
	 * @param chatTitle - label used for the session title.
	 * @param defaultCwd - absolute directory for a newly created session.
	 * @returns the live agent plus whether it was just created.
	 */
	async ensure(chatId: string, chatTitle: string, defaultCwd: string): Promise<ResolvedChat> {
		const agents = this.#agents();
		const record = this.#deps.store.chats.get(chatId);
		if (record !== undefined) {
			const sessionId = brandString<SessionId>(record.sessionId);
			const live = agents.get(sessionId);
			if (live !== undefined) return { sessionId, agent: live, created: false };
			try {
				const handle = await agents.resume({
					resumeSessionId: sessionId,
					...this.#agentOptions(selectionOf(record) ?? this.#defaultSelection()),
					// A resume must rejoin the preset the session recorded: the preset
					// decides which tools and prompt sections the agent has, and a
					// session resumed without one would silently lose all of them.
					setup: this.#setupFor(() => this.#selectionRef(sessionId, record), undefined),
				});
				this.#adopt(record.sessionId, handle);
				return { sessionId, agent: handle.agent, created: false };
			} catch (error) {
				if (!isUnknownSession(error)) throw error;
				this.#deps.log(`chat ${chatId}: stored session ${record.sessionId} is gone; starting a new one`);
			}
		}
		return this.#create(chatId, chatTitle, defaultCwd);
	}

	/**
	 * Queue a message and wait for the turn it starts.
	 * @param resolved - the chat's live agent.
	 * @param text - the user's message.
	 * @returns the turn's text and media parts, in reading order.
	 */
	async runTurn(resolved: ResolvedChat, text: string): Promise<readonly TurnPart[]> {
		const baseline = resolved.agent.session.seq;
		resolved.agent.followup(createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } }));
		await resolved.agent.whenIdle();
		await this.#flush(resolved.agent);
		return foldTurnParts(resolved.agent.session.snapshotEvents(baseline), baseline);
	}

	/**
	 * Inject a message into the turn already running.
	 * @param resolved - the chat's live agent.
	 * @param text - the user's message.
	 */
	steer(resolved: ResolvedChat, text: string): void {
		resolved.agent.steer(createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } }));
	}

	/**
	 * Cancel whatever the chat is running.
	 * @param resolved - the chat's live agent.
	 */
	cancel(resolved: ResolvedChat): void {
		resolved.agent.cancel({ kind: "user" });
	}

	/**
	 * Record a chat-local model choice and apply it to the live agent.
	 *
	 * Deliberately not `sessionController.selectModel`: that path also calls
	 * `agentDefaultModel.saveSelection`, which would move the *global* default
	 * from a phone command. The selection is stored in the chat's own record and
	 * reinstalled on resume.
	 * @param chatId - the Telegram chat id, as a string.
	 * @param resolved - the chat's live agent, when one is attached.
	 * @param selection - the newly chosen model.
	 */
	async setSelection(chatId: string, resolved: ResolvedChat | undefined, selection: ModelSelection): Promise<void> {
		const record = this.#deps.store.chats.get(chatId);
		if (record !== undefined) {
			await this.#deps.store.chats.put(chatId, {
				...record,
				provider: selection.provider,
				model: selection.model,
				...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
				updatedAt: new Date().toISOString(),
			});
		}
		if (resolved === undefined) return;
		const ref = this.#selectionRef(resolved.sessionId, record, selection);
		ref.current = selection;
	}

	/**
	 * Release one chat's agent handle (used by `/new`).
	 *
	 * The session itself stays on disk — `/new` starts a fresh conversation, it
	 * does not delete history — but this process stops driving it.
	 * @param sessionId - the session to release.
	 */
	forget(sessionId: string): void {
		const handle = this.#handles.get(sessionId);
		if (handle !== undefined) {
			try {
				handle.dispose();
			} catch (error) {
				this.#deps.log(`agent release failed: ${(error as Error).message}`);
			}
			this.#handles.delete(sessionId);
		}
		this.#selections.delete(sessionId);
	}

	/** Drop every owned agent handle (plugin shutdown). */
	dispose(): void {
		for (const handle of this.#handles.values()) {
			try {
				handle.dispose();
			} catch (error) {
				this.#deps.log(`agent dispose failed: ${(error as Error).message}`);
			}
		}
		this.#handles.clear();
	}

	/**
	 * The deployment's global default model selection.
	 *
	 * A session created without `agentOptions` gets an empty provider/model pair,
	 * and the first request then fails to resolve a route. Every session this
	 * plugin creates therefore starts from the same selection the GUI would
	 * apply, unless the chat has already chosen one of its own or Buddy has its
	 * own default configured.
	 * @returns the global default selection, when the service is mounted and configured.
	 */
	#globalSelection(): ModelSelection | undefined {
		const service = this.#deps.get("agentDefaultModel") as { currentSelection(): ModelSelection } | undefined;
		if (service === undefined) return undefined;
		try {
			const selection = service.currentSelection();
			return selection.provider === "" || selection.model === "" ? undefined : selection;
		} catch (error) {
			this.#deps.log(`default model unavailable: ${(error as Error).message}`);
			return undefined;
		}
	}

	/**
	 * The model a session starts on when its chat has not chosen one: Buddy's
	 * default, then the deployment's global default.
	 *
	 * `resolveModelSelection` takes `../model-selection.ts`'s own `ModelSelection`
	 * shape, which (unlike this module's) does not admit an explicit
	 * `reasoningEffort: undefined` under `exactOptionalPropertyTypes` — so the
	 * global selection is rebuilt at this boundary rather than widening either
	 * type's shape.
	 * @returns the selection, when any is configured.
	 */
	#defaultSelection(): ModelSelection | undefined {
		const global = this.#globalSelection();
		return resolveModelSelection(
			undefined,
			this.#deps.buddyModel(),
			global === undefined
				? undefined
				: {
						provider: global.provider,
						model: global.model,
						...(global.reasoningEffort === undefined ? {} : { reasoningEffort: global.reasoningEffort }),
					},
		);
	}

	/** The options one `agents.create`/`resume` call needs to pin a model. */
	#agentOptions(selection: ModelSelection | undefined): Record<string, unknown> {
		if (selection === undefined) return {};
		return {
			agentOptions: {
				provider: selection.provider,
				model: selection.model,
				...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
			},
		};
	}

	/** Reuse an existing selection ref, or start one from the stored record. */
	#selectionRef(sessionId: SessionId, record: ChatRecord | undefined, override?: ModelSelection): SelectionRefLike {
		const key = String(sessionId);
		const existing = this.#selections.get(key);
		const seed = override ?? selectionOf(record);
		if (existing !== undefined) {
			if (override !== undefined) existing.current = override;
			return existing;
		}
		const ref: SelectionRefLike = { current: seed, assembled: undefined };
		this.#selections.set(key, ref);
		return ref;
	}

	/** Track a handle so shutdown can release it, replacing any earlier one. */
	#adopt(sessionId: string, handle: AgentHandleLike): void {
		const previous = this.#handles.get(sessionId);
		if (previous !== undefined && previous !== handle) {
			try {
				previous.dispose();
			} catch {
				// A stale handle that refuses to dispose is not worth failing over.
			}
		}
		this.#handles.set(sessionId, handle);
	}

	/** Create a fresh session for a chat and remember the binding. */
	async #create(chatId: string, chatTitle: string, defaultCwd: string): Promise<ResolvedChat> {
		// Resolved before anything else: a profile without Buddy's preset must
		// refuse the whole creation rather than leave a directory, a handle, or a
		// chat binding behind for a session that was never composed as Buddy.
		const presetId = await this.#presetId();
		const agents = this.#agents();
		const sessionId = brandString<SessionId>(`session-${randomUUID()}`);
		// `agents.create()` does not create the directory the way the session
		// controller's own path does, so it is created here first.
		await mkdir(defaultCwd, { recursive: true });
		const ref = this.#selectionRef(sessionId, undefined);
		if (ref.current === undefined) ref.current = this.#defaultSelection();
		const handle = await agents.create({
			sessionId,
			meta: { cwd: defaultCwd, agentPreset: presetId },
			...this.#agentOptions(ref.current),
			setup: this.#setupFor(() => ref, presetId),
		});
		this.#adopt(String(sessionId), handle);
		await this.#deps.store.chats.put(chatId, {
			sessionId: String(sessionId),
			...(ref.current === undefined
				? {}
				: {
						provider: ref.current.provider,
						model: ref.current.model,
						...(ref.current.reasoningEffort === undefined ? {} : { reasoningEffort: ref.current.reasoningEffort }),
					}),
			updatedAt: new Date().toISOString(),
		});
		await this.#deps.store.origins.put(String(sessionId), { chatId, createdAt: new Date().toISOString() });
		this.#label(handle.agent, chatTitle);
		return { sessionId, agent: handle.agent, created: true };
	}

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

	/** The preset roster, or undefined in a profile that mounts none. */
	#presets(): AgentPresetsLike | undefined {
		return this.#deps.get("agentPresets") as AgentPresetsLike | undefined;
	}

	/**
	 * The pre-publication setup hook for one agent.
	 *
	 * Two things happen here, and both must: the chat-local model selection is
	 * installed, and the agent joins Buddy's fixed agent preset. The harness
	 * documents this hook as the only supported mount site — it runs while the
	 * agent is still unpublished, so a rejected composition rolls the whole
	 * creation back rather than publishing an agent that is missing its tools.
	 * @param refOf - lazily builds the model-selection ref (the ref must be the
	 * one this manager keeps updating, so it is looked up per call).
	 * @param fallbackPresetId - id to join when the session's header records none.
	 * @returns the hook handed to `agents.create` / `agents.resume`.
	 */
	#setupFor(refOf: () => SelectionRefLike, fallbackPresetId: string | undefined): AgentSetupHook {
		return async (agentCtx: unknown, agent: unknown): Promise<void> => {
			installModelSelection(agentCtx as never, refOf() as never);
			const presets = this.#presets();
			if (presets === undefined) {
				throw new Error("Buddy preset unavailable: this profile mounts no agent preset roster");
			}
			// The header wins: a session created under Buddy's preset may later be
			// resumed after the id changed, and it must keep its own preset.
			const id = storedPreset(agent) ?? fallbackPresetId ?? (await this.#presetId());
			await presets.mount(agentCtx, id);
		};
	}

	/** Best-effort title, so the GUI groups Telegram sessions recognizably. */
	#label(agent: AgentLike, chatTitle: string): void {
		const titles = this.#deps.get("sessionTitle") as
			| { rename(session: unknown, title: string): unknown }
			| undefined;
		if (titles === undefined) return;
		try {
			titles.rename(agent.session, `Telegram: ${chatTitle}`);
		} catch (error) {
			this.#deps.log(`session title failed: ${(error as Error).message}`);
		}
	}

	/** Durability barrier before the log is read back. */
	async #flush(agent: AgentLike): Promise<void> {
		const sessions = this.#deps.get("sessions") as SessionStoreLike | undefined;
		if (sessions === undefined) return;
		try {
			await sessions.flush(agent.session);
		} catch (error) {
			this.#deps.log(`session flush failed: ${(error as Error).message}`);
		}
	}
}

/** The stored model choice, when the record carries a complete one. */
function selectionOf(record: ChatRecord | undefined): ModelSelection | undefined {
	if (record?.provider === undefined || record.model === undefined) return undefined;
	return {
		provider: record.provider,
		model: record.model,
		...(record.reasoningEffort === undefined ? {} : { reasoningEffort: record.reasoningEffort }),
	};
}

/**
 * The agent preset a session recorded in its header.
 *
 * Absent for every session created before presets were attached, and for sessions
 * whose deployment mounts no roster at all.
 * @param agent - the agent whose session header is read.
 * @returns the preset id, or undefined when the header carries none.
 */
function storedPreset(agent: unknown): string | undefined {
	const value = (agent as { session?: { header?: { agentPreset?: unknown } } }).session?.header?.agentPreset;
	return typeof value === "string" && value !== "" ? value : undefined;
}

/** Whether a resume failure means "that session is not on disk". */
function isUnknownSession(error: unknown): boolean {
	const name = (error as { name?: string }).name;
	const code = (error as { code?: string }).code;
	return name === "SessionPersistenceNotFoundError" || code === "not-found";
}
