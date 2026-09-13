/**
 * The Buddy main panel: Buddy's own configuration as a master-detail split — a
 * left sub-nav of the visible modules beside the active module's content pane.
 * Conversations are listed in the sidebar folder, not here.
 * @module dsh-buddy/client/panel
 */
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { Call } from "./call.ts";
import { FORM_CLASS } from "./form-css.ts";
import { visibleModules, type PanelModule } from "./modules.ts";
import type { Notifier } from "./notifier.ts";
import type { PanelSectionId } from "../index.ts";

/** Collaborators supplied by the plugin's `apply`. */
export interface PanelDeps {
	call: Call;
	t(key: string): string;
	modules: readonly PanelModule<() => unknown>[];
	/** Fires when the Settings tab changes which modules are visible, so this mounted panel can reload without remounting. */
	preferencesChanged: Notifier;
}

/**
 * @param deps - RPC, locale, the module table and the preferences notifier.
 * @returns the component the `main` slot renders under `MAIN_PANEL_KEY`.
 */
export function createBuddyPanel(deps: PanelDeps): () => unknown {
	return function BuddyPanel(): unknown {
		const [sections, setSections] = useState<Partial<Record<PanelSectionId, boolean>> | undefined>(undefined);
		const [error, setError] = useState<string | undefined>(undefined);
		// Which module the sub-nav has selected. Empty until the first load picks
		// the first visible one; a still-visible selection survives a reload.
		const [active, setActive] = useState<PanelSectionId | undefined>(undefined);

		const load = useCallback(async (): Promise<void> => {
			try {
				const prefs = (await deps.call("buddyPersona/preferences", {})) as {
					panel: { sections: Record<PanelSectionId, boolean> };
				};
				setSections(prefs.panel.sections);
				setError(undefined);
			} catch (cause) {
				// Visibility is a convenience: on failure every module shows.
				setSections({});
				setError((cause as Error).message);
			}
		}, []);

		useEffect(() => {
			void load();
		}, [load]);

		// The settings tab and this panel are separate component trees mounted
		// from the same `apply(ctx)`, so a settings-side toggle cannot reach this
		// panel through props or context — only through the shared notifier.
		useEffect(() => deps.preferencesChanged.subscribe(() => void load()), [load]);

		// The selected module, falling back to the first visible one — so a module
		// hidden from the Settings tab while it was active hands off to a neighbour
		// rather than leaving the content column blank.
		const visible = sections === undefined ? [] : visibleModules(deps.modules, sections);
		const current = visible.find((module) => module.id === active)?.id ?? visible[0]?.id;

		return (
			<div className={FORM_CLASS.panel}>
				<div className={FORM_CLASS.panelHeader}>
					<span className={FORM_CLASS.panelTitle}>{deps.t("panelTitle")}</span>
				</div>
				<div className={FORM_CLASS.panelBody}>
					{error !== undefined && <p className={FORM_CLASS.error}>{error}</p>}
					{sections !== undefined && (
						<div className={FORM_CLASS.split}>
							<nav className={FORM_CLASS.subnav} aria-label={deps.t("panelTitle")}>
								{visible.map((module) => (
									<button
										key={module.id}
										type="button"
										className={
											module.id === current
												? `${FORM_CLASS.subnavItem} ${FORM_CLASS.subnavItemActive}`
												: FORM_CLASS.subnavItem
										}
										aria-current={module.id === current ? "page" : undefined}
										onClick={() => setActive(module.id)}
									>
										{deps.t(module.titleKey)}
									</button>
								))}
							</nav>
							<div className={FORM_CLASS.content}>
								{visible.map((module) => {
									// A capitalised local, not `<module.Component />` directly: every
									// module's return type is `unknown` (like `BuddyPanel`'s own,
									// below), and TS's JSX component check wants `ReactNode` — the
									// member expression itself is a perfectly ordinary component
									// reference either way (JSX only treats a lower-case *bare
									// identifier* as a host tag; a member expression is always a
									// value reference), so this cast changes nothing at runtime.
									//
									// Every visible module is mounted; the inactive ones are hidden
									// by class, not unmounted, so a half-typed SOUL.md survives a
									// hop to another module and back.
									const ModuleComponent = module.Component as unknown as () => ReactNode;
									return (
										<section
											key={module.id}
											className={
												module.id === current
													? FORM_CLASS.contentPane
													: `${FORM_CLASS.contentPane} ${FORM_CLASS.contentPaneHidden}`
											}
										>
											<ModuleComponent />
										</section>
									);
								})}
							</div>
						</div>
					)}
				</div>
			</div>
		);
	};
}

/**
 * Build the Buddy glyph.
 *
 * The sidebar folder (`src/client/folder.tsx`) owns the button, its label and
 * its expanded state; this supplies only the glyph, sized to whatever the
 * caller asks for.
 * @returns the glyph component.
 */
export function createBuddyIcon(): (props: { size?: number }) => unknown {
	return function BuddyIcon(props: { size?: number }): unknown {
		const size = props.size ?? 16;
		return (
			<svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
				<circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
				<circle cx="9" cy="10.5" r="1.2" fill="currentColor" />
				<circle cx="15" cy="10.5" r="1.2" fill="currentColor" />
				<path d="M8.5 15c1 1 2.2 1.5 3.5 1.5s2.5-.5 3.5-1.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
			</svg>
		);
	};
}
