/**
 * One-shot migration from dsh-telegram's `telegram` settings section.
 *
 * Only what the user actually wrote is copied (the raw `user` section, not the
 * resolved value), `enabled` is never copied and always written `false` — two
 * polling rows must not come up together because a migration ran — and the
 * legacy section is only ever read, so re-installing dsh-telegram is a lossless
 * rollback.
 *
 * The settings plane can only describe *registered* namespaces, so this finds a
 * legacy section only while dsh-telegram is still mounted. The cutover order in
 * the plan relies on that: install Buddy first, migrate, then remove dsh-telegram.
 * @module dsh-buddy/telegram/migrate
 */

/** dsh-telegram's settings namespace. */
export const LEGACY_NAMESPACE = "telegram";

/** Fields carried over. `enabled` is deliberately absent. */
export const MIGRATED_FIELDS = ["ownerUserId", "defaultCwd", "permissionPreset", "renderMarkdown", "mediaDelivery"] as const;

/** What a migration attempt concluded. */
export type MigrationResult = "migrated" | "present" | "no-legacy";

/** The settings-plane slice this needs. */
export interface MigrationSettings {
	describe(): readonly { ns: string; user?: unknown }[];
	update(ns: string, patch: Record<string, unknown>): Promise<void>;
}

/**
 * Copy the legacy section into `targetNs` once.
 * @param settings - the settings plane.
 * @param targetNs - the namespace to migrate into; must already be registered.
 * @returns what happened.
 */
export async function migrateLegacySettings(settings: MigrationSettings, targetNs: string): Promise<MigrationResult> {
	const descriptors = settings.describe();
	if (descriptors.find((descriptor) => descriptor.ns === targetNs)?.user !== undefined) return "present";
	const legacy = descriptors.find((descriptor) => descriptor.ns === LEGACY_NAMESPACE)?.user;
	if (typeof legacy !== "object" || legacy === null || Array.isArray(legacy)) return "no-legacy";
	const patch: Record<string, unknown> = { enabled: false };
	for (const field of MIGRATED_FIELDS) {
		const value = (legacy as Record<string, unknown>)[field];
		if (value !== undefined) patch[field] = value;
	}
	await settings.update(targetNs, patch);
	return "migrated";
}
