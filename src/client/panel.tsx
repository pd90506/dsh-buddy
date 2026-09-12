/**
 * The dsh-buddy main panel: the command centre, not a chat client.
 *
 * Clicking a conversation hands off to the shipped conversation view rather
 * than rendering messages here. That is a deliberate scope decision: the
 * official view already owns message rendering, tool cards, approvals,
 * streaming and attachments, and re-implementing them would both cost thousands
 * of lines and drift behind the product.
 * @module dsh-buddy/client/panel
 */
import { useCallback, useEffect, useState } from "react";

/** One buddy conversation; mirrors the host's `BuddySessionSummary`. */
interface BuddySessionSummary {
	sessionId: string;
	title: string;
	updatedAt: number;
	cwd: string;
}

/** Collaborators supplied by the plugin's `apply`. */
export interface PanelDeps {
	/** Unwrapped RPC: resolves the endpoint's payload or throws. */
	call(endpoint: string, args: unknown): Promise<unknown>;
	/** Locale lookup bound to this plugin's namespace. */
	t(key: string): string;
	/** Open a session in the shipped conversation view and leave this panel. */
	openSession(sessionId: string): void;
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
	body: { flex: 1, minHeight: 0, overflowY: "auto", padding: "12px 20px" },
	sectionLabel: { fontSize: 12, fontWeight: 600, color: "var(--dsw-alias-label-secondary)", margin: "4px 0 8px" },
	row: {
		display: "flex",
		flexDirection: "column",
		gap: 2,
		width: "100%",
		textAlign: "left",
		padding: "10px 12px",
		marginBottom: 6,
		borderRadius: 8,
		border: "1px solid transparent",
		background: "var(--dsw-alias-fill-secondary, rgba(127,127,127,.08))",
		cursor: "pointer",
		color: "inherit",
	},
	rowTitle: { fontSize: 14 },
	rowMeta: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" },
	empty: { fontSize: 13, color: "var(--dsw-alias-label-secondary)" },
	error: { fontSize: 13, color: "var(--dsw-alias-status-error, #d64545)" },
	button: { padding: "4px 12px", borderRadius: 6, cursor: "pointer" },
} as const;

/**
 * Build the main-panel component.
 * @param deps - RPC, locale and navigation collaborators.
 * @returns the component the `main` slot renders under the `dsh-buddy` key.
 */
export function createBuddyPanel(deps: PanelDeps): () => unknown {
	return function BuddyPanel(): unknown {
		const [items, setItems] = useState<BuddySessionSummary[] | undefined>(undefined);
		const [error, setError] = useState<string | undefined>(undefined);

		const load = useCallback(async (): Promise<void> => {
			try {
				setItems((await deps.call("buddyPersona/sessions", {})) as BuddySessionSummary[]);
				setError(undefined);
			} catch (cause) {
				setError((cause as Error).message);
			}
		}, []);

		useEffect(() => {
			void load();
		}, [load]);

		return (
			<div style={styles.panel}>
				<div style={styles.header}>
					<span style={styles.title}>{deps.t("panelTitle")}</span>
					<button style={styles.button} type="button" onClick={() => void load()}>
						{deps.t("refresh")}
					</button>
				</div>
				<div style={styles.body}>
					<div style={styles.sectionLabel}>{deps.t("conversations")}</div>
					{error !== undefined && <div style={styles.error}>{error}</div>}
					{error === undefined && items !== undefined && items.length === 0 && (
						<div style={styles.empty}>{deps.t("empty")}</div>
					)}
					{items?.map((item) => (
						<button
							key={item.sessionId}
							style={styles.row}
							type="button"
							onClick={() => deps.openSession(item.sessionId)}
						>
							<span style={styles.rowTitle}>{item.title.trim() === "" ? deps.t("untitled") : item.title}</span>
							{item.cwd !== "" && <span style={styles.rowMeta}>{item.cwd}</span>}
						</button>
					))}
				</div>
			</div>
		);
	};
}

/**
 * Build the sidebar row's icon.
 *
 * The sidebar owns the button, its label and its selected state; an occupant
 * supplies only the glyph, sized to the geometry the row asks for.
 * @returns the component the `sidebar.panellist` slot renders.
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
