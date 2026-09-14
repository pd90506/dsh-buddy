/**
 * The preset row `dsh-buddy-skills-agent`: every contribution a buddy session
 * sees, registered from the preset's own context.
 *
 * Cordis files a registration into the layer of the **calling** context's scope.
 * That single fact is this row's whole reason to exist: the provider, the
 * `skill_manage` tool, the two event listeners and the `/refine` command must
 * land in the buddy preset's layer, and registered from the host row
 * (`src/skills/index.ts`) instead they would land in the global layer — where
 * every ordinary coding session would see Buddy's skills. The host row owns the
 * *state* that must outlive one conversation (the skills root, the three domain
 * tables, the review coordinator, the write path's jurisdiction); this row owns
 * the registrations that state is reached through.
 *
 * Four things shape the code more than the method list does:
 *
 * - **No `inject`, and no host row is fatal.** An `inject` on `buddySkills`
 *   would leave the whole preset composition *waiting* whenever the dsh-buddy
 *   plugin is not installed, taking the persona, the shell tools and everything
 *   else in `agent.cordis.yml` down with it. The host service is therefore read
 *   with `ctx.get`, and its absence degrades the row to a **silent, total
 *   no-op** — no provider, no tool, no listeners, no command, and no throw. The
 *   host row's own ten-second heartbeat is what makes that state visible from
 *   the side that can see it.
 * - **The three registries are soft too.** `dsh-skill` and `dsh-commands` are
 *   not in this package's dependency closure at all, and only `dsh-tools`'
 *   `defineTool` is borrowed from that package, so each registry is declared
 *   locally as the minimal interface this row calls. `dsh-tools` must be
 *   imported rather than re-implemented: `defineTool` compiles the parameter
 *   schema and wraps `execute`, so a plain object literal is not a substitute,
 *   and the package is declared in `package.json` so `build.mjs`'s
 *   `dependencies ∪ peerDependencies` keeps it external.
 * - **The provider factory's control is the only invalidation entry point.**
 *   There is no public `ctx.skills.invalidate()`: the `control` passed to the
 *   factory is registration-scoped and disposed with it. The registry caches
 *   completed catalogs, so a newly written skill stays invisible until
 *   `control.invalidate()` runs — which is why the control is captured once at
 *   registration and called after every successful write.
 * - **The tool forwards; it does not decide.** Every mutation goes through
 *   `ctx.buddySkills.manage`, which is the only place the snapshots, the ledger
 *   and the jurisdiction guard live. The action set is the host row's own
 *   {@link SKILL_MANAGE_ACTIONS}, so the tool's vocabulary and the write path's
 *   cannot drift — and `visibility` is in neither, because only the panel may
 *   raise a skill's scope.
 * @module dsh-buddy/skills-agent
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createBuddyProvider, createPromotedProvider } from "../skills/provider.ts";
import { SKILL_MANAGE_ACTIONS } from "../skills/index.ts";

/** Cordis plugin name used by loader diagnostics. */
export const name = "dsh-buddy-skills-agent";

// Deliberately no `inject` export: this row has to mount inside the preset even
// when the host skills row is absent, so every service it reaches is read with
// `ctx.get` and a missing one degrades the row instead of blocking the mount.
// A preset whose skills half is missing still has Buddy's persona and tools;
// a preset that never mounts has neither.

/** The lifecycle and invalidation control one provider registration borrows. */
interface SkillProviderControl {
	/** Aborts when the exact registration is disposed. */
	readonly signal: AbortSignal;
	/** Invalidate completed catalogs, while the registration remains active. */
	invalidate(): void;
}

/** The `ctx.skills` slice this row registers against. */
interface SkillRegistry {
	/**
	 * Borrow one same-process provider into the calling context's layer.
	 * @param create - the factory, handed this registration's control.
	 * @returns the disposer that unregisters it.
	 */
	registerProvider(create: (control: SkillProviderControl) => { readonly name: string }): () => void;
}

/** The `ctx.tools` slice this row registers against. */
interface ToolRegistry {
	/**
	 * Add one tool definition to the calling context's layer.
	 * @param definition - the compiled definition, from `defineTool`.
	 * @returns the disposer that removes it.
	 */
	register(definition: unknown): () => void;
}

/** One `/refine` invocation, reduced to what this row reads. */
interface CommandInvocation {
	/** The exact agent whose UI received the command. */
	readonly agent: SkillPlaneAgent;
	/** The exact text following the command name, including separator whitespace. */
	readonly rawInput: string;
}

