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

/** Skill auto-evolution: the post-turn review that writes skills. */
export interface BuddySkillsConfig {
	/** Master switch for the automatic post-turn review. */
	enabled: boolean;
	/** Steps between two automatic reviews of the same conversation. */
	creationNudgeInterval: number;
	/** Provider for the review pass; empty follows the conversation's own route. */
	reviewProvider: string;
	/** Model for the review pass; empty follows the conversation's own route. */
	reviewModel: string;
	/** Model-round ceiling for one review pass. */
	maxReviewSteps: number;
	/** Cumulative input-token ceiling for one review pass. */
	maxInputTokens: number;
	/** Stage skill writes for approval instead of applying them. */
	writeApproval: boolean;
	/** Record the skill mutation ledger. */
	ledger: boolean;
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
	/** Automatic skill curation. */
	skills: BuddySkillsConfig;
}

/** Defaults used before the settings section resolves. */
export const FALLBACK_CONFIG: BuddyConfig = {
	home: "",
	model: { provider: "", model: "", reasoningEffort: "" },
	panel: { sections: { soul: true, agents: true, skills: true, model: true, telegram: true } },
	skills: {
		enabled: true,
		creationNudgeInterval: 10,
		reviewProvider: "",
		reviewModel: "",
		maxReviewSteps: 16,
		maxInputTokens: 600000,
		writeApproval: false,
		ledger: true,
	},
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
					skills: z.boolean().default(true),
					model: z.boolean().default(true),
					telegram: z.boolean().default(true),
				})
				.default({ ...FALLBACK_CONFIG.panel.sections }),
		})
		.default({ sections: { ...FALLBACK_CONFIG.panel.sections } })
		.description("Which modules the Buddy main panel shows"),
	skills: z
		.object({
			enabled: z.boolean().default(true).description("Master switch for the automatic post-turn skill review"),
			creationNudgeInterval: z
				.number()
				.default(10)
				.description("Steps between two automatic reviews of the same conversation"),
			reviewProvider: z
				.string()
				.default("")
				.description("Provider for the review pass; empty follows the conversation's own route"),
			reviewModel: z
				.string()
				.default("")
				.description("Model for the review pass; empty follows the conversation's own route"),
			maxReviewSteps: z.number().default(16).description("Model-round ceiling for one review pass"),
			maxInputTokens: z.number().default(600000).description("Cumulative input-token ceiling for one review pass"),
			writeApproval: z
				.boolean()
				.default(false)
				.description(
					"Reserved and not yet honoured: staging writes for approval needs a pending queue plus an approval surface, so every write is applied today whatever this is set to",
				),
			ledger: z.boolean().default(true).description("Record the skill mutation ledger"),
		})
		.default({ ...FALLBACK_CONFIG.skills })
		.description("Automatic skill curation"),
}) as never;
