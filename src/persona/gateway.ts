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

/**
 * A patch under construction.
 *
 * {@link PersonaDocument}'s fields are `readonly`, so `Partial<PersonaDocument>`
 * cannot be filled in field by field; stripping the modifier here keeps the
 * accepted field set tied to the document rather than restating it.
 */
type PersonaPatch = { -readonly [K in keyof PersonaDocument]?: PersonaDocument[K] };

/** Backs `buddyPersona/persona`, `buddyPersona/updatePersona`, `buddyPersona/sessions`. */
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
}
