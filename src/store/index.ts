/**
 * Host row `dsh-buddy/store`: the foundation both other halves stand on.
 *
 * It resolves the buddy home, guarantees the directory exists, opens the
 * `buddy` storage domain, and publishes `ctx.buddyStore`. Every other buddy row
 * declares `buddyStore` as a hard dependency, so cordis holds them in waiting
 * until this one is ready and unloads them again if it goes away.
 *
 * `storageDomain` is the only hard dependency here. `settings` is read through a
 * scoped injection so the row still mounts in a profile without the settings
 * plane — it simply uses the documented defaults there.
 * @module dsh-buddy/store
 */
import { mkdir } from "node:fs/promises";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import { Config, FALLBACK_CONFIG, SETTINGS_NAMESPACE, type BuddyConfig } from "../config.ts";
import { resolveBuddyPaths, type BuddyPaths } from "../paths.ts";
import { openStore, type BuddyDomainHandle } from "./domain.ts";
import { installPreset, presetTargetDir, resolveTemplateDir } from "./preset.ts";

declare module "@deepseek-ai/cordis" {
	interface Context {
		buddyStore: BuddyStore;
	}
}

/**
 * How long the boot waits for the settings plane to hand over its configuration
 * source before giving up and booting on the documented defaults.
 *
 * This is an **internal liveness bound, not a user-facing tunable**: it belongs
 * to neither `Config` nor the settings tab, and no profile should ever be able
 * to raise it. Its only job is to guarantee that the row — and therefore
 * `fiber.dispose()`, which cordis cannot run until the pending effect task
 * settles — always terminates, even when the scoped `settings` injection never
 * fires at all (the service is withdrawn between the check below and the scoped
 * fiber's activation, so there is no callback for a `finally` to run in).
 *
 * The value is three orders of magnitude above what the wait actually costs:
 * `installSection` lands through a microtask chain, i.e. sub-millisecond, and
 * the barrier is released in a `finally` even when it throws. Two seconds of
 * headroom therefore cannot be consumed by a merely busy event loop, while
 * still bounding the worst case well below anything a user would read as a
 * hung plugin. Firing is not a failure: it degrades to the pre-barrier
 * behaviour — boot on the default home — and says so in the log.
 */
const SETTINGS_SOURCE_TIMEOUT_MS = 2_000;

/** Cordis plugin name used by loader diagnostics. */
export const name = "dsh-buddy-store";

/** Hard dependency: without storage there is nowhere to keep derived state. */
export const inject = ["storageDomain"];

/** Live access to the `buddy` settings section. */
export interface ConfigAccess {
	/** The resolved section, read at call time. */
	read(): BuddyConfig;
	/** Merge a patch into the section through the settings plane. */
	write(patch: Partial<Pick<BuddyConfig, "model" | "panel">>): Promise<void>;
}

/** Used when the row runs without a settings plane. */
const NO_SETTINGS: ConfigAccess = {
	read: () => FALLBACK_CONFIG,
	write: async () => {
		throw new Error("dsh-buddy: the settings service is unavailable");
	},
};

/**
 * The `buddyStore` service.
 *
 * Fields are TypeScript-`private`, never `#`-private: cordis hands this service
 * out as a traceable proxy and dispatches through `Reflect.apply`, which
 * substitutes a shadow receiver for `this`. A `#` field is bound to the instance
 * object itself and is unreachable through any proxy.
 */
export class BuddyStore extends Service {
	/** Absolute locations of buddy's authored files. */
	public readonly paths: BuddyPaths;

	private readonly handle: BuddyDomainHandle;

	private readonly configAccess: ConfigAccess;

	/**
	 * @param ctx - the plugin fiber's context; the service registers immediately.
	 * @param paths - resolved buddy file locations.
	 * @param handle - the opened `buddy` domain.
	 * @param configAccess - live read/write access to the `buddy` settings section;
	 * defaults to a stand-in that reports the fallback and refuses writes.
	 */
	constructor(ctx: Context, paths: BuddyPaths, handle: BuddyDomainHandle, configAccess: ConfigAccess = NO_SETTINGS) {
		super(ctx, "buddyStore");
		this.paths = paths;
		this.handle = handle;
		this.configAccess = configAccess;
	}

