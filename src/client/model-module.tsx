/**
 * The Model module: Buddy's default model for new conversations.
 * Empty means "follow the global default"; a chat's own `/model` still wins.
 * @module dsh-buddy/client/model-module
 */
import { useCallback, useEffect, useState } from "react";
import { Button, Switch } from "@deepseek-ai/dsh-client-ui-primitives";
import type { Call } from "./call.ts";
import { FORM_CLASS } from "./form-css.ts";
import { Select } from "./select.tsx";

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
			return error === undefined ? null : <p className={FORM_CLASS.error}>{error}</p>;
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
			<section className={FORM_CLASS.field}>
				<p className={FORM_CLASS.hint}>{deps.t("modelHint")}</p>
				<div className={FORM_CLASS.toggleRow}>
					<span>{deps.t("modelFollow")}</span>
					<Switch checked={follow} label={deps.t("modelFollow")} onChange={(checked: boolean) => setFollow(checked)} />
				</div>
				{!follow && (
					<>
						<div className={FORM_CLASS.field}>
							<span className={FORM_CLASS.label}>{deps.t("modelProvider")}</span>
							<Select
								name="provider"
								value={draft.provider}
								placeholder={deps.t("modelChoose")}
								options={catalog.groups.map((candidate) => ({ id: candidate.id, label: candidate.name }))}
								onChange={(value) => setDraft({ provider: value, model: "", reasoningEffort: "" })}
							/>
						</div>
						<div className={FORM_CLASS.field}>
							<span className={FORM_CLASS.label}>{deps.t("modelModel")}</span>
							<Select
								name="model"
								value={draft.model}
								placeholder={deps.t("modelChoose")}
								disabled={group === undefined}
								options={(group?.models ?? []).map((candidate) => ({ id: candidate.id, label: candidate.name }))}
								onChange={(value) => setDraft({ provider: draft.provider, model: value, reasoningEffort: "" })}
							/>
						</div>
						{efforts.length > 0 && (
							<div className={FORM_CLASS.field}>
								<span className={FORM_CLASS.label}>{deps.t("modelEffort")}</span>
								<Select
									name="effort"
									value={draft.reasoningEffort}
									options={[
										{ id: "", label: deps.t("modelEffortDefault") },
										...efforts.map((candidate) => ({ id: candidate.id, label: candidate.name })),
									]}
									onChange={(value) => setDraft({ ...draft, reasoningEffort: value })}
								/>
							</div>
						)}
					</>
				)}
				<div className={FORM_CLASS.actions}>
					<Button
						variant="primary"
						size="sm"
						disabled={busy || (!follow && (draft.provider === "" || draft.model === ""))}
						onClick={() => void save()}
					>
						{deps.t("save")}
					</Button>
				</div>
				{error !== undefined && <p className={FORM_CLASS.error}>{error}</p>}
			</section>
		);
	};
}
