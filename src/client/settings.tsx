/**
 * The **Buddy** tab in the Settings left nav.
 *
 * It edits two files through this plugin's own `buddyPersona/*` endpoints:
 * SOUL.md (voice) and AGENTS.md (rules). Nothing secret passes through here, so
 * there is no credentials traffic — the persona is ordinary authored prose.
 *
 * The two documents are edited side by side but stay separate on disk, because
 * only SOUL.md reaches the prompt as `{{buddySoul}}`; merging them would put
 * operating rules into the voice variable.
 * @module dsh-buddy/client/settings
 */
import { useCallback, useEffect, useState } from "react";
import type { Call } from "./call.ts";

/** What the tab renders; mirrors the host's `PersonaView`. */
interface PersonaView {
	soul: string;
	agents: string;
	home: string;
	lastWriteAt?: string;
}

/** Collaborators supplied by the plugin's `apply`. */
export interface SettingsDeps {
	/** Unwrapped RPC: resolves the endpoint's payload or throws. */
	call: Call;
	/** Locale lookup bound to this plugin's namespace. */
	t(key: string): string;
}

const styles = {
	page: { display: "flex", flexDirection: "column", gap: 20, padding: "4px 2px" },
	block: { display: "flex", flexDirection: "column", gap: 8 },
	label: { fontSize: 13, fontWeight: 600 },
	hint: { fontSize: 12, color: "var(--dsw-alias-label-secondary)", margin: 0 },
	error: { fontSize: 13, color: "var(--dsw-alias-status-error, #d64545)", margin: 0 },
	area: {
		minHeight: 160,
		fontFamily: "var(--dsw-font-mono, monospace)",
		fontSize: 13,
		padding: 8,
		borderRadius: 6,
		border: "1px solid var(--dsw-alias-border, #ccc)",
		background: "var(--dsw-alias-fill-input, transparent)",
		color: "inherit",
		resize: "vertical",
	},
	row: { display: "flex", alignItems: "center", gap: 8 },
	button: { padding: "6px 14px", borderRadius: 6, cursor: "pointer" },
} as const;

/**
 * Build the settings section component.
 * @param deps - RPC and locale collaborators.
 * @returns the component the slot renders.
 */
export function createBuddySettingsSection(deps: SettingsDeps): () => unknown {
	return function BuddySettingsSection(): unknown {
		const [view, setView] = useState<PersonaView | undefined>(undefined);
		const [soul, setSoul] = useState("");
		const [agents, setAgents] = useState("");
		const [busy, setBusy] = useState(false);
		const [error, setError] = useState<string | undefined>(undefined);

		const load = useCallback(async (): Promise<void> => {
			try {
				const next = (await deps.call("buddyPersona/persona", {})) as PersonaView;
				setView(next);
				setSoul(next.soul);
				setAgents(next.agents);
				setError(undefined);
			} catch (cause) {
				setError((cause as Error).message);
			}
		}, []);

		useEffect(() => {
			void load();
		}, [load]);

		const save = async (): Promise<void> => {
			// Never write before a successful load. `soul` and `agents` start empty,
			// so a save attempted while the mount load is still in flight — or after
			// it failed, which is exactly what the error banner above is reporting —
			// would send `{ patch: { soul: "", agents: "" } }` and truncate both
			// SOUL.md and AGENTS.md. The host cannot defend against that: its rule is
			// to drop non-string fields, and `""` is a string, so "the user cleared
			// this box" and "this box never loaded" look identical on the wire. Only
			// this side knows which one it is, so the guard belongs here — on the
			// button (`disabled`, below) and again on the path itself, because a
			// disabled attribute is a browser courtesy, not an invariant.
			if (view === undefined) return;
			setBusy(true);
			try {
				const next = (await deps.call("buddyPersona/updatePersona", { patch: { soul, agents } })) as PersonaView;
				setView(next);
				setError(undefined);
			} catch (cause) {
				setError((cause as Error).message);
			} finally {
				setBusy(false);
			}
		};

		return (
			<div style={styles.page}>
				<section style={styles.block}>
					<div style={styles.label}>{deps.t("soulTitle")}</div>
					<p style={styles.hint}>{deps.t("soulHint")}</p>
					<textarea
						style={styles.area}
						value={soul}
						onChange={(event: { target: { value: string } }) => setSoul(event.target.value)}
					/>
				</section>

				<section style={styles.block}>
					<div style={styles.label}>{deps.t("rulesTitle")}</div>
					<p style={styles.hint}>{deps.t("rulesHint")}</p>
					<textarea
						style={styles.area}
						value={agents}
						onChange={(event: { target: { value: string } }) => setAgents(event.target.value)}
					/>
				</section>

				<div style={styles.row}>
					<button
						style={styles.button}
						type="button"
						disabled={busy || view === undefined}
						onClick={() => void save()}
					>
						{deps.t("save")}
					</button>
					{view !== undefined && <span style={styles.hint}>{`${deps.t("homeLabel")} ${view.home}`}</span>}
				</div>
				{error !== undefined && <p style={styles.error}>{error}</p>}
			</div>
		);
	};
}