/** The command registry's verdict, inline as the shipped union. */
type CommandResult = { readonly kind: "success"; readonly text?: string } | { readonly kind: "error"; readonly text: string };

/** The `ctx.commands` slice this row registers against. */
interface CommandRegistry {
	/**
	 * Register one human-facing command in the calling context's layer.
	 * @param definition - name, description and handler.
	 * @returns the disposer that unregisters it.
	 */
	register(definition: {
		readonly name: string;
		readonly description: string;
		handler(invocation: CommandInvocation): CommandResult | Promise<CommandResult>;
	}): () => void;
}

/** Anything the host service accepts as the actor of a write. */
interface SkillPlaneAgent {
	readonly id: string;
}

/**
 * The `ctx.buddySkills` surface this row drives.
 *
 * Every member is one the host row really publishes
 * (`src/skills/index.ts`); nothing is invented here, and nothing that could be
 * reached another way is added. The field list is also the row's contract with
 * Task 13: a rename there that this row did not follow fails the typecheck
 * rather than silently disabling a listener.
 */
interface SkillsPlane {
	/** The absolute skills root both providers are built over. */
	skillsRoot(): string;
	/** Count one model round of a conversation toward its next review. */
	noteStep(sessionId: string): void;
	/** Reset a conversation's counter because the model curated a skill itself. */
	noteSkillManageCalled(sessionId: string): void;
	/** The post-commit end of a turn: maybe start a review. */
	onTurnEnd(input: {
		readonly sessionId: string;
		readonly reason: { readonly kind: string };
		readonly origin?: string | undefined;
		readonly delegationDepth?: number | undefined;
	}): Promise<void>;
	/** Report that this row mounted, clearing the host row's not-synced notice. */
	noteAgentRowMounted(): void;
	/** Record one skill load: the usage bump and the read mark together. */
	noteSkillUsed(sessionId: string, skill: string): Promise<void>;
	/** Apply one batch of `skill_manage` operations through the write path. */
	manage(
		actor: SkillPlaneAgent,
		operations: readonly unknown[],
	): Promise<{ readonly success: boolean; readonly message: string }>;
	/** Start an explicit review for the `/refine` command. */
	refine(agent: SkillPlaneAgent, focus: string): Promise<void>;
}

/** The context members this row uses. */
interface AgentContext {
	get(name: string): unknown;
	effect(effect: () => (() => void) | Promise<() => void>, label?: string): unknown;
	on(name: string, listener: (...args: never[]) => unknown, options?: { prepend?: boolean }): unknown;
}

/** One session event, reduced to the two types this row forwards. */
interface SessionEvent {
	readonly type: string;
	readonly data?: { readonly reason?: { readonly kind?: string } } | undefined;
}

/** The session a `session/event` carries, reduced to the header this row reads. */
interface LiveSession {
	readonly header: {
		readonly id: string;
		readonly origin?: "subagent" | undefined;
		readonly delegationDepth?: number | undefined;
	};
}

/** One tool execution, reduced to what the two listeners read. */
interface ToolExecution {
	readonly name: string;
	readonly arguments?: unknown;
	readonly agent?: { readonly id?: string } | undefined;
}

/** A settled dispatch outcome; the post-execute watermark passes it through. */
type ToolDispatchOutcome = { readonly isError: boolean };

/** The one tool this row registers. */
const TOOL_NAME = "skill_manage";

/** The one command this row registers. */
const COMMAND_NAME = "refine";

/** The command's one-line description, as the discovery UI shows it. */
const COMMAND_DESCRIPTION = "Review this conversation and let Buddy update its skills";

/**
 * Register the provider, the tool, the listeners and the command.
 *
 * Everything here goes through `ctx.effect` (or `ctx.on`, which is an effect
 * itself), so unmounting the preset releases the whole contribution and a reload
 * can mount it again.
 * @param ctx - the preset row's context; every registration lands in its layer.
 */
