/**
 * The **Buddy** tab in Settings: settings *about* Buddy's surfaces — which
 * main-panel modules show — and where Buddy's files live. Buddy itself is
 * configured from the main panel.
 * @module dsh-buddy/client/settings
 */
import { useCallback, useEffect, useState } from "react";
import type { Call } from "./call.ts";
import type { Notifier } from "./notifier.ts";
import { PANEL_SECTION_IDS, type PanelSectionId } from "../config.ts";

/** Collaborators supplied by the plugin's `apply`. */
export interface SettingsDeps {
	call: Call;
	t(key: string): string;
	/** Notified after a successful `updatePreferences`, so the main panel can reload live. */
	preferencesChanged: Notifier;
}

const TITLE_KEYS: Record<PanelSectionId, string> = {
	soul: "soulTitle",
	agents: "agentsTitle",
	model: "modelTitle",
	telegram: "telegramTitle",
};

const styles = {
	page: { display: "flex", flexDirection: "column", gap: 16, padding: "4px 2px" },
	label: { fontSize: 13, fontWeight: 600 },
	hint: { fontSize: 12, color: "var(--dsw-alias-label-secondary)", margin: 0 },
	error: { fontSize: 13, color: "var(--dsw-alias-status-error, #d64545)", margin: 0 },
	row: { display: "flex", alignItems: "center", gap: 8 },
} as const;

/**
 * @param deps - RPC and locale.
 * @returns the component the `settings.section` slot renders.
 */
export function createBuddySettingsSection(deps: SettingsDeps): () => unknown {
	return function BuddySettingsSection(): unknown {
		const [sections, setSections] = useState<Record<PanelSectionId, boolean> | undefined>(undefined);
		const [home, setHome] = useState<string | undefined>(undefined);
		const [error, setError] = useState<string | undefined>(undefined);

		const load = useCallback(async (): Promise<void> => {
			try {
				const [prefs, persona] = await Promise.all([
					deps.call("buddyPersona/preferences", {}),
					deps.call("buddyPersona/persona", {}),
				]);
				setSections((prefs as { panel: { sections: Record<PanelSectionId, boolean> } }).panel.sections);
				setHome((persona as { home: string }).home);
				setError(undefined);
			} catch (cause) {
				setError((cause as Error).message);
			}
		}, []);

		useEffect(() => {
			void load();
		}, [load]);

		const toggle = async (id: PanelSectionId, checked: boolean): Promise<void> => {
			if (sections === undefined) return;
			const next = { ...sections, [id]: checked };
			setSections(next);
			try {
				const prefs = (await deps.call("buddyPersona/updatePreferences", { patch: { panel: { sections: next } } })) as {
					panel: { sections: Record<PanelSectionId, boolean> };
				};
				setSections(prefs.panel.sections);
				setError(undefined);
				deps.preferencesChanged.notify();
			} catch (cause) {
				setError((cause as Error).message);
			}
		};

		return (
			<div style={styles.page}>
				<p style={styles.hint}>{deps.t("settingsHint")}</p>
				<div style={styles.label}>{deps.t("sectionsTitle")}</div>
				{sections !== undefined &&
					PANEL_SECTION_IDS.map((id) => (
						<label key={id} style={styles.row}>
							<input
								type="checkbox"
								name={id}
								checked={sections[id]}
								onChange={(event: { target: { checked: boolean } }) => void toggle(id, event.target.checked)}
							/>
							<span>{deps.t(TITLE_KEYS[id])}</span>
						</label>
					))}
				{home !== undefined && <p style={styles.hint}>{`${deps.t("homeLabel")} ${home}`}</p>}
				{error !== undefined && <p style={styles.error}>{error}</p>}
			</div>
		);
	};
}
