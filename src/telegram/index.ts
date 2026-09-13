/**
 * Host half of dsh-telegram.
 *
 * Lifecycle is deliberately dull: open the storage domain, build the runtime,
 * and start polling only when the enable switch is on *and* a token resolves.
 * A freshly installed plugin with neither therefore loads, registers its settings
 * section and its status endpoint, and idles — installing it changes nothing
 * until someone configures it in Settings → Telegram.
 *
 * `typert` and `storageDomain` are hard dependencies: without the registry the
 * tab has no status endpoint, and without storage there is nowhere to remember
 * which chat owns which session. Everything else (settings, credentials, agents,
 * approval, permission presets) is read through `ctx.get` so a profile that
 * lacks one degrades instead of failing to mount.
 * @module dsh-telegram
 */
import { Config, DEFAULT_MEDIA_DELIVERY, resolveDefaultCwd, SETTINGS_NAMESPACE, type TelegramConfig } from "./config.ts";
import { describeToken, readToken, TELEGRAM_TOKEN_REF } from "./credentials.ts";
import { TelegramGateway } from "./gateway.ts";
import { ApprovalBridge } from "./approvals.ts";
import { ModelMenu } from "./model.ts";
import { TelegramRuntime } from "./runtime.ts";
import { SessionManager } from "./session.ts";
import { openStore, type TelegramStore } from "./store.ts";

/** Cordis plugin name used by loader diagnostics. */
export const name = "dsh-telegram";

/** Hard dependencies: the status endpoint and the chat↔session map. */
export const inject = ["typert", "storageDomain"];

/** The context members this plugin uses. */
interface PluginContext {
	get(name: string): unknown;
	on(event: string, listener: (...args: never[]) => unknown): () => void;
	effect(effect: () => (() => void) | void, label?: string): void;
	inject(services: string[], callback: (scoped: PluginContext) => void): void;
	settings?: {
		installSection(
			owner: unknown,
			ns: string,
			schema: unknown,
			entry: unknown,
			hooks: { setSource(current: () => TelegramConfig): void; onChange(): void },
		): void;
		update(ns: string, patch: Record<string, unknown>): Promise<void>;
		register(ns: string, schema: unknown, options?: Record<string, unknown>): unknown;
	};
}

/** Defaults used before the settings section resolves. */
const FALLBACK: TelegramConfig = {
	enabled: false,
	ownerUserId: "",
	defaultCwd: "~/dsh-telegram",
	permissionPreset: "workspace-write",
	renderMarkdown: true,
	mediaDelivery: DEFAULT_MEDIA_DELIVERY,
};

/**
 * Register the settings section, the status endpoint, the approval listener, and
 * the bot runtime.
 * @param ctx - the plugin fiber's context.
 */
