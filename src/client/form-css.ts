/**
 * Stylesheet for the main panel's and Settings tab's form surfaces.
 *
 * Buttons, switches, text inputs and menus are the harness's own primitives.
 * The kit has no textarea and no select, so those two copy the host's own
 * pattern instead: the textarea restates `dsh-client-ui-message-feedback`'s
 * FeedbackDialog `detail` field, and the selector is `dsh-client-locale`'s
 * LanguageRow pill (a `Menu` anchored to a rounded button). Field labels, hints
 * and toggle rows follow `dsh-client-ui-settings-plugins`; the panel's cards
 * follow that package's plugin cards. Every colour is a
 * `--dsw-*` token.
 * @module dsh-buddy/client/form-css
 */

export const FORM_CLASS = {
	field: "dsh-buddy-field",
	label: "dsh-buddy-label",
	hint: "dsh-buddy-hint",
	error: "dsh-buddy-error",
	status: "dsh-buddy-status",
	input: "dsh-buddy-input",
	textarea: "dsh-buddy-textarea",
	selector: "dsh-buddy-selector",
	selectorLabel: "dsh-buddy-selector-label",
	chevron: "dsh-buddy-selector-chevron",
	toggleRow: "dsh-buddy-toggle-row",
	actions: "dsh-buddy-actions",
	group: "dsh-buddy-group",
	title: "dsh-buddy-group-title",
	panel: "dsh-buddy-panel",
	panelHeader: "dsh-buddy-panel-header",
	panelTitle: "dsh-buddy-panel-title",
	panelBody: "dsh-buddy-panel-body",
	card: "dsh-buddy-card",
	cardTitle: "dsh-buddy-card-title",
} as const;

const c = FORM_CLASS;

export const FORM_CSS = [
	`.${c.field}{display:flex;flex-direction:column;gap:6px;min-width:0}`,
	`.${c.label}{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:1.5}`,
	`.${c.hint}{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}`,
	`.${c.error}{margin:0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:1.5}`,
	`.${c.status}{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.5}`,
	`.${c.input}{box-sizing:border-box;width:100%}`,
	`.${c.textarea}{box-sizing:border-box;display:block;width:100%;min-height:160px;max-height:480px;padding:12px 14px;border:.5px solid var(--dsw-alias-border-l4);border-radius:16px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:var(--ds-font-family-code,monospace);font-size:13px;line-height:20px;resize:vertical;transition:border-color .12s,box-shadow .12s}`,
	`.${c.textarea}::placeholder{color:var(--dsw-alias-label-caption)}`,
	`.${c.textarea}:focus{outline:none;border-color:var(--dsw-alias-border-l3);box-shadow:0 0 0 1px var(--dsw-alias-border-l3)}`,
	`.${c.selector}{display:inline-flex;align-items:center;gap:12px;max-width:100%;height:36px;padding:0 14px;border:none;border-radius:18px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;cursor:pointer}`,
	`.${c.selector}:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}`,
	`.${c.selector}:disabled{cursor:not-allowed;opacity:.4}`,
	`.${c.selector}:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}`,
	`.${c.selectorLabel}{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}`,
	`.${c.chevron}{flex:none}`,
	`.${c.toggleRow}{display:flex;align-items:center;justify-content:space-between;gap:16px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}`,
	`.${c.actions}{display:flex;align-items:center;flex-wrap:wrap;gap:8px}`,
	`.${c.group}{display:flex;flex-direction:column;gap:12px;padding:12px 0}`,
	`.${c.group}:first-child{padding-top:0}`,
	`.${c.group}+.${c.group}{border-top:.5px solid var(--dsw-alias-border-l2)}`,
	`.${c.title}{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}`,
	`.${c.panel}{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}`,
	`.${c.panelHeader}{box-sizing:border-box;flex:none;display:flex;align-items:center;gap:8px;height:54px;padding:0 24px;border-bottom:.5px solid var(--dsw-alias-border-l2)}`,
	`.${c.panelTitle}{font-size:16px;font-weight:500;line-height:24px}`,
	`.${c.panelBody}{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:16px;padding:20px 24px 32px}`,
	`.${c.card}{display:flex;flex-direction:column;gap:12px;padding:16px 20px;border:.5px solid var(--dsw-alias-border-l4);border-radius:16px;background:var(--dsw-alias-bg-layer-3)}`,
	`.${c.cardTitle}{margin:0;color:var(--dsw-alias-label-primary);font-size:15px;font-weight:500;line-height:24px}`,
	`@media (prefers-reduced-motion:reduce){.${c.textarea}{transition:none}}`,
].join("");

/** Marks the injected tag. */
export const FORM_CSS_ID = "dsh-buddy/form.css";
