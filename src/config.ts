/**
 * The `buddy` settings section.
 *
 * Only non-secret, user-tunable values live here (`ctx.settings`, landing in
 * `~/.dsh/settings.yaml`). Authored prose goes to files under the buddy home,
 * and derived state goes to the storage domain — neither belongs in settings.
 *
 * Nothing tunable may be hardcoded elsewhere: if a value should be changeable
 * from `cordis.yml` or the settings document, it gets a field here.
 * @module dsh-buddy/config
 */
import z from "@deepseek-ai/schemastery";
import { SETTINGS_NAMESPACE } from "./index.ts";

export { SETTINGS_NAMESPACE };

/** Shape of the `buddy` settings section. */
export interface BuddyConfig {
	/**
	 * Buddy home directory. Empty means the harness home's `buddy/`, which is
	 * what almost every deployment wants; a `~` prefix is expanded.
	 */
	home: string;
}

/** Defaults used before the settings section resolves. */
export const FALLBACK_CONFIG: BuddyConfig = { home: "" };

/**
 * The settings schema; defaults apply when the user document is silent.
 *
 * Both type arguments are deliberate. `z<T>` is `Schemastery<T, T>`, which would
 * claim every field is required *on input* — but a settings document is silent
 * by design, and `Config({})` is the case the defaults exist to serve. The pair
 * states what the schema actually does: a partial document in, a complete config
 * out. Collapsing this to `z<BuddyConfig>` breaks `test/config.test.ts`.
 */
export const Config: z<Partial<BuddyConfig>, BuddyConfig> = z.object({
	home: z
		.string()
		.default("")
		.description("Buddy home directory holding SOUL.md and AGENTS.md; empty means <harness home>/buddy"),
});