export function apply(ctx: PluginContext): void {
	const log = (line: string): void => {
		const text = `dsh-telegram: ${line}`;
		try {
			// `ctx.logger` is a cordis core property rather than a `get`-able
			// service in every composition, so both shapes are attempted before
			// falling back to the process console — a first-run problem that
			// leaves no trace anywhere is the worst possible failure mode.
			const direct = (ctx as unknown as { logger?: { info(message: string): void } }).logger;
			if (typeof direct?.info === "function") {
				direct.info(text);
				return;
			}
			const service = ctx.get("logger") as { info(message: string): void } | undefined;
			if (typeof service?.info === "function") {
				service.info(text);
				return;
			}
		} catch {
			// Fall through to the console.
		}
		console.log(text);
	};

	let readConfig: () => TelegramConfig = () => FALLBACK;
	let store: TelegramStore | undefined;
	let manager: SessionManager | undefined;
	let runtime: TelegramRuntime | undefined;
	let stopped = false;

	const approvals = new ApprovalBridge({
		api: () => runtime?.api(),
		isOurs: (sessionId) => runtime?.isOurs(sessionId) ?? false,
		chatFor: (sessionId) => runtime?.chatFor(sessionId),
		log,
	});
	const menu = new ModelMenu();

	/**
	 * Reconcile the running bot with the current configuration: start it when
	 * enabled with a token, stop it otherwise. Called at boot and on every
	 * settings change.
	 */
	const sync = async (): Promise<void> => {
		if (runtime === undefined || stopped) return;
		const config = readConfig();
		const token = await readToken(ctx);
		if (!config.enabled || token === undefined) {
			await runtime.stop();
			log(config.enabled ? "enabled but no token is configured" : "disabled");
			return;
		}
		await runtime.start(token);
	};

	/**
	 * Reconcile, containing any failure.
	 *
	 * `sync` is called from settings and credential hooks, neither of which can
	 * await it, so a rejection there would surface as an unhandled rejection —
	 * which Node turns into a process exit by default. A credentials hiccup must
	 * not be able to take the harness down with it.
	 */
	const resync = (): void => {
		void sync().catch((error: unknown) => {
			log(`reconcile failed: ${(error as Error).message}`);
		});
	};

	const boot = async (): Promise<void> => {
		store = await openStore(ctx);
		manager = new SessionManager({ get: (service) => ctx.get(service), store, log });
		runtime = new TelegramRuntime({
			get: (service) => ctx.get(service),
			store,
			manager,
			approvals,
			menu,
			config: () => readConfig(),
			log,
		});
		// One line that answers "did it mount, and what does it see?" — the only
		// thing a user can check when the tab is the thing that failed to appear.
		// Presence, never values: the token is a secret and the owner id is
		// personal, so both are reported as set or unset.
		const config = readConfig();
		log(
			[
				"mounted",
				`enabled=${String(config.enabled)}`,
				`token=${(await readToken(ctx)) === undefined ? "unset" : "set"}`,
				`owner=${config.ownerUserId.trim() === "" ? "unset" : "set"}`,
				`cwd=${resolveDefaultCwd(config)}`,
			].join(" "),
		);
		await sync();
	};

	// The settings section is installed through a scoped injection so the plugin
	// still mounts in a profile without the settings service (it simply cannot be
	// configured there).
	ctx.inject(["settings"], (scoped) => {
		scoped.settings?.installSection(ctx, SETTINGS_NAMESPACE, Config, {}, {
			setSource: (source) => {
				readConfig = source;
			},
			onChange: () => {
				resync();
			},
		});
	});

	// Re-judge the pair once the credentials service is actually usable.
	//
	// `readToken` reads the service with `ctx.get("credentials")`, and cordis's
	// `get` defaults to `strict = true`: it answers `undefined` unless the fiber
	// *providing* that service is active (`cordis/lib/index.js`: `if (strict &&
	// impl.fiber.state !== 2) return`). At boot the provider has not reached that
	// state, so `boot()`'s own `sync()` sees no token, stops, and reports
	// `Stopped` with an empty detail — the tell that `start()` was never tried.
	//
	// Nothing recovered from that on its own: `credentials/reference-updated`
	// below fires on a *write*, not when the service becomes readable, so the bot
	// stayed down until the user pressed Retry. A scoped injection is cordis's own
	// answer to "run this once the dependency is ready", and it keeps credentials
	// a soft dependency, so the plugin still mounts where the plane is absent.
	// `sync()` is idempotent — `start()` stops any previous run first — so the
	// extra pass costs nothing when boot already had a token.
	ctx.inject(["credentials"], () => {
		resync();
	});

	// One terminal answerer per deployment: ours declines anything it does not own.
	ctx.on("approval/request", ((request: unknown, next: () => Promise<never>) =>
		approvals.handler(request as never, next as never)) as never);

	// The bot needs both halves of its configuration — the enable switch *and* a
	// token — so whichever the user saves second has to re-judge the pair. Settings
	// changes already re-sync through `onChange`; without this, pasting the token
	// *after* enabling the switch left the bot idle until some later settings write
	// or a restart, with nothing on screen to explain it.
	ctx.on("credentials/reference-updated", ((ref: unknown) => {
		if (String(ref) !== String(TELEGRAM_TOKEN_REF)) return;
		resync();
	}) as never);

	new TelegramGateway(ctx, {
		status: async () => ({
			...(runtime?.status() ?? { state: "off" as const, sessions: 0 }),
			// Posture is reported, never the value. A credentials hiccup must not
			// take the runtime state down with it: the tab's most useful line is
			// whether the bot is running, and that has nothing to do with secrets.
			token: await describeToken(ctx).catch(() => ({ configured: false, writable: false })),
		}),
		readConfig: () => readConfig(),
		writeConfig: async (patch) => {
			// `ctx.get`, never `ctx.settings`: settings is deliberately a soft
			// dependency (the plugin must mount in a profile that lacks it), and
			// cordis's Guard rejects a bare property read of any service the plugin
			// did not declare in `inject` — the live endpoint answered
			// `gateway/internal: cannot get property "settings" without inject`.
			const settings = ctx.get("settings") as
				| { update(ns: string, patch: Record<string, unknown>): Promise<void> }
				| undefined;
			if (settings === undefined) throw new Error("telegram: the settings service is unavailable");
			await settings.update(SETTINGS_NAMESPACE, patch);
		},
	});

	ctx.effect(
		() => {
			void boot().catch((error: unknown) => {
				log(`boot failed: ${(error as Error).message}`);
			});
			return () => {
				stopped = true;
				runtime?.dispose();
				approvals.dispose();
				manager?.dispose();
				void store?.close().catch(() => undefined);
			};
		},
		"dsh-telegram: runtime",
	);
}
