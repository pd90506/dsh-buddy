/**
 * The Telegram module: bot token, configuration and live status.
 *
 * Ported from `dsh-telegram`'s own Settings tab (`TelegramSection`) into a
 * Buddy main-panel module: the endpoints move to this plugin's own
 * `buddyTelegram/*` namespace, the chrome (title, description) is dropped
 * because the panel's sub-nav already supplies the module's title, and every
 * locale key moves into Buddy's own `settings.buddy` namespace under a `telegram`
 * prefix so it cannot collide with `dsh-telegram`'s own dictionary.
 * @module dsh-buddy/client/telegram-module
 */
import { useCallback, useEffect, useState } from "react";
import { Button, Input, Switch } from "@deepseek-ai/dsh-client-ui-primitives";
import type { Call } from "./call.ts";
import { FORM_CLASS } from "./form-css.ts";
import { Select } from "./select.tsx";

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
			return error === undefined ? <p className={FORM_CLASS.status}>{deps.t("telegramLoading")}</p> : <p className={FORM_CLASS.error}>{error}</p>;
		}

		const stateLabel =
			status.state === "running"
				? deps.t("telegramStatusRunning")
				: status.state === "starting"
					? deps.t("telegramStatusStarting")
					: status.state === "error"
						? deps.t("telegramStatusError")
						: deps.t("telegramStatusOff");

		const setField = <K extends keyof Config>(key: K, value: Config[K]): void => {
			setDraft((current) => ({ ...current, [key]: value }));
		};

		const runTokenWrite = (value: string | undefined, onDone: () => void): void => {
			setBusy(true);
			void deps
				.writeToken(value)
				.then(async () => {
					onDone();
					await load();
				})
				.catch((failure: unknown) => {
					setError((failure as Error).message);
				})
				.finally(() => {
					setBusy(false);
				});
		};

		return (
			<div>
				{(notice !== undefined || error !== undefined) && (
					<div className={FORM_CLASS.group}>
						{notice !== undefined && <p className={FORM_CLASS.status}>{notice}</p>}
						{error !== undefined && <p className={FORM_CLASS.error}>{error}</p>}
					</div>
				)}

				<section className={FORM_CLASS.group}>
					<div className={FORM_CLASS.field}>
						<div className={FORM_CLASS.title}>{deps.t("telegramTokenTitle")}</div>
						<p className={FORM_CLASS.hint}>{deps.t("telegramTokenHint")}</p>
					</div>
					<p className={FORM_CLASS.status}>
						{status.token.configured ? deps.t("telegramTokenConfigured") : deps.t("telegramTokenMissing")}
						{sourceLabel(status.token.source)}
						{` · ${status.token.writable ? deps.t("telegramTokenWritable") : deps.t("telegramTokenReadOnly")}`}
					</p>
					<Input
						className={FORM_CLASS.input}
						name="token"
						type="password"
						autoComplete="off"
						aria-label={deps.t("telegramTokenTitle")}
						placeholder={deps.t("telegramTokenPlaceholder")}
						value={tokenDraft}
						disabled={!status.token.writable || busy}
						onChange={(event: { target: { value: string } }) => {
							setTokenDraft(event.target.value);
						}}
					/>
					<div className={FORM_CLASS.actions}>
						<Button
							variant="primary"
							size="sm"
							disabled={busy || tokenDraft.trim() === "" || !status.token.writable}
							onClick={() => {
								runTokenWrite(tokenDraft.trim(), () => {
									setTokenDraft("");
									setNotice(deps.t("telegramSaved"));
								});
							}}
						>
							{deps.t("tokenSave")}
						</Button>
						<Button
							variant="outline"
							size="sm"
							disabled={busy || !status.token.configured || !status.token.writable}
							onClick={() => {
								runTokenWrite(undefined, () => {
									setNotice(deps.t("telegramCleared"));
								});
							}}
						>
							{deps.t("tokenClear")}
						</Button>
					</div>
				</section>

				<section className={FORM_CLASS.group}>
					<div className={FORM_CLASS.title}>{deps.t("telegramConfigTitle")}</div>
					<div className={FORM_CLASS.field}>
						<span className={FORM_CLASS.label}>{deps.t("telegramOwnerLabel")}</span>
						<Input
							className={FORM_CLASS.input}
							name="ownerUserId"
							aria-label={deps.t("telegramOwnerLabel")}
							value={effective.ownerUserId}
							placeholder="123456789"
							onChange={(event: { target: { value: string } }) => setField("ownerUserId", event.target.value)}
						/>
						<p className={FORM_CLASS.hint}>{deps.t("telegramOwnerHint")}</p>
					</div>
					<div className={FORM_CLASS.field}>
						<span className={FORM_CLASS.label}>{deps.t("telegramCwdLabel")}</span>
						<Input
							className={FORM_CLASS.input}
							name="defaultCwd"
							aria-label={deps.t("telegramCwdLabel")}
							value={effective.defaultCwd}
							onChange={(event: { target: { value: string } }) => setField("defaultCwd", event.target.value)}
						/>
						<p className={FORM_CLASS.hint}>{deps.t("telegramCwdHint")}</p>
					</div>
					<div className={FORM_CLASS.field}>
						<span className={FORM_CLASS.label}>{deps.t("telegramPresetLabel")}</span>
						<div>
							<Select
								name="permissionPreset"
								value={effective.permissionPreset}
								options={[
									{ id: "read-only", label: deps.t("telegramPresetReadOnly") },
									{ id: "workspace-write", label: deps.t("telegramPresetWorkspace") },
									{ id: "danger-full-access", label: deps.t("telegramPresetFull") },
								]}
								onChange={(value) => setField("permissionPreset", value)}
							/>
						</div>
						<p className={FORM_CLASS.hint}>{deps.t("telegramPresetHint")}</p>
					</div>
					<div className={FORM_CLASS.field}>
						<div className={FORM_CLASS.toggleRow}>
							<span className={FORM_CLASS.label}>{deps.t("telegramMarkdownLabel")}</span>
							<Switch
								checked={effective.renderMarkdown}
								label={deps.t("telegramMarkdownLabel")}
								onChange={(checked: boolean) => setField("renderMarkdown", checked)}
							/>
						</div>
						<p className={FORM_CLASS.hint}>{deps.t("telegramMarkdownHint")}</p>
					</div>
					<div className={FORM_CLASS.field}>
						<span className={FORM_CLASS.label}>{deps.t("telegramMediaLabel")}</span>
						<div>
							<Select
								name="mediaDelivery"
								value={effective.mediaDelivery}
								options={[
									{ id: "off", label: deps.t("telegramMediaOff") },
									{ id: "presented", label: deps.t("telegramMediaPresented") },
									{ id: "all", label: deps.t("telegramMediaAll") },
								]}
								onChange={(value) => setField("mediaDelivery", value)}
							/>
						</div>
						<p className={FORM_CLASS.hint}>{deps.t("telegramMediaHint")}</p>
					</div>
					<div className={FORM_CLASS.field}>
						<div className={FORM_CLASS.toggleRow}>
							<span className={FORM_CLASS.label}>{deps.t("telegramEnabledLabel")}</span>
							<Switch
								checked={effective.enabled}
								label={deps.t("telegramEnabledLabel")}
								onChange={(checked: boolean) => setField("enabled", checked)}
							/>
						</div>
						<p className={FORM_CLASS.hint}>{deps.t("telegramEnabledHint")}</p>
					</div>
					<div className={FORM_CLASS.actions}>
						<Button
							variant="primary"
							size="sm"
							disabled={busy || Object.keys(draft).length === 0}
							onClick={() => {
								void save(draft);
							}}
						>
							{deps.t("telegramSave")}
						</Button>
						{Object.keys(draft).length > 0 && <span className={FORM_CLASS.hint}>{deps.t("telegramUnsaved")}</span>}
					</div>
				</section>

				<section className={FORM_CLASS.group}>
					<div className={FORM_CLASS.title}>{deps.t("telegramStatusTitle")}</div>
					<p className={FORM_CLASS.status}>
						{stateLabel}
						{status.botUsername === undefined ? "" : ` · @${status.botUsername}`}
						{` · ${(deps.t("telegramStatusSessions") as unknown as (n: number) => string)(status.sessions)}`}
					</p>
					{status.detail !== undefined && status.state !== "running" && <p className={FORM_CLASS.error}>{status.detail}</p>}
					<div className={FORM_CLASS.actions}>
						<Button
							variant="outline"
							size="sm"
							onClick={() => {
								void load();
							}}
						>
							{deps.t("telegramRetry")}
						</Button>
					</div>
				</section>
			</div>
		);
	};
}
