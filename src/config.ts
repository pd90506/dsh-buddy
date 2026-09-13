/**
 * The `buddy` settings section.
 *
 * Only non-secret, user-tunable values live here (`ctx.settings`, landing in
 * `~/.dsh/settings.yaml`). Authored prose goes to files under the buddy home,
 * and derived state goes to the storage domain — neither belongs in settings.
 *
 * Nothing tunable may be hardcoded elsewhere: if a value should be changeable
 * from `cordis.yml` or the settings document, it gets a field here. `model` and
 * `panel` are Buddy-wide preferences edited from the Buddy main panel and the
 * slim Settings tab.
 * @module dsh-buddy/config
 */
import z from "@deepseek-ai/schemastery";
import { SETTINGS_NAMESPACE, PANEL_SECTION_IDS, type PanelSectionId } from "./index.ts";

export { SETTINGS_NAMESPACE, PANEL_SECTION_IDS };
export type { PanelSectionId };

/** Buddy's own default model; all-empty means "follow the global default". */
export interface BuddyModelDefault {
	provider: string;
	model: string;
	/** Empty means the model's own default effort. */
	reasoningEffort: string;
}

/** Shape of the `buddy` settings section. */
export interface BuddyConfig {
	/**
	 * Buddy home directory. Empty means the harness home's `buddy/`, which is
	 * what almost every deployment wants; a `~` prefix is expanded.
	 */
	home: string;
	/** Default model for newly created buddy conversations. */
	model: BuddyModelDefault;
	/** Which main-panel modules are shown. */
	panel: { sections: Record<PanelSectionId, boolean> };
}

/** Defaults used before the settings section resolves. */
export const FALLBACK_CONFIG: BuddyConfig = {
	home: "",
	model: { provider: "", model: "", reasoningEffort: "" },
	panel: { sections: { soul: true, agents: true, model: true, telegram: true } },
};

/**
 * The settings schema; defaults apply when the user document is silent.
 *
 * Both type arguments are deliberate. `z<T>` is `Schemastery<T, T>`, which would
 * claim every field is required *on input* — but a settings document is silent
 * by design, and `Config({})` is the case the defaults exist to serve. The pair
 * states what the schema actually does: a partial document in, a complete config
 * out. Collapsing this to `z<BuddyConfig>` breaks `test/config.test.ts`.
 *
 * Nested objects carry both an object-level default (for an absent key) and
 * field-level defaults (for a partial object).
 */
export const Config: z<Partial<BuddyConfig>, BuddyConfig> = z.object({
	home: z
		.string()
		.default("")
		.description("Buddy home directory holding SOUL.md and AGENTS.md; empty means <harness home>/buddy"),
	model: z
		.object({
			provider: z.string().default("").description("Provider id; empty follows the global default model"),
			model: z.string().default("").description("Model id; empty follows the global default model"),
			reasoningEffort: z.string().default("").description("Reasoning effort id; empty uses the model's default"),
		})
		.default({ ...FALLBACK_CONFIG.model })
		.description("Default model for new buddy conversations"),
	panel: z
		.object({
			sections: z
				.object({
					soul: z.boolean().default(true),
					agents: z.boolean().default(true),
					model: z.boolean().default(true),
					telegram: z.boolean().default(true),
				})
				.default({ ...FALLBACK_CONFIG.panel.sections }),
		})
		.default({ sections: { ...FALLBACK_CONFIG.panel.sections } })
		.description("Which modules the Buddy main panel shows"),
}) as never;