export function apply(ctx: AgentContext): void {
	const plane = ctx.get("buddySkills") as SkillsPlane | undefined;
	// No host row: this row contributes nothing at all. Not an error — the
	// dsh-buddy plugin may simply not be installed, and the preset's other rows
	// are unaffected by that. See the module header for why this is silent.
	if (plane === undefined) return;

	// The registrar, read once and hoisted above the effects so both provider
	// registrations close over the same narrowed value. The registry is the
	// *only* way a provider reaches a session; without one there is nothing to
	// register against, and a skill discovered by neither provider is simply not
	// there. The panel and the write path are unaffected, so this degrades rather
	// than failing the row.
	const skills = ctx.get("skills") as SkillRegistry | undefined;

	// Both tiers, always. They are two halves of one isolation contract — the
	// private tier Buddy writes into, and the promoted tier a human hands to
	// ordinary sessions — and a preset that mounted only the first would leave
	// every promoted skill invisible to the very assistant that owns it. They are
	// two registrations because the registry keys providers by name, and each is
	// its own effect so the disposer the registry answered really is the one
	// cordis runs at unload.
	//
	// The buddy registration's factory is where the **control** is captured: it
	// is registration-scoped, it is the only invalidation entry point there is
	// (there is no public `ctx.skills.invalidate()`), and the registry caches
	// completed catalogs — so without it a skill the model just wrote stays
	// invisible to the next `skill` call. The promoted registration does not need
	// a second handle: both providers answer the same catalog.
	let invalidate: () => void = () => undefined;
	if (skills !== undefined) {
		ctx.effect(
			() =>
				skills.registerProvider((control: SkillProviderControl) => {
					invalidate = control.invalidate;
					return createBuddyProvider({ skillsRoot: plane.skillsRoot() });
				}),
			"dsh-buddy-skills-agent: buddy provider",
		);
		ctx.effect(
			() => skills.registerProvider(() => createPromotedProvider({ skillsRoot: plane.skillsRoot() })),
			"dsh-buddy-skills-agent: promoted provider",
		);
	}

	ctx.effect(() => {
		const tools = ctx.get("tools") as ToolRegistry | undefined;
		if (tools === undefined) return () => undefined;
		return tools.register(skillManageTool(plane, () => invalidate()));
	}, "dsh-buddy-skills-agent: skill_manage");

	// `session/event` is an **emit**, not a waterfall: the listener takes
	// `(session, event)` and returns nothing. Both forwards are one call into the
	// host service, which owns the counter, the nudge and the whole review
	// decision; this row only recognizes the two event types.
	ctx.on("session/event", (session: LiveSession, event: SessionEvent) => {
		const sessionId = session.header.id;
		if (event.type === "step/end") plane.noteStep(sessionId);
		if (event.type === "turn/end") {
			void plane.onTurnEnd({
				sessionId,
				// The reason is forwarded verbatim, because the host row's own first
				// gate reads `kind` and an invented value would silently disable the
				// automatic review. A `turn/end` with no reason cannot happen — the
				// shipped event declares it — so the fallback is only the type's.
				reason: { kind: event.data?.reason?.kind ?? "" },
				// `exactOptionalPropertyTypes`: omit rather than pass `undefined`.
				...(session.header.origin === undefined ? {} : { origin: session.header.origin }),
				...(session.header.delegationDepth === undefined
					? {}
					: { delegationDepth: session.header.delegationDepth }),
			});
		}
	});

	// `tools/post-execute` **is** a waterfall. A listener that forgets `next()`
	// silently swallows the dispatch — the call still runs, but its normalized
	// result never reaches the agent loop — so every path below returns it.
	ctx.on(
		"tools/post-execute",
		async (exec: ToolExecution, _result: ToolDispatchOutcome, next: () => Promise<unknown>) => {
			if (exec.name === "skill") {
				const loaded = skillNameOf(exec);
				if (loaded !== undefined) {
					// The review's own child session has no live agent, and its read
					// mark is exactly what read-before-write is judged against, so an
					// absent agent is recorded as the empty session rather than
					// dropped. `noteSkillUsed` never rejects; the catch is the belt to
					// that braces so a listener can never leak an unhandled rejection
					// into the harness's event dispatch.
					await plane
						.noteSkillUsed(exec.agent?.id ?? "", loaded)
						.catch((error: unknown) => {
							console.error(`dsh-buddy-skills-agent: recording a skill load failed (${messageOf(error)})`);
						});
				}
			}
			// Unconditional: every other tool's outcome must pass through untouched,
			// and so must this one's.
			return await next();
		},
	);

	ctx.effect(() => {
		const commands = ctx.get("commands") as CommandRegistry | undefined;
		if (commands === undefined) return () => undefined;
		return commands.register({
			name: COMMAND_NAME,
			description: COMMAND_DESCRIPTION,
			handler: async (invocation: CommandInvocation): Promise<CommandResult> => {
				const focus = invocation.rawInput.trim();
				try {
					await plane.refine(invocation.agent, focus);
				} catch (error) {
					// A command handler's rejection is a dispatch failure the UI has
					// no wording for; the host row's own review path is documented not
					// to throw, so this only fires on a genuine fault and is reported
					// as the error result the composer can show.
					return { kind: "error", text: `the skill review could not start (${messageOf(error)})` };
				}
				return {
					kind: "success",
					text: focus === "" ? "Reviewing the conversation for skills" : `Reviewing with focus: ${focus}`,
				};
			},
		});
	}, "dsh-buddy-skills-agent: refine");

	// This row is here. The host row's ten-second bound converts "the preset did
	// not mount its skills half" into a visible notice, and this is the only
	// thing that clears it.
	plane.noteAgentRowMounted();
}

