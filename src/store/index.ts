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
	effect(effect: () => (() => void) | void, label?: string): void;
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

	// Scoped injection so the row still mounts without the settings plane.
	ctx.inject(["settings"], (scoped) => {
		scoped.settings?.installSection(ctx, SETTINGS_NAMESPACE, Config, {}, {
			setSource: (source) => {
				readConfig = source;
			},
			// Phase 1 reads `home` once at boot: moving the home under a live
			// plugin would strand the open domain and the editor's file handles.
			// A change takes effect on the next start, which the settings tab says.
			onChange: () => undefined,
		});
	});

	ctx.effect(() => {
		let handle: BuddyDomainHandle | undefined;
		void (async (): Promise<void> => {
			handle = await openStore(ctx);
			const paths = resolveBuddyPaths(readConfig().home);
			await mkdir(paths.home, { recursive: true });
			new BuddyStore(ctx as unknown as Context, paths, handle);
		})().catch((error: unknown) => {
			// A store that cannot open is fatal for every dependent row, and
			// cordis keeps them waiting rather than half-mounting them. Surfacing
			// the reason is the only way a user can act on it.
			console.error(`dsh-buddy-store: boot failed: ${(error as Error).message}`);
		});
		return () => {
			void handle?.close().catch(() => undefined);
		};
	}, "dsh-buddy: store");
}
