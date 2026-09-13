/**
 * The settings schema for Settings → Telegram.
 *
 * Everything here is non-secret user configuration, so it lives in the ordinary
 * settings plane (`ctx.settings`, namespace `buddy-telegram`, landing in
 * `~/.dsh/settings.yaml`) and can be read and written by the browser tab through
 * the platform's own `settings.*` RPC — no bespoke endpoint needed. The bot
 * token is the one thing that must NOT be here; it goes through the credentials
 * plane (see `credentials.ts`).
 * @module dsh-buddy-telegram/config
 */
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import z from "@deepseek-ai/schemastery";
import { resolveBuddyPaths } from "../paths.ts";

/** This plugin's settings namespace. Lowercase, per the settings grammar. */
export const SETTINGS_NAMESPACE = "buddy-telegram";

/** Permission presets a Telegram session may run under. */
export const PERMISSION_PRESETS = ["read-only", "workspace-write", "danger-full-access"] as const;

/** One of {@link PERMISSION_PRESETS}. */
export type PermissionPreset = (typeof PERMISSION_PRESETS)[number];

/**
 * How much of a turn's media reaches the chat.
 *
 * `presented` is the restrained middle: only files the agent explicitly handed
 * over with `present` are sent, while images it merely generated — and inline
 * `![]()` references — stay out of the chat. `off` keeps the chat text-only.
 */
export const MEDIA_DELIVERY_MODES = ["off", "presented", "all"] as const;

/** One of {@link MEDIA_DELIVERY_MODES}. */
export type MediaDelivery = (typeof MEDIA_DELIVERY_MODES)[number];

/** Default media policy: the phone sees what the agent made. */
export const DEFAULT_MEDIA_DELIVERY: MediaDelivery = "all";

/** Shape of the `telegram` settings section. */
export interface TelegramConfig {
	/** Master switch: start polling when the token is also present. */
	enabled: boolean;
	/** The only Telegram user id allowed to talk to this bot. */
	ownerUserId: string;
	/** Directory every Telegram session is created in. */
	defaultCwd: string;
	/** Approval policy level applied to Telegram sessions. */
	permissionPreset: string;
	/** Whether agent prose is rendered as Telegram-native formatting. */
	renderMarkdown: boolean;
	/**
	 * Which of a turn's media is sent back to the chat.
	 *
	 * Typed as `string` for the same reason `permissionPreset` is: the schema
	 * enforces the set, and call sites narrow with {@link isMediaDeliveryMode}.
	 */
	mediaDelivery: string;
}

/**
 * Default working directory: the buddy workspace under the harness home
 * (`<harness home>/buddy/main/workspace`). Computed from `dshHomePath` so it
 * honours `$DSH_HOME`; a custom `buddy.home` is not read here, so a deployment
 * that relocates the home also sets this setting.
 */
export const DEFAULT_CWD = resolveBuddyPaths("").workspace;

/** Approval default: every risky call is asked about, on the phone. */
export const DEFAULT_PERMISSION_PRESET: PermissionPreset = "workspace-write";

/**
 * The settings schema. Defaults apply when the user document is silent, so a
 * freshly installed plugin has a usable (but disabled) configuration.
 */
export const Config: z<TelegramConfig> = z.object({
	enabled: z.boolean().default(false).description("Start the Telegram bot when a bot token is configured"),
	ownerUserId: z
		.string()
		.default("")
		.description("The only Telegram user id allowed to use this bot; empty means nobody"),
	defaultCwd: z
		.string()
		.default(DEFAULT_CWD)
		.description("Working directory for Telegram sessions; created on first use"),
	permissionPreset: z
		.string()
		.default(DEFAULT_PERMISSION_PRESET)
		.description("Permission level for Telegram sessions: read-only | workspace-write | danger-full-access"),
	renderMarkdown: z
		.boolean()
		.default(true)
		.description(
			"Render agent Markdown as Telegram formatting: bold headings, lists, quotes, links, tables and language-tagged code blocks",
		),
	mediaDelivery: z
		.string()
		.default(DEFAULT_MEDIA_DELIVERY)
		.description("Media sent back to the chat: off | presented | all"),
});

/** Whether a string names a known permission preset. */
export function isPermissionPreset(value: string): value is PermissionPreset {
	return (PERMISSION_PRESETS as readonly string[]).includes(value);
}

/** Whether a string names a known media policy. */
export function isMediaDeliveryMode(value: string): value is MediaDelivery {
	return (MEDIA_DELIVERY_MODES as readonly string[]).includes(value);
}

/**
 * Expand a leading `~` against the user's home directory.
 * @param path - a possibly tilde-prefixed path.
 * @param home - home directory, injectable for tests.
 * @returns the path with `~` replaced.
 */
export function expandHome(path: string, home: string = homedir()): string {
	if (path === "~") return home;
	if (path.startsWith("~/")) return resolve(home, path.slice(2));
	return path;
}

/**
 * Resolve the configured working directory to an absolute path.
 *
 * The session store rejects a non-absolute `cwd`, so this always returns one:
 * `~` is expanded, a relative path is resolved against the process cwd, and an
 * empty value falls back to the documented default.
 * @param config - the resolved settings section.
 * @returns an absolute directory path.
 */
export function resolveDefaultCwd(config: Pick<TelegramConfig, "defaultCwd">): string {
	const raw = config.defaultCwd.trim();
	const chosen = raw === "" ? DEFAULT_CWD : raw;
	const expanded = expandHome(chosen);
	return isAbsolute(expanded) ? expanded : resolve(expanded);
}
