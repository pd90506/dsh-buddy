/**
 * Buddy's durable *derived* state, in the harness's own storage plane.
 *
 * Authored prose is not here — it is on disk under the buddy home. What lives
 * in the domain is state nothing else can reconstruct: the timestamp of the last
 * persona write (which the settings tab reports), skill usage telemetry, the
 * skill mutation ledger, and per-review token usage attributed to the parent
 * conversation. None of it is a setting and none of it is file content.
 *
 * One domain name exists per process and opening an already-open name rejects,
 * so {@link openStore} adopts the live handle instead of failing: after a hot
 * reload the previous fiber may not have closed yet.
 * @module dsh-buddy/store/domain
 */
import { z } from "zod";
import { defineDomain } from "@deepseek-ai/dsh-storage-domain";
import type { Domain, DomainGlobal, KvTable } from "@deepseek-ai/dsh-storage-domain";
import { BUDDY_DOMAIN_NAME } from "../index.ts";

export { BUDDY_DOMAIN_NAME };

/** Domain-wide singletons. */
export const globalSchema = z.object({
	/** ISO-8601 timestamp of the last successful persona write. */
	lastPersonaWriteAt: z.string().optional(),
});

/** Stored shape of the domain global. */
export type BuddyGlobal = z.infer<typeof globalSchema>;

/**
 * One skill's usage telemetry.
 *
 * The field names are the reference implementation's, one for one, because a
 * later phase's pruning pass reads exactly these and a renamed field would
 * silently change what "unused" means. `latest_activity_at` and
 * `activity_count` are *derived* — computed on read, never stored — so a
 * never-used skill stays distinguishable from one whose activity is merely old.
 */
export const skillUsageSchema = z.object({
	/** `"agent"` when an automatic review created it, `null` when a human did. */
	created_by: z.string().nullable(),
	use_count: z.number(),
	view_count: z.number(),
	last_used_at: z.string().nullable(),
	last_viewed_at: z.string().nullable(),
	patch_count: z.number(),
	patch_generation: z.number(),
	last_reused_patch_generation: z.number(),
	last_patched_at: z.string().nullable(),
	created_at: z.string(),
	state: z.enum(["active", "stale", "archived"]),
	pinned: z.boolean(),
	archived_at: z.string().nullable(),
});

/** Stored shape of one skill's usage record. */
export type SkillUsageRecord = z.infer<typeof skillUsageSchema>;

/**
 * One skill mutation, as the ledger records it.
 *
 * `before` and `after` are content-addressed manifests — the file's path and
 * the sha256 of its bytes — so a single mutation can be rolled back exactly,
 * and identical contents are stored once.
 */
export const skillLedgerSchema = z.object({
	id: z.string(),
	ts: z.string(),
	/** Who wrote: the curation pass, an automatic review, or a human. */
	actor: z.enum(["curator", "agent", "user"]),
	action: z.enum([
		"create",
		"edit",
		"patch",
		"delete",
		"write_file",
		"remove_file",
		"archive",
		"restore",
		"pre-rollback",
		"rollback",
	]),
	skill: z.string(),
	evidence: z.record(z.string(), z.unknown()),
	before: z.array(z.object({ path: z.string(), sha256: z.string() })),
	after: z.array(z.object({ path: z.string(), sha256: z.string() })),
});

/** Stored shape of one ledger entry. */
export type SkillLedgerRecord = z.infer<typeof skillLedgerSchema>;

/**
 * One automatic review's token usage, attributed to the conversation it read.
 *
 * The review is a separate session, so its own log already holds this — this
 * record exists so the cost can be *attributed* to the parent conversation and
 * shown there, which is what the reference implementation's side table does.
 */
export const reviewUsageSchema = z.object({
	id: z.string(),
	ts: z.string(),
	parentSessionId: z.string(),
	childSessionId: z.string(),
	provider: z.string(),
	model: z.string(),
	steps: z.number(),
	inputTokens: z.number(),
	outputTokens: z.number(),
	cacheReadTokens: z.number(),
	cacheWriteTokens: z.number(),
	outcome: z.string(),
});

/** Stored shape of one review's usage. */
export type ReviewUsageRecord = z.infer<typeof reviewUsageSchema>;

/**
 * A zeroed usage record, stamped with its creation time.
 *
 * `created_by` starts `null` — i.e. *not* under automatic management — so a
 * skill only becomes curator-managed when the caller that created it says so.
 * @param now - ISO-8601 creation timestamp.
 * @returns the record.
 */
