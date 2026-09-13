/**
 * The Telegram module: bot token, configuration and live status.
 *
 * Ported from `dsh-telegram`'s own Settings tab (`TelegramSection`) into a
 * Buddy main-panel module: the endpoints move to this plugin's own
 * `buddyTelegram/*` namespace, the card chrome (title, description) is dropped
 * because the panel already supplies the card and its title, and every locale
 * key moves into Buddy's own `settings.buddy` namespace under a `telegram`
 * prefix so it cannot collide with `dsh-telegram`'s own dictionary.
 * @module dsh-buddy/client/telegram-module
 */
import { useCallback, useEffect, useState } from "react";
import type { Call } from "./call.ts";

/** The settings section as the host reports it. */
interface Config {
	enabled: boolean;
	ownerUserId: string;
	defaultCwd: string;
	permissionPreset: string;
	renderMarkdown: boolean;
	mediaDelivery: string;
}

/** Runtime status as the host reports it. */
interface Status {
	state: "off" | "starting" | "running" | "error";
	detail?: string | undefined;
	botUsername?: string | undefined;
	token: { configured: boolean; source?: unknown; writable: boolean };
	sessions: number;
}

/**
 * Render a credential source only when it is printable.
 *
 * The credentials plane is free to describe a source as a richer object, and a
 * React child that is an object throws — a crash in the main panel is a much
 * worse outcome than a missing provenance hint.
 * @param source - whatever `describe` reported.
 * @returns the source text, or an empty string.
 */
function sourceLabel(source: unknown): string {
	return typeof source === "string" && source !== "" ? ` · ${source}` : "";
}

/** Collaborators supplied by the plugin's `apply`. */
export interface TelegramModuleDeps {
	call: Call;
	t(key: string): string;
	/** Write (or, when `undefined`, clear) the bot token through `remote.credentials`. */
	writeToken(value: string | undefined): Promise<void>;
}

const styles = {
	block: {
		background: "var(--dsw-alias-bg-layer-3)",
		border: "0.5px solid var(--dsw-alias-border-l2)",
		borderRadius: 10,
		padding: "14px 16px",
		display: "flex",
		flexDirection: "column",
		gap: 12,
	},
	field: { display: "flex", flexDirection: "column", gap: 4 },
	hint: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)", margin: "4px 0 0", lineHeight: 1.5 },
	label: { fontSize: 13, fontWeight: 500, color: "var(--dsw-alias-label-primary)" },
	input: {
		fontSize: 13,
		padding: "6px 8px",
		borderRadius: 6,
		border: "0.5px solid var(--dsw-alias-border-l2)",
		background: "var(--dsw-alias-bg-base)",
		color: "var(--dsw-alias-label-primary)",
	},
	row: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" as const },
	button: {
		fontSize: 13,
		padding: "6px 12px",
		borderRadius: 6,
		border: "0.5px solid var(--dsw-alias-border-l2)",
		background: "var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base))",
		color: "var(--dsw-alias-label-primary)",
		cursor: "pointer",
	},
	status: { fontSize: 13, color: "var(--dsw-alias-label-secondary)", margin: 0 },
	error: { fontSize: 13, color: "var(--dsw-alias-status-error, #d64545)", margin: 0 },
} as const;

/**
 * @param deps - RPC, locale and the credential writer.
 * @returns the module component.
 */
