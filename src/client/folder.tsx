/**
 * The Buddy folder at the sidebar foot, directly above Settings.
 *
 * The entry opens the Buddy main panel; the chevron lists buddy conversations.
 * It is styled as the sidebar's own rows (see `./folder-css.ts`), and
 * `apply` installs that stylesheet alongside the registration.
 * The client session list carries no preset, so the rows come from the host's
 * `buddyPersona/sessions`, re-read whenever the client list changes.
 * @module dsh-buddy/client/folder
 */
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Button, IconChevronRightOutline14, Menu } from "@deepseek-ai/dsh-client-ui-primitives";
import type { Call } from "./call.ts";
import { FOLDER_CLASS } from "./folder-css.ts";
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
	/** Debounce for reloads triggered by session-list changes; production uses 500ms, tests wait past it. */
	reloadDelayMs: number;
}

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

	// A component, not an inline map body: each row owns its menu-open state, so it
	// must be its own React instance (Rules of Hooks) — the same reason the main
	// panel renders modules as `<Module />`.
	function ConversationRow(props: {
		item: Summary;
		isCurrent: boolean;
		onOpen(): void;
		onArchive(): void;
	}): ReactNode {
		const [menuOpen, setMenuOpen] = useState(false);
		const label = props.item.title.trim() === "" ? deps.t("untitled") : props.item.title;
		return (
			<div className={props.isCurrent ? `${FOLDER_CLASS.sessionRow} ${FOLDER_CLASS.selected}` : FOLDER_CLASS.sessionRow}>
				<button
					className={FOLDER_CLASS.session}
					type="button"
					aria-label={label}
					aria-current={props.isCurrent ? "true" : "false"}
					onClick={props.onOpen}
				>
					<span className={FOLDER_CLASS.title}>{label}</span>
					{props.item.source === "telegram" && <span className={FOLDER_CLASS.meta}>{deps.t("fromTelegram")}</span>}
				</button>
				<Menu
					open={menuOpen}
					onClose={() => setMenuOpen(false)}
					items={[{ id: "archive", label: deps.t("archive") }]}
					onSelect={(id: string) => {
						setMenuOpen(false);
						if (id === "archive") props.onArchive();
					}}
					align="end"
					portal
					anchor={
						<Button
							variant="ghost"
							size="sm"
							className={FOLDER_CLASS.more}
							aria-label={deps.t("more")}
							onClick={() => setMenuOpen((value) => !value)}
						>
							⋯
						</Button>
					}
				/>
			</div>
		);
	}

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

		// Archive answers with the fresh list, so the row drops without a second
		// round trip to `sessions`.
		const archive = useCallback(async (sessionId: string): Promise<void> => {
			try {
				setItems((await deps.call("buddyPersona/archiveSession", { sessionId })) as Summary[]);
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
				<div className={`${FOLDER_CLASS.entryRow} ${FOLDER_CLASS.rail}`}>
					<button className={FOLDER_CLASS.entry} type="button" aria-label={deps.t("folderTitle")} onClick={() => deps.openPanel()}>
						<Icon size={18} />
					</button>
				</div>
			);
		}

		const toggle = (): void => {
			deps.expanded.write(!open);
			setOpen(!open);
		};

		return (
			<div className={FOLDER_CLASS.root}>
				<div className={FOLDER_CLASS.entryRow}>
					<button className={FOLDER_CLASS.entry} type="button" aria-label={deps.t("folderTitle")} onClick={() => deps.openPanel()}>
						<Icon size={16} />
						<span className={FOLDER_CLASS.label}>{deps.t("folderTitle")}</span>
					</button>
					<button
						className={FOLDER_CLASS.toggle}
						type="button"
						aria-label={deps.t(open ? "collapse" : "expand")}
						aria-expanded={open ? "true" : "false"}
						onClick={toggle}
					>
						<IconChevronRightOutline14
							size={14}
							className={open ? `${FOLDER_CLASS.arrow} ${FOLDER_CLASS.arrowOpen}` : FOLDER_CLASS.arrow}
						/>
					</button>
				</div>
				{open && (
					<div className={FOLDER_CLASS.list}>
						{error !== undefined && <div className={FOLDER_CLASS.muted}>{error}</div>}
						{error === undefined && items !== undefined && items.length === 0 && (
							<div className={FOLDER_CLASS.muted}>{deps.t("folderEmpty")}</div>
						)}
						{items?.map((item) => (
							<ConversationRow
								key={item.sessionId}
								item={item}
								isCurrent={item.sessionId === current}
								onOpen={() => deps.openSession(item.sessionId)}
								onArchive={() => void archive(item.sessionId)}
							/>
						))}
					</div>
				)}
			</div>
		);
	};
}
