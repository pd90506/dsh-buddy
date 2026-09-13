/**
 * The bot token, kept where secrets belong.
 *
 * The token is stored through the credentials plane under a fixed reference, so
 * it never appears in `settings.yaml`, in a cordis config, or in this plugin's
 * settings section — and therefore never in the Settings tab's payload. Reads go
 * through {@link readToken}; there is no code path that echoes the value back to
 * a caller that renders.
 *
 * A token can also arrive from the launch environment (`TELEGRAM_BOT_TOKEN`),
 * which the credentials service resolves ahead of the stored record, so
 * `resolve` is the only correct accessor — reading the stored record directly
 * would miss the environment case.
 * @module dsh-buddy/telegram/credentials
 */
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { TELEGRAM_TOKEN_KEY } from "./credential-key.ts";

/** The reference this plugin owns; a POSIX identifier, as the plane requires. */
export const TELEGRAM_TOKEN_REF = credentialRef(TELEGRAM_TOKEN_KEY);

/** The slice of `ctx` this module needs. */
export interface CredentialContext {
	get(name: string): unknown;
}

/** What the settings tab is allowed to know about the token. */
export interface TokenPosture {
	/** Whether a token resolves from any source. */
	readonly configured: boolean;
	/** Where it comes from, when the plane reports it. */
	readonly source?: string | undefined;
	/** Whether this deployment may overwrite it. */
	readonly writable: boolean;
}

/**
 * Resolve the bot token, if one is configured.
 * @param ctx - the plugin fiber's context.
 * @returns the token value, or undefined when unset.
 */
export async function readToken(ctx: CredentialContext): Promise<string | undefined> {
	const credentials = ctx.get("credentials") as
		| { resolve(ref: typeof TELEGRAM_TOKEN_REF): Promise<{ value: string } | undefined> }
		| undefined;
	if (credentials === undefined) return undefined;
	const hit = await credentials.resolve(TELEGRAM_TOKEN_REF);
	const value = hit?.value?.trim();
	return value === undefined || value === "" ? undefined : value;
}

/**
 * Describe the token's posture without reading it.
 *
 * This is the only token-shaped thing that may cross into a rendered surface:
 * `configured / source / writable`, never the value.
 * @param ctx - the plugin fiber's context.
 * @returns posture for the settings tab.
 */
export async function describeToken(ctx: CredentialContext): Promise<TokenPosture> {
	const credentials = ctx.get("credentials") as
		| {
				describe(ref: typeof TELEGRAM_TOKEN_REF): Promise<{
					configured: boolean;
					source?: string;
					writable: boolean;
				}>;
		  }
		| undefined;
	if (credentials === undefined) return { configured: false, writable: false };
	const info = await credentials.describe(TELEGRAM_TOKEN_REF);
	return { configured: info.configured, source: info.source, writable: info.writable };
}
