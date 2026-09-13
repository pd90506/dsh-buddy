/**
 * The Buddy main panel: Buddy's own configuration, one module per card.
 * Conversations are listed in the sidebar folder, not here.
 * @module dsh-buddy/client/panel
 */
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { Call } from "./call.ts";
import { visibleModules, type PanelModule } from "./modules.ts";
import type { Notifier } from "./notifier.ts";
import type { PanelSectionId } from "../config.ts";

/** Collaborators supplied by the plugin's `apply`. */
export interface PanelDeps {
	call: Call;
	t(key: string): string;
	modules: readonly PanelModule<() => unknown>[];
	/** Create, configure and open a new buddy conversation; rejects with a displayable message. */
	newConversation(): Promise<void>;
	/** Fires when the Settings tab changes which modules are visible, so this mounted panel can reload without remounting. */
	preferencesChanged: Notifier;
}

const styles = {
	panel: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0 },
	header: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 12,
		padding: "14px 20px",
		borderBottom: "1px solid var(--dsw-alias-border, #e5e5e5)",
	},
	title: { fontSize: 15, fontWeight: 600 },
	body: { flex: 1, minHeight: 0, overflowY: "auto", padding: "16px 20px", display: "flex", flexDirection: "column", gap: 16 },
	card: {
		background: "var(--dsw-alias-bg-layer-3)",
		border: "0.5px solid var(--dsw-alias-border-l2)",
		borderRadius: 10,
		padding: "14px 16px",
		display: "flex",
		flexDirection: "column",
		gap: 10,
	},
	cardTitle: { fontSize: 14, fontWeight: 600, margin: 0 },
	error: { fontSize: 13, color: "var(--dsw-alias-status-error, #d64545)", margin: 0 },
	button: { padding: "6px 14px", borderRadius: 6, cursor: "pointer" },
} as const;

/**
 * @param deps - RPC, locale, the module table and the create action.
 * @returns the component the `main` slot renders under `MAIN_PANEL_KEY`.
 */
export function createBuddyPanel(deps: PanelDeps): () => unknown {
	return function BuddyPanel(): unknown {
		const [sections, setSections] = useState<Partial<Record<PanelSectionId, boolean>> | undefined>(undefined);
		const [error, setError] = useState<string | undefined>(undefined);
		const [busy, setBusy] = useState(false);

		const load = useCallback(async (): Promise<void> => {
			try {
				const prefs = (await deps.call("buddyPersona/preferences", {})) as {
					panel: { sections: Record<PanelSectionId, boolean> };
				};
				setSections(prefs.panel.sections);
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

		const create = async (): Promise<void> => {
			setBusy(true);
			try {
				await deps.newConversation();
				setError(undefined);
			} catch (cause) {
				setError((cause as Error).message);
			} finally {
				setBusy(false);
			}
		};

		return (
			<div style={styles.panel}>
				<div style={styles.header}>
					<span style={styles.title}>{deps.t("panelTitle")}</span>
					<button style={styles.button} type="button" disabled={busy} onClick={() => void create()}>
						{deps.t("newConversation")}
					</button>
				</div>
				<div style={styles.body}>
					{error !== undefined && <p style={styles.error}>{error}</p>}
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
								<section key={module.id} style={styles.card}>
									<h3 style={styles.cardTitle}>{deps.t(module.titleKey)}</h3>
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
