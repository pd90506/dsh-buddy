/**
 * The panel endpoints behind Buddy's Skills module.
 *
 * Endpoints are registered through the shared `typert` registry at runtime
 * rather than with `@Remote` decorators. Decorators write their markers into a
 * module-private table of whichever `dsh-typert-protocol` copy attached them,
 * and an out-of-tree plugin's nested copy is not the API gateway's — while
 * `ctx.typert.register` is an ordinary service call, immune to module identity.
 *
 * Every endpoint reads leaf fields and builds its own small object. A live
 * service, Session, Provider or table handle never leaves this layer: the panel
 * receives plain values it owns, so a wire response can never pin a fiber or
 * serialize something that only exists in the host process.
 * @module dsh-buddy/skills/gateway
 */
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

/** Typert wire namespace, and the name the panel calls. */
export const BUDDY_SKILLS_SERVICE = "buddySkills";

/**
 * The cordis key the typert binding really lives under.
 *
 * Distinct from {@link BUDDY_SKILLS_SERVICE} because the row publishes its own
 * `buddySkills` service (the coordinator seam and the preset row read it), and
 * cordis refuses a second registration under one name on a fiber. The
 * api-gateway resolves a strict descriptor as `ctx.get(descriptor.service)`
 * and then requires that service to carry a `typertRemote` binding whose
 * `serviceKey` **and** `namespace` agree with the descriptor
 * (`dsh-api-gateway/lib/index.js:1002-1005`), so every invocation below names
 * *this* key while the wire namespace stays `buddySkills`.
 */
export const BUDDY_SKILLS_ENDPOINTS = "buddySkillsEndpoints";

/** Package identity for the strict typert contribution. */
const TYPERT_PACKAGE = "dsh-buddy";

/** One skill as the panel lists it. Owned data, never a live provider handle. */
export interface SkillView {
	/** The directory name, which is also the skill's address. */
	readonly name: string;
	/** Short routing description from the document. */
	readonly description: string;
	/**
	 * The tier the document declares, verbatim — `buddy`, `global`, or
	 * `project:<path>`. Read from the frontmatter, never inferred from which
	 * provider contributed the skill: one provider serves both promoted tiers.
	 */
	readonly visibility: string;
	/** How many times the model loaded it. */
	readonly useCount: number;
	/** `use + view + patch`, with `created_at` deliberately excluded. */
	readonly activityCount: number;
	/** Newest recorded activity, or nothing when it has never been used. */
	readonly latestActivityAt?: string | undefined;
	/** Exempt from the automatic pass. */
	readonly pinned: boolean;
	/** `true` only for a skill an automatic review created. */
	readonly curatorManaged: boolean;
}

/** One usage row as the panel reads it. */
export interface SkillUsageView {
	readonly skill: string;
	readonly createdBy: "agent" | "human";
	readonly useCount: number;
	readonly viewCount: number;
	readonly patchCount: number;
	readonly lastUsedAt?: string | undefined;
	readonly lastViewedAt?: string | undefined;
	readonly lastPatchedAt?: string | undefined;
	readonly latestActivityAt?: string | undefined;
	readonly activityCount: number;
	readonly pinned: boolean;
	readonly archived: boolean;
}

/** One review-usage row as the panel reads it. */
export interface ReviewUsageView {
	readonly id: string;
	readonly ts: string;
	readonly parentSessionId: string;
	readonly childSessionId: string;
	readonly provider: string;
	readonly model: string;
	readonly steps: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly outcome: string;
}

/** One mutation-ledger row as the panel reads it, for the rollback list. */
export interface SkillLedgerView {
	readonly id: string;
	readonly ts: string;
	readonly actor: string;
	readonly action: string;
	readonly skill: string;
	/** The files the mutation captured beforehand. */
	readonly before: readonly string[];
	/** The files it produced. */
	readonly after: readonly string[];
}

/**
 * Whether the buddy preset's skills row is mounted.
 *
 * Spec §5.2's third bullet: a preset that is installed but silently contributes
 * nothing is the failure this phase exists to make visible. `missed` is the
 * notice — `true` once the bound fired and no heartbeat had arrived — and
 * `synced` is the same fact from the other side, so a panel can render either.
 */
export interface SkillsStatusView {
	/** `true` once the agent row reported that it mounted. */
	readonly synced: boolean;
	/** `true` while the not-synced notice is showing. */
	readonly missed: boolean;
}

/** The outcome of one panel write, plus the listing that follows it. */
export interface SkillMutationView {
	/** Whether the write applied. */
	readonly success: boolean;
	/** One line the panel shows either way. */
	readonly message: string;
	/** The fresh listing, so the panel needs no second round trip. */
	readonly skills: readonly SkillView[];
}