	/**
	 * When the persona was last written.
	 * @returns an ISO-8601 timestamp, or `undefined` if it never has been.
	 */
	lastPersonaWriteAt(): string | undefined {
		return this.handle.global.get().lastPersonaWriteAt;
	}

	/**
	 * Record a successful persona write.
	 * @param at - ISO-8601 timestamp of the write.
	 */
	async markPersonaWritten(at: string): Promise<void> {
		await this.handle.global.set({ ...this.handle.global.get(), lastPersonaWriteAt: at });
	}

	/**
	 * The `buddy` settings section as it reads now.
	 * @returns the resolved configuration.
	 */
	config(): BuddyConfig {
		return this.configAccess.read();
	}

	/**
	 * Write Buddy-wide preferences. `home` is deliberately not writable here: it
	 * is read once at boot and moving it under a live row strands open handles.
	 * @param patch - whole `model` and/or `panel` objects.
	 */
	async updateConfig(patch: Partial<Pick<BuddyConfig, "model" | "panel">>): Promise<void> {
		await this.configAccess.write(patch);
	}
}

/** The context members this row uses. */
interface PluginContext {
	get(name: string): unknown;
	/**
	 * Cordis's async effect form: an `async` body resolving to the disposer.
	 * See `@deepseek-ai/cordis/lib/types/fiber.d.ts:51` — `AsyncEffect` is
	 * `Promise<Disposable>` — accepted by the overload on line 159. Cordis then
	 * owns the pending boot and awaits it before running the disposer, which a
	 * hand-rolled `void (async () => …)()` cannot offer.
	 */
	effect(effect: () => Promise<() => void>, label?: string): unknown;
	inject(services: string[], callback: (scoped: PluginContext) => void): void;
	settings?: {
		installSection(
			owner: unknown,
			ns: string,
			schema: unknown,
			entry: unknown,
			hooks: { setSource(current: () => BuddyConfig): void; onChange(): void },
		): void;
	};
}

/**
 * Wait for the settings barrier, bounded by {@link SETTINGS_SOURCE_TIMEOUT_MS}.
 *
 * The timer is `unref`ed so a pending wait can never hold the process open, and
 * cleared on the settled path so it can never fire after the boot moved on.
 * @param settled - the barrier released once the configuration source is final.
 * @returns `true` when the source settled in time, `false` when the bound fired.
 */
