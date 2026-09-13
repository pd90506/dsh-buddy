/**
 * The plugin's durable state, in the harness's own storage plane.
 *
 * Three kinds of data live in three different places (see
 * `docs/research/dsh-host-api-facts.md`): the bot token belongs to the
 * credentials plane, user-editable configuration to the settings plane, and
 * *derived* plugin state — which chat owns which session, plus the polling
 * cursor — here, in a domain named `telegram` under `~/.dsh/storages/`.
 *
 * The session header's `origin` field is not an option: it is hard-validated to
 * the literal `'subagent'` at the session boundary, so a bridge cannot tag its
 * own sessions in the log. This map is the only record that a session belongs to
 * Telegram, which is exactly why it is persisted rather than kept in memory.
 *
 * One domain name exists per process, and opening an already-open name rejects,
 * so {@link openStore} falls back to the live handle instead of failing: after a
 * hot reload the previous fiber may not have closed yet.
 * @module dsh-buddy-telegram/store
 */
import { z } from "zod";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import type { Domain, DomainGlobal, KvTable } from "@deepseek-ai/dsh-storage-domain";

/** The single domain name this plugin owns. Lowercase per `UNIT_NAME_RE`. */
export const TELEGRAM_DOMAIN_NAME = "buddy_telegram";

/**
 * One Telegram chat's binding to a harness session.
 *
 * The model fields are chat-local by design: `/model` must not move the global
 * default (`agent-default-model`), so the choice is recorded here and re-installed
 * whenever the session is resumed.
 */
export const chatRecordSchema = z.object({
	/** The harness session this chat drives. */
	sessionId: z.string(),
	/** Chat-local model override, when the user picked one with `/model`. */
	provider: z.string().optional(),
	model: z.string().optional(),
	reasoningEffort: z.string().optional(),
	/** Last write, ISO-8601. */
	updatedAt: z.string(),
});

/** Stored shape of one chat binding. */
export type ChatRecord = z.infer<typeof chatRecordSchema>;

/** Where a session came from: the chat that created it. Never deleted by `/new`. */
export const originRecordSchema = z.object({
	chatId: z.string(),
	/** ISO-8601. */
	createdAt: z.string(),
});

/** Stored shape of one session origin. */
export type OriginRecord = z.infer<typeof originRecordSchema>;

/**
 * Domain-wide singletons.
 *
 * `updateOffset` is the polling cursor: Telegram replays up to 24 hours of
 * backlog when a client comes back without one, and re-feeding old messages to
 * the agent after a restart is exactly the bug this field prevents. The status
 * fields exist so the Settings tab can explain an idle or broken bot.
 */
export const globalSchema = z.object({
	/** `update_id` of the last handled update; next poll confirms through it. */
	updateOffset: z.number().int().optional(),
	/** Machine-readable runtime status shown in the settings tab. */
	status: z.string().optional(),
	/** Human-readable detail for a non-running status; empty means there is none. */
	statusDetail: z.string().optional(),
	/** Bot username, once `getMe` has succeeded. */
	botUsername: z.string().optional(),
});

/** Stored shape of the domain global. */
export type TelegramGlobal = z.infer<typeof globalSchema>;

/** The domain declaration: identity, version, and both schemas. */
export const telegramDomainSpec = defineDomain({
	name: TELEGRAM_DOMAIN_NAME,
	version: 1,
	global: { schema: globalSchema, initial: {} },
	tables: { chats: domainTable(chatRecordSchema), origins: domainTable(originRecordSchema) },
});

/** An opened domain plus the accessors the rest of the plugin uses. */
export interface TelegramStore {
	/** chat id (as a string) → session binding. */
	readonly chats: KvTable<string, ChatRecord>;
	/** session id → the chat that created it. */
	readonly origins: KvTable<string, OriginRecord>;
	/** Domain-wide singletons, including the polling cursor. */
	readonly global: DomainGlobal<TelegramGlobal>;
	/** Release the backend unit. Called from the owning `ctx.effect`. */
	close(): Promise<void>;
}

/** The slice of `ctx` this module needs. */
export interface StoreContext {
	get(name: string): unknown;
}

/**
 * Open (or adopt) the `telegram` domain.
 *
 * @param ctx - the plugin fiber's context.
 * @returns the opened domain's accessors.
 * @throws when the storage facility is not mounted, or the stored data fails
 * its schema (`invalid-record`) — schema drift is a real failure and must not be
 * silently swallowed.
 */
export async function openStore(ctx: StoreContext): Promise<TelegramStore> {
	const facility = ctx.get("storageDomain") as
		| {
				open(spec: typeof telegramDomainSpec): Promise<Domain<typeof telegramDomainSpec>>;
				get(name: string): unknown;
		  }
		| undefined;
	if (facility === undefined) {
		throw new Error("dsh-buddy-telegram: the storageDomain service is unavailable (load @deepseek-ai/dsh-storage-domain)");
	}
	let domain: Domain<typeof telegramDomainSpec>;
	try {
		domain = await facility.open(telegramDomainSpec);
	} catch (error) {
		const code = (error as { code?: string }).code;
		if (code !== "already-open") throw error;
		// Another fiber (a hot-reloaded earlier instance, most likely) still holds
		// the name. Sharing its handle is correct: it is the same on-disk unit.
		domain = facility.get(TELEGRAM_DOMAIN_NAME) as Domain<typeof telegramDomainSpec>;
	}
	return {
		chats: domain.table("chats"),
		origins: domain.table("origins"),
		global: domain.global,
		close: async (): Promise<void> => {
			await domain.close();
		},
	};
}
