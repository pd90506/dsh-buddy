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
import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import { Config, FALLBACK_CONFIG, SETTINGS_NAMESPACE, type BuddyConfig } from "../config.ts";
import { resolveBuddyPaths, type BuddyPaths } from "../paths.ts";
import { openStore, type BuddyDomainHandle } from "./domain.ts";

declare module "@deepseek-ai/cordis" {
	interface Context {
		buddyStore: BuddyStore;
	}
}

/** Cordis plugin name used by loader diagnostics. */
export const name = "dsh-buddy-store";

/** Hard dependency: without storage there is nowhere to keep derived state. */
export const inject = ["storageDomain"];

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

	/**
	 * @param ctx - the plugin fiber's context; the service registers immediately.
	 * @param paths - resolved buddy file locations.
	 * @param handle - the opened `buddy` domain.
	 */
	constructor(ctx: Context, paths: BuddyPaths, handle: BuddyDomainHandle) {
		super(ctx, "buddyStore");
		this.paths = paths;
		this.handle = handle;
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
			if (ctx.get("settings") !== undefined) await sourceSettled;
			handle = await openStore(ctx);
			const opened = handle;
			const paths = resolveBuddyPaths(readConfig().home);
			await mkdir(paths.home, { recursive: true });
			new BuddyStore(ctx as unknown as Context, paths, opened);
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
