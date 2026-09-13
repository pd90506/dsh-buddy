/**
 * The host endpoints backing the Settings → Telegram tab.
 *
 * The tab edits three things, and each lives where it belongs:
 *
 * - the **bot token** through the platform's own `credentials.*` RPC — this
 *   service never sees it, and can only report `configured / source / writable`;
 * - **configuration** (owner id, working directory, permission level, enable
 *   switch, and the two output-shape switches) through
 *   {@link TelegramGateway.updateConfig}, which writes the `telegram` settings
 *   section through `ctx.settings`;
 * - **runtime status** through {@link TelegramGateway.status} — the one thing no
 *   existing plane can express.
 *
 * Endpoints are registered through the shared `typert` registry at runtime rather
 * than with `@Remote` decorators. Decorators write their markers into a
 * module-private table of whichever `dsh-typert-protocol` copy attached them, and
 * an out-of-tree plugin's nested copy is not the API gateway's — while
 * `ctx.typert.register` is an ordinary service call, immune to module identity
 * and re-read on every claim.
 * @module dsh-telegram/gateway
 */
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { isMediaDeliveryMode, type TelegramConfig } from "./config.ts";
import type { TokenPosture } from "./credentials.ts";

/** Cordis service key; also the typert wire namespace. */
export const TELEGRAM_SERVICE = "telegram";

/** Package identity for the strict typert contribution. */
const TYPERT_PACKAGE = "dsh-telegram";

/** What the tab renders about the bot's runtime. */
export interface TelegramStatus {
	/** Poller state. */
	readonly state: "off" | "starting" | "running" | "error";
	/** Detail for a non-running state, safe to display. */
	readonly detail?: string | undefined;
	/** `@username` of the bot the token belongs to, once known. */
	readonly botUsername?: string | undefined;
	/** Whether a token resolves, from where, and whether it may be changed. */
	readonly token: TokenPosture;
	/** How many sessions this plugin currently drives. */
	readonly sessions: number;
}

/** The contribution that puts `telegram/*` on the wire. */
function typertContribution(): unknown {
	const shared = {
		namespace: TELEGRAM_SERVICE,
		service: TELEGRAM_SERVICE,
		invocation: { kind: "direct" },
		result: { mode: "src-json" },
	};
	const json = { source: "json", codec: { mode: "src-json" } } as const;
	return {
		package: TYPERT_PACKAGE,
		face: "host",
		schemas: [],
		invocations: [
			{ ...shared, id: `${TYPERT_PACKAGE}#status`, method: "status", parameters: [] },
			{ ...shared, id: `${TYPERT_PACKAGE}#config`, method: "config", parameters: [] },
			{
				...shared,
				id: `${TYPERT_PACKAGE}#updateConfig`,
				method: "updateConfig",
				parameters: [{ name: "patch", wire: "patch", ...json }],
			},
		],
	};
}

/** The context slice this service needs. */
export interface GatewayContext {
	get(name: string): unknown;
}

/** Host-side collaborators. */
export interface GatewayDeps {
	/** Runtime status, including freshly described token posture. */
	readonly status: () => Promise<TelegramStatus>;
	/** The current settings section. */
	readonly readConfig: () => TelegramConfig;
	/** Merge a patch into the `telegram` settings section. */
	readonly writeConfig: (patch: Record<string, unknown>) => Promise<void>;
}

/**
 * Backs `telegram/status`, `telegram/config`, and `telegram/updateConfig`.
 */
export class TelegramGateway extends TypertRemoteService {
	/**
	 * TypeScript-`private`, deliberately not `#`-private.
	 *
	 * Cordis hands this service out as a traceable proxy and dispatches endpoints
	 * through `Reflect.apply(method, proxy, args)`, which substitutes a shadow
	 * receiver for `this`. A `#` field is bound to the instance object itself and
	 * is unreachable through any proxy, so `this.deps` inside an endpoint throws
	 * `Cannot read private member #deps from an object whose class did not declare
	 * it` — invisibly to every test that holds the raw instance. The keyword still
	 * keeps the field off the public surface at compile time, which is how DSH's
	 * own host services are written (`test/gateway.test.ts` pins this).
	 */
	private readonly deps: GatewayDeps;

	/**
	 * @param ctx - the plugin fiber's context.
	 * @param deps - status and settings accessors.
	 */
	constructor(ctx: GatewayContext, deps: GatewayDeps) {
		super(ctx as never, TELEGRAM_SERVICE);
		this.deps = deps;
		const typert = ctx.get("typert") as { register(contribution: unknown): void } | undefined;
		if (typert === undefined) throw new Error("telegram: the typert registry service is unavailable");
		typert.register(typertContribution());
	}

	/**
	 * Current runtime status.
	 * @returns the status the tab renders.
	 */
	async status(): Promise<TelegramStatus> {
		return await this.deps.status();
	}

	/**
	 * The current settings section, with a live permission-preset list attached
	 * so the tab does not have to hard-code one.
	 * @returns the configuration the tab edits.
	 */
	config(): TelegramConfig {
		return this.deps.readConfig();
	}

	/**
	 * Merge a patch into the `telegram` settings section.
	 *
	 * Only known fields are accepted, so a malformed client cannot stuff
	 * arbitrary keys into `settings.yaml`.
	 * @param patch - the fields to change.
	 * @returns the section after the write.
	 */
	async updateConfig(patch: Record<string, unknown>): Promise<TelegramConfig> {
		const clean: Record<string, unknown> = {};
		if (typeof patch["enabled"] === "boolean") clean["enabled"] = patch["enabled"];
		if (typeof patch["ownerUserId"] === "string") clean["ownerUserId"] = patch["ownerUserId"].trim();
		if (typeof patch["defaultCwd"] === "string") clean["defaultCwd"] = patch["defaultCwd"].trim();
		if (typeof patch["permissionPreset"] === "string") clean["permissionPreset"] = patch["permissionPreset"];
		if (typeof patch["renderMarkdown"] === "boolean") clean["renderMarkdown"] = patch["renderMarkdown"];
		if (typeof patch["mediaDelivery"] === "string" && isMediaDeliveryMode(patch["mediaDelivery"])) {
			clean["mediaDelivery"] = patch["mediaDelivery"];
		}
		if (Object.keys(clean).length > 0) await this.deps.writeConfig(clean);
		return this.deps.readConfig();
	}
}