async function awaitSettingsSource(settled: Promise<void>): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const bounded = new Promise<boolean>((resolve) => {
		timer = setTimeout(() => resolve(false), SETTINGS_SOURCE_TIMEOUT_MS);
		// A liveness bound must not be a reason for the process to stay alive.
		timer.unref();
	});
	try {
		return await Promise.race([settled.then(() => true), bounded]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Resolve configuration, open storage, and publish the service.
 * @param ctx - the plugin fiber's context.
 */
export function apply(ctx: PluginContext): void {
	let readConfig: () => BuddyConfig = () => FALLBACK_CONFIG;

	let settleSource: () => void = () => undefined;
	/**
	 * Resolves once `readConfig` is final. The boot below waits on this rather
	 * than racing it: `installSection` lands through a scoped injection (a
	 * microtask chain) while the boot's first `await` is disk I/O, so without a
	 * barrier a user-set `buddy.home` is honoured only by luck.
	 */
	const sourceSettled = new Promise<void>((resolve) => {
		settleSource = () => resolve();
	});

	// Scoped injection so the row still mounts without the settings plane.
	ctx.inject(["settings"], (scoped) => {
		// `finally`, not a trailing statement: `installSection` throws on a
		// duplicate namespace and on a stored section that fails the schema (a
		// user writing `home = 3` under `[buddy]` is enough). A barrier left
		// dangling there would hang the boot *and* the disposal, because cordis
		// awaits the pending effect task before it disposes — so the whole row,
		// and every dependent, would wait forever on one malformed setting.
		// The throw still propagates: settling the barrier only releases the
		// boot onto the documented defaults, it does not swallow the failure.
		try {
			// `FALLBACK_CONFIG`, not `{}`: `entry` is the base layer *and* the
			// value dsh-settings replays raw — unresolved by the schema —
			// through `setSource(() => entry)` when the provider detaches. With
			// `{}` the post-detach `readConfig().home` is `undefined` and
			// `resolveBuddyPaths` throws on `.trim()`.
			scoped.settings?.installSection(ctx, SETTINGS_NAMESPACE, Config, FALLBACK_CONFIG, {
				setSource: (source) => {
					readConfig = source;
				},
				// Phase 1 reads `home` once at boot: moving the home under a live
				// plugin would strand the open domain and the editor's file handles.
				// A change takes effect on the next start, which the settings tab says.
				onChange: () => undefined,
			});
		} finally {
			// `installSection` calls `setSource` synchronously, so the source is
			// final the moment it returns — and releasing the barrier here
			// (rather than inside `setSource`) also unblocks a settings plane
			// that installs nothing at all.
			settleSource();
		}
	});

	// Async effect form (`fiber.d.ts:51`, overload on `:159`): cordis tracks the
	// pending boot and awaits it before disposing, so a dispose that lands mid
	// `openStore` still runs the disposer instead of a no-op over `undefined`.
	ctx.effect(async (): Promise<() => void> => {
		let handle: BuddyDomainHandle | undefined;
		try {
			// Only wait when a settings plane is really mounted: a profile
			// without one must boot straight onto the documented defaults.
			// The wait is *bounded*, because the barrier's `finally` only helps
			// when the scoped callback runs at all: withdraw `settings` between
			// this check and the scoped fiber's activation and nothing ever
			// releases it, hanging the boot and the disposal with it. Losing
			// the race costs the user's configured home for this run — the
			// pre-barrier behaviour — and never the whole row.
			if (ctx.get("settings") !== undefined && !(await awaitSettingsSource(sourceSettled))) {
				console.error(
					`dsh-buddy-store: the settings plane did not supply its configuration within ${SETTINGS_SOURCE_TIMEOUT_MS}ms; booting on the default home`,
				);
			}
			handle = await openStore(ctx);
			const opened = handle;
			const paths = resolveBuddyPaths(readConfig().home);
			// `main` holds the authored files (SOUL.md, AGENTS.md); creating it
			// recursively creates the home too. The workspace under it is created
			// on demand, when a conversation is first opened there.
			await mkdir(paths.main, { recursive: true });
			// The preset root follows the harness home (`dshHomePath()`), not the
			// buddy home resolved above: it is the harness that reads authored
			// presets, and a relocated buddy home must not hide the preset from it.
			// `resolveTemplateDir` — not a raw relative expression off
			// `import.meta.url` — because that expression lands one directory
			// shallower from the built `lib/store.js` than it does from
			// `src/store/index.ts`, which every test imports directly.
			const templateDir = resolveTemplateDir(import.meta.url);
			await installPreset(presetTargetDir(dshHomePath()), templateDir).catch((error: unknown) => {
				// A missing preset degrades the product but must not stop the store:
				// the panel, the settings tab and the endpoints all still work.
				console.error(`dsh-buddy-store: preset install skipped: ${(error as Error).message}`);
			});
			new BuddyStore(ctx as unknown as Context, paths, opened, {
				read: () => readConfig(),
				write: async (patch) => {
					// `ctx.get`, never `ctx.settings`: settings is a scoped, soft dependency.
					const settings = ctx.get("settings") as
						| { update(ns: string, patch: Record<string, unknown>): Promise<void> }
						| undefined;
					if (settings === undefined) throw new Error("dsh-buddy: the settings service is unavailable");
					await settings.update(SETTINGS_NAMESPACE, patch);
				},
			});
			return () => {
				void opened.close().catch(() => undefined);
			};
		} catch (error) {
			// The caller owns the opened domain and nothing else can reach it,
			// so every failure past `openStore` must close it here — including a
			// fiber disposed mid-boot, where constructing the service on the now
			// inactive context raises `INACTIVE_EFFECT`.
			await handle?.close().catch(() => undefined);
			// A store that cannot open is fatal for every dependent row, and
			// cordis keeps them waiting rather than half-mounting them. Surfacing
			// the reason is the only way a user can act on it.
			console.error(`dsh-buddy-store: boot failed: ${(error as Error).message}`);
			return () => undefined;
		}
	}, "dsh-buddy: store");
}
