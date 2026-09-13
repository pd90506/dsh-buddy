/**
 * The Buddy folder at the sidebar foot, directly above Settings.
 *
 * The title opens the Buddy main panel; the chevron lists buddy conversations.
 * The client session list carries no preset, so the rows come from the host's
 * `buddyPersona/sessions`, re-read whenever the client list changes.
 * @module dsh-buddy/client/folder
 */
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { Call } from "./call.ts";
import { createBuddyIcon } from "./panel.tsx";

/** One buddy conversation; mirrors the host's `BuddySessionSummary`. */
interface Summary {
	sessionId: string;
	title: string;
	updatedAt: number;
	cwd: string;
	source: "telegram" | "web";
}

/** Collaborators supplied by the plugin's `apply`. */
export interface FolderDeps {
	call: Call;
	t(key: string): string;
	openPanel(): void;
	openSession(sessionId: string): void;
	list: { getSnapshot(): { current?: string | undefined }; subscribe(listener: () => void): () => void };
	expanded: { read(): boolean; write(value: boolean): void };
	/** Debounce for reloads triggered by session-list changes; tests pass 0. */
	reloadDelayMs: number;
}

const styles = {
	root: { width: "100%", display: "flex", flexDirection: "column" },
	header: { display: "flex", alignItems: "center", gap: 4, width: "100%" },
	title: {
		flex: 1,
		display: "flex",
		alignItems: "center",
		gap: 8,
		padding: "6px 8px",
		border: "none",
		background: "transparent",
		color: "inherit",
		cursor: "pointer",
		fontSize: 13,
		textAlign: "left",
	},
	chevron: { border: "none", background: "transparent", color: "inherit", cursor: "pointer", padding: "4px 6px" },
	list: { maxHeight: "40vh", overflowY: "auto", display: "flex", flexDirection: "column", gap: 2, paddingLeft: 20 },
	row: {
		display: "flex",
		alignItems: "center",
		gap: 6,
		padding: "4px 8px",
		borderRadius: 6,
		border: "none",
		background: "transparent",
		color: "inherit",
		cursor: "pointer",
		fontSize: 13,
		textAlign: "left",
	},
	rowCurrent: { background: "var(--dsw-alias-fill-secondary, rgba(127,127,127,.12))" },
	badge: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)" },
	muted: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)", padding: "4px 8px" },
	rail: { border: "none", background: "transparent", color: "inherit", cursor: "pointer", padding: 8 },
} as const;

/**
 * @param deps - RPC, locale, navigation, the client session list and persisted expansion.
 * @returns the `sidebar.footer.action` component.
 */
export function createBuddyFolder(deps: FolderDeps): (props: { wide: boolean }) => unknown {
	// Cast once, for the same reason `panel.tsx`'s `ModuleComponent` is cast: the
	// icon's own return type is `unknown` (like every component in this file),
	// and TS's JSX component check wants `ReactNode` — the value itself is an
	// ordinary component reference either way, so this changes nothing at runtime.
	const Icon = createBuddyIcon() as unknown as (props: { size?: number }) => ReactNode;
	return function BuddyFolder(props: { wide: boolean }): unknown {
		const [open, setOpen] = useState(() => deps.expanded.read());
		const [items, setItems] = useState<Summary[] | undefined>(undefined);
		const [error, setError] = useState<string | undefined>(undefined);
		const [current, setCurrent] = useState(() => deps.list.getSnapshot().current);

		const load = useCallback(async (): Promise<void> => {
			try {
				setItems((await deps.call("buddyPersona/sessions", {})) as Summary[]);
				setError(undefined);
			} catch (cause) {
				setError((cause as Error).message);
			}
		}, []);

		useEffect(() => {
			if (open) void load();
		}, [open, load]);

		useEffect(() => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const unsubscribe = deps.list.subscribe(() => {
				setCurrent(deps.list.getSnapshot().current);
				if (!open) return;
				if (timer !== undefined) clearTimeout(timer);
				timer = setTimeout(() => void load(), deps.reloadDelayMs);
			});
			return () => {
				if (timer !== undefined) clearTimeout(timer);
				unsubscribe();
			};
		}, [open, load]);

		if (!props.wide) {
			return (
				<button style={styles.rail} type="button" aria-label={deps.t("folderTitle")} onClick={() => deps.openPanel()}>
					<Icon size={18} />
				</button>
			);
		}

		const toggle = (): void => {
			deps.expanded.write(!open);
			setOpen(!open);
		};

		return (
			<div style={styles.root}>
				<div style={styles.header}>
					<button style={styles.title} type="button" aria-label={deps.t("folderTitle")} onClick={() => deps.openPanel()}>
						<Icon size={16} />
						<span>{deps.t("folderTitle")}</span>
					</button>
					<button
						style={styles.chevron}
						type="button"
						aria-label={deps.t(open ? "collapse" : "expand")}
						aria-expanded={open ? "true" : "false"}
						onClick={toggle}
					>
						{open ? "▾" : "▸"}
					</button>
				</div>
				{open && (
					<div style={styles.list}>
						{error !== undefined && <div style={styles.muted}>{error}</div>}
						{error === undefined && items !== undefined && items.length === 0 && (
							<div style={styles.muted}>{deps.t("folderEmpty")}</div>
						)}
						{items?.map((item) => {
							const label = item.title.trim() === "" ? deps.t("untitled") : item.title;
							const isCurrent = item.sessionId === current;
							return (
								<button
									key={item.sessionId}
									style={isCurrent ? { ...styles.row, ...styles.rowCurrent } : styles.row}
									type="button"
									aria-label={label}
									aria-current={isCurrent ? "true" : "false"}
									onClick={() => deps.openSession(item.sessionId)}
								>
									<span>{label}</span>
									{item.source === "telegram" && <span style={styles.badge}>{deps.t("fromTelegram")}</span>}
								</button>
							);
						})}
					</div>
				)}
			</div>
		);
	};
}
