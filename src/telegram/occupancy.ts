/**
 * Whether the standalone dsh-telegram plugin is still polling the bot.
 *
 * One token admits one long-poller; a second gets 409 Conflict and both look
 * broken with nothing on screen to say why. While dsh-telegram is mounted and
 * switched on, this row stays down and says so in its status instead.
 * @module dsh-buddy/telegram/occupancy
 */

/** The legacy plugin's row name (its package name). */
export const LEGACY_PLUGIN = "dsh-telegram";

/** Status detail shown in the Telegram module while occupied. */
export const OCCUPIED_DETAIL = "dsh-telegram is still polling this bot; remove it from the profile first";

/** The loader slice read here (`cordis-plugin-loader` `Entry`). */
interface LoaderLike {
	entries(): Iterable<{ readonly options: { readonly name: string }; readonly disabled: boolean }>;
}

/**
 * @param get - `ctx.get`.
 * @returns `true` when a non-disabled `dsh-telegram` row exists and `telegram.enabled` is `true`.
 */
export function legacyBotActive(get: (name: string) => unknown): boolean {
	const loader = get("loader") as LoaderLike | undefined;
	if (loader === undefined) return false;
	let mounted = false;
	for (const entry of loader.entries()) {
		if (entry.options.name === LEGACY_PLUGIN && !entry.disabled) mounted = true;
	}
	if (!mounted) return false;
	const settings = get("settings") as { get(ns: string): unknown } | undefined;
	const legacy = settings?.get("telegram") as { enabled?: unknown } | undefined;
	return legacy?.enabled === true;
}