/**
 * Build the `skill_manage` tool.
 *
 * `defineTool` is mandatory rather than cosmetic: it compiles the parameter
 * schema to JSON Schema and validates every call *before* `execute`, so an
 * argument the model got wrong never reaches the write path. The `output`
 * declaration is required by the contract and is what renders the model-facing
 * content of a successful call.
 * @param plane - the host service the tool forwards to.
 * @param invalidate - invalidate the provider catalogs, as a callback so the
 *   tool always reads the control the live registration installed.
 * @returns the registry-ready definition.
 */
function skillManageTool(plane: SkillsPlane, invalidate: () => void): unknown {
	return defineTool({
		name: TOOL_NAME,
		description:
			"Create, patch, edit, delete a Buddy skill, or write and remove its support files. Every operation in one call is applied atomically: if one is refused, none of them land.",
		parameters: {
			operations: {
				type: "array",
				required: true,
				description: "The mutations to apply, in order. Refused as a batch if any one of them is.",
				items: {
					type: "object",
					additionalProperties: false,
					properties: {
						action: {
							type: "string",
							required: true,
							enum: [...SKILL_MANAGE_ACTIONS],
							description: "Which mutation to apply.",
						},
						name: {
							type: "string",
							required: true,
							description: "The skill's kebab-case directory name.",
						},
						content: {
							type: "string",
							description: "The complete document for create/edit, or a support file's body.",
						},
						old_string: { type: "string", description: "The exact text a patch replaces." },
						new_string: { type: "string", description: "What a patch puts in its place." },
						file_path: {
							type: "string",
							description: "The skill-relative support path for write_file/remove_file.",
						},
					},
				},
			},
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					success: { type: "boolean", required: true },
					message: { type: "string", required: true },
				},
			},
			render: (_args: unknown, value: { readonly success: boolean; readonly message: string }) => [
				{ type: "text", text: value.message },
			],
		},
		execute: async (args: { readonly operations: readonly unknown[] }, exec: ToolExecution) => {
			// Attribution is not optional. Review is the only path that may curate
			// without the human asking, and it is identified by the session the call
			// runs for; a call with no agent cannot be attributed to a conversation,
			// and the jurisdiction guard would judge it as a foreground write. It is
			// refused rather than guessed at.
			const agent = attributedAgent(exec);
			if (agent === undefined) throw new Error(`${TOOL_NAME} requires an owning agent session`);
			// The nudge counter resets on the *attempt*, before the write is judged:
			// the model curated, and a batch the guard then refuses is not a reason
			// to make the automatic review fire as if nothing had happened.
			plane.noteSkillManageCalled(agent.id);
			const outcome = await plane.manage(agent, args.operations);
			// The registry caches completed catalogs, and the control captured at
			// registration is the only invalidation entry point there is. Without
			// this the skill the model just created stays invisible to the next
			// `skill` call, which reads to the model as a write that did not work.
			if (outcome.success) invalidate();
			return { success: outcome.success, message: outcome.message };
		},
	});
}

/**
 * The agent one execution is attributable to, or nothing.
 *
 * A tool call with no agent cannot be attributed to a conversation, and the
 * jurisdiction guard would then judge it as a foreground write — so it is
 * refused rather than guessed at. The check is a predicate rather than a bare
 * guard so the caller keeps the narrowed type.
 * @param exec - the settled dispatch.
 * @returns the owning agent, or `undefined` when there is no usable one.
 */
function attributedAgent(exec: ToolExecution): { readonly id: string } | undefined {
	const agent = exec.agent;
	if (agent?.id === undefined || agent.id === "") return undefined;
	return { id: agent.id };
}

/**
 * The skill name one `skill` tool call loaded.
 * @param exec - the settled dispatch.
 * @returns the name, or `undefined` when the arguments hold no usable string.
 */
function skillNameOf(exec: ToolExecution): string | undefined {
	const args = exec.arguments;
	if (typeof args !== "object" || args === null) return undefined;
	const loaded = (args as Record<string, unknown>)["name"];
	return typeof loaded === "string" && loaded !== "" ? loaded : undefined;
}

/**
 * @param error - an unknown throwable.
 * @returns its message, or the value rendered.
 */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
