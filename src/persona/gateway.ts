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
import { PANEL_SECTION_IDS, type BuddyConfig, type BuddyModelDefault, type PanelSectionId } from "../config.ts";
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
			{ ...shared, id: `${TYPERT_PACKAGE}#preferences`, method: "preferences", parameters: [] },
			{
				...shared,
				id: `${TYPERT_PACKAGE}#updatePreferences`,
				method: "updatePreferences",
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
	/** Buddy-wide preferences. */
	readonly readPreferences: () => Promise<PreferencesView>;
	/** Apply an already-validated preferences write. */
	readonly writePreferences: (patch: Partial<Pick<BuddyConfig, "model" | "panel">>) => Promise<PreferencesView>;
	/** The configuration the validator completes patches from. */
	readonly currentConfig: () => BuddyConfig;
}

/**
 * A patch under construction.
 *
 * {@link PersonaDocument}'s fields are `readonly`, so `Partial<PersonaDocument>`
 * cannot be filled in field by field; stripping the modifier here keeps the
 * accepted field set tied to the document rather than restating it.
 */
type PersonaPatch = { -readonly [K in keyof PersonaDocument]?: PersonaDocument[K] };

/**
 * Backs `buddyPersona/persona`, `buddyPersona/updatePersona`,
 * `buddyPersona/sessions`, `buddyPersona/preferences`, `buddyPersona/updatePreferences`.
 */
export class BuddyPersonaGateway extends TypertRemoteService {
	/**
	 * TypeScript-`private`, deliberately not `#`-private — see the Global
	 * Constraints. Cordis hands this service out as a traceable proxy and the
	 * api-gateway dispatches through `Reflect.apply(method, proxy, args)`, which
	 * substitutes a shadow receiver for `this`. A `#` field is bound to the
	 * instance object itself and is unreachable through any proxy, so the first
	 * live call would throw while every test holding the raw instance passed.
	 * `test/gateway.test.ts` dispatches through a proxy to pin it.
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
	 * arbitrary files or blank a document by sending the wrong type. This is the
	 * boundary that keeps unvalidated wire data away from `soulForPrompt`, which
	 * trims its fields unguarded.
	 * @param patch - the fields to change.
	 * @returns the persona after the write.
	 */
	async updatePersona(patch: Record<string, unknown>): Promise<PersonaView> {
		const clean: PersonaPatch = {};
		if (typeof patch["soul"] === "string") clean.soul = patch["soul"];
		if (typeof patch["agents"] === "string") clean.agents = patch["agents"];
		if (Object.keys(clean).length === 0) return await this.deps.readPersona();
		return await this.deps.writePersona(clean);
	}

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
}