/** The outcome of one rollback. */
export interface SkillRollbackView {
	readonly success: boolean;
	readonly message: string;
}

/**
 * The one-writer surface the panel speaks to.
 *
 * A plain interface, not the host row: the row hands this object in, so the
 * wire layer never reaches a cordis service or a live harness object itself.
 */
export interface BuddySkillsRemote {
	/** Every skill under the buddy root, with its telemetry. */
	list(): Promise<readonly SkillView[]>;
	/** The mutation ledger, newest first. */
	ledger(): Promise<readonly SkillLedgerView[]>;
	/** Apply one already-validated batch of `skill_manage` operations. */
	manage(actor: string, operations: unknown): Promise<SkillMutationView>;
	/** Undo one ledger entry. */
	rollback(entryId: string): Promise<SkillRollbackView>;
	/** Hand a skill to automatic management. */
	adopt(skill: string): Promise<SkillMutationView>;
	/** Pin or unpin a skill. */
	pin(skill: string, pinned: boolean): Promise<SkillMutationView>;
	/** Raise (or lower) a skill's tier. Human-only by construction. */
	visibility(skill: string, tier: unknown): Promise<SkillMutationView>;
	/** Raw usage rows, keyed by skill. */
	usage(): Promise<readonly SkillUsageView[]>;
	/** Every review's attributed cost. */
	reviewUsage(): Promise<readonly ReviewUsageView[]>;
	/** Whether the preset's skills row reported in. */
	status(): Promise<SkillsStatusView>;
}

/** The context slice this service needs. */
export interface GatewayContext {
	get(name: string): unknown;
}

/** The `buddySkills/*` contribution: endpoints and their wire parameters. */
function typertContribution(): unknown {
	const shared = {
		namespace: BUDDY_SKILLS_SERVICE,
		// The key the binding is registered under — not the wire namespace. A
		// descriptor naming `buddySkills` here resolves to the *service*, which
		// carries no binding, and every call fails `gateway/binding-invalid`.
		service: BUDDY_SKILLS_ENDPOINTS,
		invocation: { kind: "direct" },
		result: { mode: "src-json" },
	};
	const json = { source: "json", codec: { mode: "src-json" } } as const;
	const skill = { name: "skill", wire: "skill", ...json };
	return {
		package: TYPERT_PACKAGE,
		face: "host",
		schemas: [],
		invocations: [
			{ ...shared, id: `${TYPERT_PACKAGE}#listSkills`, method: "list", parameters: [] },
			{ ...shared, id: `${TYPERT_PACKAGE}#ledger`, method: "ledger", parameters: [] },
			{
				...shared,
				id: `${TYPERT_PACKAGE}#manage`,
				method: "manage",
				parameters: [
					{ name: "actor", wire: "actor", ...json },
					{ name: "operations", wire: "operations", ...json },
				],
			},
			{
				...shared,
				id: `${TYPERT_PACKAGE}#rollback`,
				method: "rollback",
				parameters: [{ name: "entryId", wire: "entryId", ...json }],
			},
			{ ...shared, id: `${TYPERT_PACKAGE}#adopt`, method: "adopt", parameters: [skill] },
			{
				...shared,
				id: `${TYPERT_PACKAGE}#pin`,
				method: "pin",
				parameters: [skill, { name: "pinned", wire: "pinned", ...json }],
			},
			{
				...shared,
				id: `${TYPERT_PACKAGE}#visibility`,
				method: "visibility",
				parameters: [skill, { name: "tier", wire: "tier", ...json }],
			},
			{ ...shared, id: `${TYPERT_PACKAGE}#usage`, method: "usage", parameters: [] },
			{ ...shared, id: `${TYPERT_PACKAGE}#reviewUsage`, method: "reviewUsage", parameters: [] },
			{ ...shared, id: `${TYPERT_PACKAGE}#status`, method: "status", parameters: [] },
		],
	};
}

/**
 * Backs `buddySkills/list`, `buddySkills/ledger`, `buddySkills/manage`,
 * `buddySkills/rollback`, `buddySkills/adopt`, `buddySkills/pin`,
 * `buddySkills/visibility`, `buddySkills/usage` and `buddySkills/reviewUsage`.
 */
export class BuddySkillsGateway extends TypertRemoteService {
	/**
	 * TypeScript-`private`, deliberately not `#`-private — see the Global
	 * Constraints. Cordis hands this service out as a traceable proxy and the
	 * api-gateway dispatches through `Reflect.apply(method, proxy, args)`, which
	 * substitutes a shadow receiver for `this`. A `#` field is bound to the
	 * instance object itself and is unreachable through any proxy, so the first
	 * live call would throw while every test holding the raw instance passed.
	 */
	private readonly side: BuddySkillsRemote;

