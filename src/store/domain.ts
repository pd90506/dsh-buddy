/**
 * Buddy's durable *derived* state, in the harness's own storage plane.
 *
 * Authored prose is not here — it is on disk under the buddy home. What lives
 * in the domain is state nothing else can reconstruct: for Phase 1 that is the
 * timestamp of the last persona write, which the settings tab reports and which
 * is neither a setting nor file content.
 *
 * One domain name exists per process and opening an already-open name rejects,
 * so {@link openStore} adopts the live handle instead of failing: after a hot
 * reload the previous fiber may not have closed yet.
 * @module dsh-buddy/store/domain
 */
import { z } from "zod";
import { defineDomain } from "@deepseek-ai/dsh-storage-domain";
import type { Domain, DomainGlobal } from "@deepseek-ai/dsh-storage-domain";
import { BUDDY_DOMAIN_NAME } from "../index.ts";

export { BUDDY_DOMAIN_NAME };

/** Domain-wide singletons. */
export const globalSchema = z.object({
	/** ISO-8601 timestamp of the last successful persona write. */
	lastPersonaWriteAt: z.string().optional(),
});

/** Stored shape of the domain global. */
export type BuddyGlobal = z.infer<typeof globalSchema>;

/** The domain declaration: identity, version, and the global schema. */
export const buddyDomainSpec = defineDomain({
	name: BUDDY_DOMAIN_NAME,
	version: 1,
	global: { schema: globalSchema, initial: {} },
	tables: {},
});

/** An opened domain plus the accessors the rest of the plugin uses. */
export interface BuddyDomainHandle {
	/** Domain-wide singletons. */
	readonly global: DomainGlobal<BuddyGlobal>;
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
		close: async (): Promise<void> => {
			await domain.close();
		},
	};
}
