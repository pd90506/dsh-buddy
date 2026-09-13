/**
 * Stylesheet for the sidebar Buddy folder.
 *
 * The folder sits directly above Settings, so it copies the metrics of the
 * harness's own sidebar rows rather than inventing any: the entry matches the
 * Settings trigger (`dsh-client-ui-settings-general` SettingsRoot.module.css —
 * 42px, 12px radius, circular 36px in the rail), and each conversation matches
 * a workspace session row (`dsh-client-ui-workspace` — 32px, 8px radius,
 * 14px title, 12px tertiary meta). Every colour is a `--dsw-*` token, so both
 * themes follow the host.
 *
 * Inline styles cannot express `:hover`, which is why this is a stylesheet at
 * all. The host's CSS-module class names are hashed per build, so they are
 * restated here under a `dsh-buddy-` prefix instead of being referenced.
 * @module dsh-buddy/client/folder-css
 */

export const FOLDER_CLASS = {
	root: "dsh-buddy-folder",
	entryRow: "dsh-buddy-folder-entry-row",
	rail: "dsh-buddy-folder-rail",
	entry: "dsh-buddy-folder-entry",
	label: "dsh-buddy-folder-label",
	toggle: "dsh-buddy-folder-toggle",
	arrow: "dsh-buddy-folder-arrow",
	arrowOpen: "dsh-buddy-folder-arrow-open",
	list: "dsh-buddy-folder-list",
	session: "dsh-buddy-folder-session",
	selected: "dsh-buddy-folder-selected",
	title: "dsh-buddy-folder-title",
	meta: "dsh-buddy-folder-meta",
	muted: "dsh-buddy-folder-muted",
} as const;

const c = FOLDER_CLASS;

export const FOLDER_CSS = [
	`.${c.root}{display:flex;flex-direction:column;width:100%;min-width:0}`,
	`.${c.entryRow}{flex:none;display:flex;align-items:center;gap:4px;width:calc(100% + 4px);margin:4px -2px 0}`,
	`.${c.entryRow}.${c.rail}{width:36px;margin:8px 0 0}`,
	`.${c.entry}{box-sizing:border-box;cursor:pointer;flex:1;min-width:0;height:42px;margin:0;padding:0 10px 0 8px;display:flex;align-items:center;gap:8px;overflow:hidden;border:none;border-radius:12px;background:0 0;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:14px;line-height:22px;text-align:left}`,
	`.${c.entry}:hover{background:var(--dsw-alias-interactive-bg-hover)}`,
	`.${c.entry}:focus-visible,.${c.toggle}:focus-visible,.${c.session}:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:-2px}`,
	`.${c.rail} .${c.entry}{flex:none;justify-content:center;gap:0;width:36px;height:36px;padding:0;border-radius:50%}`,
	`.${c.label}{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}`,
	`.${c.toggle}{flex:none;cursor:pointer;width:28px;height:28px;padding:0;display:inline-flex;align-items:center;justify-content:center;border:none;border-radius:50%;background:0 0;color:var(--dsw-alias-label-secondary)}`,
	`.${c.toggle}:hover{background:var(--dsw-alias-interactive-bg-hover)}`,
	`.${c.arrow}{transition:transform .15s var(--ds-ease-in-out)}`,
	`.${c.arrowOpen}{transform:rotate(90deg)}`,
	`.${c.list}{display:flex;flex-direction:column;max-height:40vh;overflow-y:auto;gap:2px;margin-top:4px;padding:0 0 4px 12px}`,
	`.${c.session}{box-sizing:border-box;cursor:pointer;width:100%;height:32px;flex:none;padding:0 8px;display:flex;align-items:center;gap:6px;border:none;border-radius:8px;background:0 0;color:var(--dsw-alias-label-primary);font-family:inherit;text-align:left}`,
	`.${c.session}:hover,.${c.session}.${c.selected}{background:var(--dsw-alias-interactive-bg-hover)}`,
	`.${c.title}{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:14px;line-height:20px}`,
	`.${c.meta},.${c.muted}{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px}`,
	`.${c.muted}{padding:6px 8px}`,
	`@media (prefers-reduced-motion:reduce){.${c.arrow}{transition:none}}`,
].join("");

/** Marks the injected tag, the way host plugins mark theirs (`data-plugin-css`). */
export const FOLDER_CSS_ID = "dsh-buddy/folder.css";
