/**
 * The Model module: Buddy's default model for new conversations.
 * Empty means "follow the global default"; a chat's own `/model` still wins.
 * @module dsh-buddy/client/model-module
 */
import { useCallback, useEffect, useState } from "react";
import type { Call } from "./call.ts";

/** `dsh-api-session-controller`'s `ModelCatalog`, trimmed to what is read. */
export interface ModelCatalog {
	readonly groups: readonly {
		readonly id: string;
		readonly name: string;
		readonly models: readonly {
			readonly id: string;
			readonly name: string;
			readonly reasoning?: { readonly efforts: readonly { readonly id: string; readonly name: string }[] };
		}[];
	}[];
}

interface Draft {
	provider: string;
	model: string;
	reasoningEffort: string;
}

/** Collaborators supplied by the plugin's `apply`. */
export interface ModelModuleDeps {
	call: Call;
	t(key: string): string;
	catalog(): Promise<ModelCatalog>;
}

const styles = {
	block: { display: "flex", flexDirection: "column", gap: 10 },
	field: { display: "flex", flexDirection: "column", gap: 4 },
	label: { fontSize: 13, fontWeight: 500 },
	hint: { fontSize: 12, color: "var(--dsw-alias-label-secondary)", margin: 0 },
	error: { fontSize: 13, color: "var(--dsw-alias-status-error, #d64545)", margin: 0 },
	input: { fontSize: 13, padding: "6px 8px", borderRadius: 6, border: "0.5px solid var(--dsw-alias-border-l2)" },
	row: { display: "flex", alignItems: "center", gap: 8 },
	button: { padding: "6px 14px", borderRadius: 6, cursor: "pointer" },
} as const;

const EMPTY: Draft = { provider: "", model: "", reasoningEffort: "" };

/**
 * @param deps - RPC, locale and the model catalog.
 * @returns the module component.
 */
export function createModelModule(deps: ModelModuleDeps): () => unknown {
	return function ModelModule(): unknown {
		const [catalog, setCatalog] = useState<ModelCatalog | undefined>(undefined);
		const [draft, setDraft] = useState<Draft | undefined>(undefined);
		const [follow, setFollow] = useState(true);
		const [busy, setBusy] = useState(false);
		const [error, setError] = useState<string | undefined>(undefined);

		const load = useCallback(async (): Promise<void> => {
			try {
				const [prefs, nextCatalog] = await Promise.all([deps.call("buddyPersona/preferences", {}), deps.catalog()]);
				const model = (prefs as { model: Draft }).model;
				setCatalog(nextCatalog);
				setDraft({ ...model });
				setFollow(model.provider === "" || model.model === "");
				setError(undefined);
			} catch (cause) {
				setError((cause as Error).message);
			}
		}, []);

		useEffect(() => {
			void load();
		}, [load]);

		if (draft === undefined || catalog === undefined) {
			return error === undefined ? null : <p style={styles.error}>{error}</p>;
		}

		const group = catalog.groups.find((candidate) => candidate.id === draft.provider);
		const model = group?.models.find((candidate) => candidate.id === draft.model);
		const efforts = model?.reasoning?.efforts ?? [];

		const save = async (): Promise<void> => {
			setBusy(true);
			try {
				await deps.call("buddyPersona/updatePreferences", { patch: { model: follow ? EMPTY : draft } });
				setError(undefined);
			} catch (cause) {
				setError((cause as Error).message);
			} finally {
				setBusy(false);
			}
		};

		return (
			<section style={styles.block}>
				<p style={styles.hint}>{deps.t("modelHint")}</p>
				<label style={styles.row}>
					<input
						type="checkbox"
						name="followDefault"
						checked={follow}
						onChange={(event: { target: { checked: boolean } }) => setFollow(event.target.checked)}
					/>
					<span style={styles.label}>{deps.t("modelFollow")}</span>
				</label>
				{!follow && (
					<>
						<div style={styles.field}>
							<span style={styles.label}>{deps.t("modelProvider")}</span>
							<select
								style={styles.input}
								name="provider"
								value={draft.provider}
								onChange={(event: { target: { value: string } }) =>
									setDraft({ provider: event.target.value, model: "", reasoningEffort: "" })
								}
							>
								<option value="">{deps.t("modelChoose")}</option>
								{catalog.groups.map((candidate) => (
									<option key={candidate.id} value={candidate.id}>
										{candidate.name}
									</option>
								))}
							</select>
						</div>
						<div style={styles.field}>
							<span style={styles.label}>{deps.t("modelModel")}</span>
							<select
								style={styles.input}
								name="model"
								value={draft.model}
								onChange={(event: { target: { value: string } }) =>
									setDraft({ provider: draft.provider, model: event.target.value, reasoningEffort: "" })
								}
							>
								<option value="">{deps.t("modelChoose")}</option>
								{(group?.models ?? []).map((candidate) => (
									<option key={candidate.id} value={candidate.id}>
										{candidate.name}
									</option>
								))}
							</select>
						</div>
						{efforts.length > 0 && (
							<div style={styles.field}>
								<span style={styles.label}>{deps.t("modelEffort")}</span>
								<select
									style={styles.input}
									name="effort"
									value={draft.reasoningEffort}
									onChange={(event: { target: { value: string } }) => setDraft({ ...draft, reasoningEffort: event.target.value })}
								>
									<option value="">{deps.t("modelEffortDefault")}</option>
									{efforts.map((candidate) => (
										<option key={candidate.id} value={candidate.id}>
											{candidate.name}
										</option>
									))}
								</select>
							</div>
						)}
					</>
				)}
				<div style={styles.row}>
					<button
						style={styles.button}
						type="button"
						disabled={busy || (!follow && (draft.provider === "" || draft.model === ""))}
						onClick={() => void save()}
					>
						{deps.t("save")}
					</button>
				</div>
				{error !== undefined && <p style={styles.error}>{error}</p>}
			</section>
		);
	};
}
