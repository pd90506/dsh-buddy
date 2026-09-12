/**
 * Names shared by both halves and by the agent preset, and the `dsh-buddy`
 * anchor row.
 *
 * The anchor row registers nothing. It exists because `dsh-client-modules` only
 * reads `dsh.client` from the manifest of a row named exactly after its package;
 * the working rows are `dsh-buddy/store` and `dsh-buddy/persona`, subpath
 * specifiers it skips, so without this row the browser half never reaches the
 * page. `test/patch.test.ts` guards it.
 * @module dsh-buddy
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = "dsh-buddy";

/** Mounts nothing: the row's whole job is to be named `dsh-buddy`. */
export function apply(_ctx: unknown): void {}

/** Storage domain name. Lowercase, per the domain grammar's `UNIT_NAME_RE`. */
export const BUDDY_DOMAIN_NAME = "buddy";

/** Settings namespace. Lowercase, per the settings grammar. */
export const SETTINGS_NAMESPACE = "buddy";

/**
 * The prompt variable the `buddy` agent preset interpolates.
 *
 * The preset's persona row carries the literal text `{{buddy_soul}}`; this host
 * plugin registers the variable that fills it. Substituted values are NOT
 * scanned again by the renderer, so SOUL.md may contain `{{` freely.
 */
export const SOUL_VARIABLE = "buddy_soul";

/**
 * The main-panel key AND the sidebar panel-list id.
 *
 * These must be the same string: the sidebar addresses the main panel by its
 * own list id, and `ctx.layout.selectPanel` throws on a key the main slot
 * never registered.
 */
export const MAIN_PANEL_KEY = "dsh-buddy";

/** The agent preset id whose sessions this plugin treats as buddy conversations. */
export const BUDDY_PRESET_ID = "buddy";