export function createTelegramModule(deps: TelegramModuleDeps): () => unknown {
	return function TelegramModule(): unknown {
		const [config, setConfig] = useState<Config | undefined>(undefined);
		const [status, setStatus] = useState<Status | undefined>(undefined);
		const [draft, setDraft] = useState<Partial<Config>>({});
		const [tokenDraft, setTokenDraft] = useState("");
		const [busy, setBusy] = useState(false);
		const [error, setError] = useState<string | undefined>(undefined);
		const [notice, setNotice] = useState<string | undefined>(undefined);

		const load = useCallback(async (): Promise<void> => {
			try {
				const [nextConfig, nextStatus] = await Promise.all([
					deps.call("buddyTelegram/config", {}),
					deps.call("buddyTelegram/status", {}),
				]);
				setConfig(nextConfig as Config);
				setStatus(nextStatus as Status);
				setError(undefined);
			} catch (failure) {
				setError((failure as Error).message);
			}
		}, []);

		useEffect(() => {
			void load();
		}, [load]);

		const effective: Config | undefined = config === undefined ? undefined : { ...config, ...draft };

		const save = async (patch: Partial<Config>): Promise<void> => {
			setBusy(true);
			setNotice(undefined);
			try {
				const next = (await deps.call("buddyTelegram/updateConfig", { patch })) as Config;
				setConfig(next);
				setDraft({});
				setNotice(deps.t("telegramSaved"));
				setStatus((await deps.call("buddyTelegram/status", {})) as Status);
				setError(undefined);
			} catch (failure) {
				setError((failure as Error).message);
			} finally {
				setBusy(false);
			}
		};

		if (effective === undefined || status === undefined) {
			return error === undefined ? <p style={styles.status}>{deps.t("telegramLoading")}</p> : <p style={styles.error}>{error}</p>;
		}

		const stateLabel =
			status.state === "running"
				? deps.t("telegramStatusRunning")
				: status.state === "starting"
					? deps.t("telegramStatusStarting")
					: status.state === "error"
						? deps.t("telegramStatusError")
						: deps.t("telegramStatusOff");

		return (
			<div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
				{notice !== undefined && <p style={styles.status}>{notice}</p>}
				{error !== undefined && <p style={styles.error}>{error}</p>}

				<section style={styles.block}>
					<div>
						<div style={styles.label}>{deps.t("telegramTokenTitle")}</div>
						<p style={styles.hint}>{deps.t("telegramTokenHint")}</p>
					</div>
					<p style={styles.status}>
						{status.token.configured ? deps.t("telegramTokenConfigured") : deps.t("telegramTokenMissing")}
						{sourceLabel(status.token.source)}
						{` · ${status.token.writable ? deps.t("telegramTokenWritable") : deps.t("telegramTokenReadOnly")}`}
					</p>
					<div style={styles.row}>
						<input
							style={{ ...styles.input, flex: 1, minWidth: 240 }}
							type="password"
							autoComplete="off"
							placeholder={deps.t("telegramTokenPlaceholder")}
							value={tokenDraft}
							disabled={!status.token.writable || busy}
							onChange={(event: { target: { value: string } }) => {
								setTokenDraft(event.target.value);
							}}
						/>
						<button
							style={styles.button}
							type="button"
							disabled={busy || tokenDraft.trim() === "" || !status.token.writable}
							onClick={() => {
								setBusy(true);
								void deps
									.writeToken(tokenDraft.trim())
									.then(async () => {
										setTokenDraft("");
										setNotice(deps.t("telegramSaved"));
										await load();
									})
									.catch((failure: unknown) => {
										setError((failure as Error).message);
									})
									.finally(() => {
										setBusy(false);
									});
							}}
						>
							{deps.t("tokenSave")}
						</button>
						<button
							style={styles.button}
							type="button"
							disabled={busy || !status.token.configured || !status.token.writable}
							onClick={() => {
								setBusy(true);
								void deps
									.writeToken(undefined)
									.then(async () => {
										setNotice(deps.t("telegramCleared"));
										await load();
									})
									.catch((failure: unknown) => {
										setError((failure as Error).message);
									})
									.finally(() => {
										setBusy(false);
									});
							}}
						>
							{deps.t("tokenClear")}
						</button>
					</div>
				</section>

				<section style={styles.block}>
					<div style={styles.label}>{deps.t("telegramConfigTitle")}</div>
					<div style={styles.field}>
						<span style={styles.label}>{deps.t("telegramOwnerLabel")}</span>
						<input
							style={styles.input}
							name="ownerUserId"
							value={effective.ownerUserId}
							placeholder="123456789"
							onChange={(event: { target: { value: string } }) => {
								setDraft((current) => ({ ...current, ownerUserId: event.target.value }));
							}}
						/>
						<p style={styles.hint}>{deps.t("telegramOwnerHint")}</p>
					</div>
					<div style={styles.field}>
						<span style={styles.label}>{deps.t("telegramCwdLabel")}</span>
						<input
							style={styles.input}
							name="defaultCwd"
							value={effective.defaultCwd}
							onChange={(event: { target: { value: string } }) => {
								setDraft((current) => ({ ...current, defaultCwd: event.target.value }));
							}}
						/>
						<p style={styles.hint}>{deps.t("telegramCwdHint")}</p>
					</div>
					<div style={styles.field}>
						<span style={styles.label}>{deps.t("telegramPresetLabel")}</span>
						<select
							style={styles.input}
							name="permissionPreset"
							value={effective.permissionPreset}
							onChange={(event: { target: { value: string } }) => {
								setDraft((current) => ({ ...current, permissionPreset: event.target.value }));
							}}
						>
							<option value="read-only">{deps.t("telegramPresetReadOnly")}</option>
							<option value="workspace-write">{deps.t("telegramPresetWorkspace")}</option>
							<option value="danger-full-access">{deps.t("telegramPresetFull")}</option>
						</select>
						<p style={styles.hint}>{deps.t("telegramPresetHint")}</p>
					</div>
					<div style={styles.field}>
						<label style={styles.row}>
							<input
								type="checkbox"
								name="renderMarkdown"
								checked={effective.renderMarkdown}
								onChange={(event: { target: { checked: boolean } }) => {
									setDraft((current) => ({ ...current, renderMarkdown: event.target.checked }));
								}}
							/>
							<span style={styles.label}>{deps.t("telegramMarkdownLabel")}</span>
						</label>
						<p style={styles.hint}>{deps.t("telegramMarkdownHint")}</p>
					</div>
					<div style={styles.field}>
						<span style={styles.label}>{deps.t("telegramMediaLabel")}</span>
						<select
							style={styles.input}
							name="mediaDelivery"
							value={effective.mediaDelivery}
							onChange={(event: { target: { value: string } }) => {
								setDraft((current) => ({ ...current, mediaDelivery: event.target.value }));
							}}
						>
							<option value="off">{deps.t("telegramMediaOff")}</option>
							<option value="presented">{deps.t("telegramMediaPresented")}</option>
							<option value="all">{deps.t("telegramMediaAll")}</option>
						</select>
						<p style={styles.hint}>{deps.t("telegramMediaHint")}</p>
					</div>
					<div style={styles.field}>
						<label style={styles.row}>
							<input
								type="checkbox"
								name="enabled"
								checked={effective.enabled}
								onChange={(event: { target: { checked: boolean } }) => {
									setDraft((current) => ({ ...current, enabled: event.target.checked }));
								}}
							/>
							<span style={styles.label}>{deps.t("telegramEnabledLabel")}</span>
						</label>
						<p style={styles.hint}>{deps.t("telegramEnabledHint")}</p>
					</div>
					<div style={styles.row}>
						<button
							style={styles.button}
							type="button"
							disabled={busy || Object.keys(draft).length === 0}
							onClick={() => {
								void save(draft);
							}}
						>
							{deps.t("telegramSave")}
						</button>
						{Object.keys(draft).length > 0 && <span style={styles.hint}>{deps.t("telegramUnsaved")}</span>}
					</div>
				</section>

				<section style={styles.block}>
					<div style={styles.label}>{deps.t("telegramStatusTitle")}</div>
					<p style={styles.status}>
						{stateLabel}
						{status.botUsername === undefined ? "" : ` · @${status.botUsername}`}
						{` · ${(deps.t("telegramStatusSessions") as unknown as (n: number) => string)(status.sessions)}`}
					</p>
					{status.detail !== undefined && status.state !== "running" && <p style={styles.error}>{status.detail}</p>}
					<div style={styles.row}>
						<button
							style={styles.button}
							type="button"
							onClick={() => {
								void load();
							}}
						>
							{deps.t("telegramRetry")}
						</button>
					</div>
				</section>
			</div>
		);
	};
}
