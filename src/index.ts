/**
 * Names shared by both halves and by the agent preset.
 *
 * This module exports no `apply`, so it cannot be mounted as a cordis row by
 * mistake — the rows are `dsh-buddy/store` and `dsh-buddy/persona`.
 * @module dsh-buddy
 */

/** Storage domain name. Lowercase, per the domain grammar's `UNIT_NAME_RE`. */
export const BUDDY_DOMAIN_NAME = "buddy";

/** Settings namespace. Lowercase, per the settings grammar. */
export const SETTINGS_NAMESPACE = "buddy";

/**
 * The prompt variable the `buddy` agent preset interpolates.
 *
 * The preset's persona row carries the literal text `{{buddySoul}}`; this host
 * plugin registers the variable that fills it. Substituted values are NOT
 * scanned again by the renderer, so SOUL.md may contain `{{` freely.
 */
export const SOUL_VARIABLE = "buddySoul";

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