export function emptyUsageRecord(now: string): SkillUsageRecord {
	return {
		created_by: null,
		use_count: 0,
		view_count: 0,
		last_used_at: null,
		last_viewed_at: null,
		patch_count: 0,
		patch_generation: 0,
		last_reused_patch_generation: 0,
		last_patched_at: null,
		created_at: now,
		state: "active",
		pinned: false,
		archived_at: null,
	};
}

/** The domain declaration: identity, version, and the record layout. */
export const buddyDomainSpec = defineDomain({
	name: BUDDY_DOMAIN_NAME,
	// The version stays 1 while a change is purely additive: this spec declares
	// no `layout`, so the json backend opens it as a `single`-layout unit, and
	// that reader compares the stored stamp against this number and rejects any
	// mismatch at open with `version-mismatch`. `compatibleVersions` does NOT
	// help here — the json backend honours it only for the `per-record` layout —
	// and an absent declared table in a version 1 document already reads as an
	// empty map. Bumping this field without a matching migration would
	// therefore reject every existing install's `buddy.json` instead of adding
	// the three tables to it, so bump only alongside a real migration.
	version: 1,
	global: { schema: globalSchema, initial: {} },
	// Table names are storage-unit names, so they obey `UNIT_NAME_RE`
	// (`/^[a-z][a-z0-9_]*$/`) — snake_case, not the camelCase of the TypeScript
	// handles that read them. Getting this wrong throws at `defineDomain`, i.e.
	// at module load, which is exactly how it was caught.
	tables: {
		skill_usage: { valueSchema: skillUsageSchema },
		skill_ledger: { valueSchema: skillLedgerSchema },
		review_usage: { valueSchema: reviewUsageSchema },
	},
});

/** An opened domain plus the accessors the rest of the plugin uses. */
export interface BuddyDomainHandle {
	/** Domain-wide singletons. */
	readonly global: DomainGlobal<BuddyGlobal>;
	/** Per-skill usage telemetry, keyed by skill name. */
	readonly skillUsage: KvTable<string, SkillUsageRecord>;
	/** The mutation ledger, keyed by entry id. */
	readonly skillLedger: KvTable<string, SkillLedgerRecord>;
	/** Per-review token usage, keyed by usage-record id. */
	readonly reviewUsage: KvTable<string, ReviewUsageRecord>;
	/** Release the backend unit. Called from the owning `ctx.effect`. */
	close(): Promise<void>;
}

/** The slice of `ctx` this module needs. */
export interface StoreContext {
	get(name: string): unknown;
}

/**
 * Open (or adopt) the `buddy` domain.
 *
 * @param ctx - the plugin fiber's context.
 * @returns the opened domain's accessors.
 * @throws when the storage facility is not mounted, or the stored data fails
 * its schema — schema drift is a real failure and must not be silently swallowed.
 */
export async function openStore(ctx: StoreContext): Promise<BuddyDomainHandle> {
	const facility = ctx.get("storageDomain") as
		| {
				open(spec: typeof buddyDomainSpec): Promise<Domain<typeof buddyDomainSpec>>;
				get(name: string): unknown;
		  }
		| undefined;
	if (facility === undefined) {
		throw new Error("dsh-buddy: the storageDomain service is unavailable (load @deepseek-ai/dsh-storage-domain)");
	}
	let domain: Domain<typeof buddyDomainSpec>;
	try {
		domain = await facility.open(buddyDomainSpec);
	} catch (error) {
		if ((error as { code?: string }).code !== "already-open") throw error;
		// Another fiber (a hot-reloaded earlier instance) still holds the name.
		// Sharing its handle is correct: it is the same on-disk unit.
		domain = facility.get(BUDDY_DOMAIN_NAME) as Domain<typeof buddyDomainSpec>;
	}
	return {
		global: domain.global,
		// Table handles are stable and resolved once here, not per call: the
		// storage service owns their lifecycle, and re-resolving them per write
		// would put a lookup on every skill mutation. The storage names are
		// snake_case (`UNIT_NAME_RE`); the handle fields are code identifiers.
		skillUsage: domain.table("skill_usage"),
		skillLedger: domain.table("skill_ledger"),
		reviewUsage: domain.table("review_usage"),
		close: async (): Promise<void> => {
			await domain.close();
		},
	};
}
