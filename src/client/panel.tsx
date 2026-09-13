/**
 * The Buddy main panel: Buddy's own configuration, one module per card.
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

		return (
			<div className={FORM_CLASS.panel}>
				<div className={FORM_CLASS.panelHeader}>
					<span className={FORM_CLASS.panelTitle}>{deps.t("panelTitle")}</span>
				</div>
				<div className={FORM_CLASS.panelBody}>
					{error !== undefined && <p className={FORM_CLASS.error}>{error}</p>}
					{sections !== undefined &&
						visibleModules(deps.modules, sections).map((module) => {
							// A capitalised local, not `<module.Component />` directly: every
							// module's return type is `unknown` (like `BuddyPanel`'s own,
							// below), and TS's JSX component check wants `ReactNode` — the
							// member expression itself is a perfectly ordinary component
							// reference either way (JSX only treats a lower-case *bare
							// identifier* as a host tag; a member expression is always a
							// value reference), so this cast changes nothing at runtime.
							const ModuleComponent = module.Component as unknown as () => ReactNode;
							return (
								<section key={module.id} className={FORM_CLASS.card}>
									<h3 className={FORM_CLASS.cardTitle}>{deps.t(module.titleKey)}</h3>
									<ModuleComponent />
								</section>
							);
						})}
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