	/**
	 * @param ctx - the plugin fiber's context.
	 * @param side - the host row's writer and reader.
	 */
	constructor(ctx: GatewayContext, side: BuddySkillsRemote) {
		// Registered under the key the descriptor names, with the wire namespace
		// passed explicitly: `buddySkills` is the host row's own published service,
		// and cordis refuses a second registration under one name on a fiber.
		super(ctx as never, BUDDY_SKILLS_ENDPOINTS, { namespace: BUDDY_SKILLS_SERVICE });
		this.side = side;
		const typert = ctx.get("typert") as { register(contribution: unknown): void } | undefined;
		if (typert === undefined) throw new Error("dsh-buddy: the typert registry service is unavailable");
		typert.register(typertContribution());
	}

	/** @returns every skill under the buddy root, with its telemetry. */
	async list(): Promise<readonly SkillView[]> {
		return await this.side.list();
	}

	/** @returns the mutation ledger, newest first. */
	async ledger(): Promise<readonly SkillLedgerView[]> {
		return await this.side.ledger();
	}

	/**
	 * Apply one batch of `skill_manage` operations.
	 *
	 * The wire is untrusted, so both halves are normalized here: a missing or
	 * blank actor is dropped and a non-array batch is emptied, which the write
	 * path answers as a refusal rather than as a partial mutation. The operation
	 * *set* is the write path's business — inventing an action is refused there,
	 * which is what keeps `visibility` off this method.
	 * @param actor - the calling session's id.
	 * @param operations - the requested mutations.
	 * @returns the batch outcome plus the fresh listing.
	 */
	async manage(actor: unknown, operations: unknown): Promise<SkillMutationView> {
		return await this.side.manage(typeof actor === "string" ? actor.trim() : "", Array.isArray(operations) ? operations : []);
	}

	/**
	 * Undo one ledger entry.
	 * @param entryId - the ledger key.
	 * @returns whether the rollback applied, and what it did.
	 */
	async rollback(entryId: unknown): Promise<SkillRollbackView> {
		if (typeof entryId !== "string" || entryId.trim() === "") {
			return { success: false, message: "a ledger entry id is required" };
		}
		return await this.side.rollback(entryId);
	}

	/**
	 * Hand one skill to automatic management.
	 * @param skill - the skill directory name.
	 * @returns the outcome plus the fresh listing.
	 */
	async adopt(skill: unknown): Promise<SkillMutationView> {
		return await this.side.adopt(skillNameOf(skill));
	}

	/**
	 * Pin or unpin one skill.
	 * @param skill - the skill directory name.
	 * @param pinned - the new flag value.
	 * @returns the outcome plus the fresh listing.
	 */
	async pin(skill: unknown, pinned: unknown): Promise<SkillMutationView> {
		return await this.side.pin(skillNameOf(skill), pinned === true);
	}

	/**
	 * Raise or lower one skill's tier.
	 *
	 * This is the only door to that write, and it is a panel door: no
	 * `skill_manage` operation reaches it, so the automatic review cannot lift a
	 * skill out of the buddy tier. An ill-typed tier is passed through as-is and
	 * refused by the row, which is where the one canonical tier check lives.
	 * @param skill - the skill directory name.
	 * @param tier - `"buddy"`, `"global"` or `"project:<path>"`.
	 * @returns the outcome plus the fresh listing.
	 */
	async visibility(skill: unknown, tier: unknown): Promise<SkillMutationView> {
		return await this.side.visibility(skillNameOf(skill), tier);
	}

	/** @returns the raw usage rows. */
	async usage(): Promise<readonly SkillUsageView[]> {
		return await this.side.usage();
	}

	/** @returns every review's attributed cost. */
	async reviewUsage(): Promise<readonly ReviewUsageView[]> {
		return await this.side.reviewUsage();
	}

	/**
	 * Whether the preset's skills row reported in.
	 * @returns the sync notice state, for spec §5.2's panel warning.
	 */
	async status(): Promise<SkillsStatusView> {
		return await this.side.status();
	}
}

/**
 * Read one skill name off the wire.
 *
 * A skill name is joined onto the skills root, so only a string is accepted and
 * the row validates its grammar; anything else becomes the empty string, which
 * no row write can match.
 * @param value - the untrusted wire value.
 * @returns the name, or the empty string.
 */
function skillNameOf(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}
