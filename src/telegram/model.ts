/**
 * `/model` — listing what is routable, and switching this chat only.
 *
 * The catalog comes from `sessionController.modelCatalog()`, the same call the
 * GUI's per-session picker makes, so the two surfaces agree on what exists.
 * Reasoning-effort variants are *not* separate rows: they hang off each model, so
 * a switch adopts the model's advertised default effort unless the user picked
 * one.
 *
 * The switch itself deliberately avoids `sessionController.selectModel`: that
 * implementation validates the selection and then also calls
 * `agentDefaultModel.saveSelection`, which rewrites the **global** default in
 * `~/.dsh/settings.yaml`. A `/model` typed on a phone must not silently move the
 * model every new session on the desktop starts from, so the choice is kept
 * chat-local through `installModelSelection` and the `telegram` storage domain.
 *
 * Buttons carry indices rather than identifiers: `callback_data` is capped at 64
 * bytes, and provider-qualified model ids routinely exceed that.
 * @module dsh-buddy/telegram/model
 */
import type { TelegramInlineButton } from "./telegram/api.ts";
import type { ModelSelection } from "./session.ts";

/**
 * The `callback_data` grammar for the `/model` menu.
 *
 * Emitting and parsing it from one place is what keeps a press from silently
 * ceasing to match after a rename on either side; `callback_data` is capped at 64
 * bytes, so it carries indices rather than provider-qualified model ids.
 */
export const MODEL_CALLBACK = {
	/** Prefix shared by every `/model` callback. */
	prefix: "md",
	/** The provider step: `md:p:<providerIndex>`. */
	provider: (providerIndex: number): string => `md:p:${String(providerIndex)}`,
	/** The model step: `md:m:<providerIndex>:<modelIndex>`. */
	model: (providerIndex: number, modelIndex: number): string =>
		`md:m:${String(providerIndex)}:${String(modelIndex)}`,
	/** Back to the provider step. */
	back: "md:back",
} as const;

/** A decoded `/model` press. */
export type ModelCallback =
	| { readonly kind: "provider"; readonly providerIndex: number }
	| { readonly kind: "model"; readonly providerIndex: number; readonly modelIndex: number }
	| { readonly kind: "back" };

/**
 * Decode a `/model` press.
 * @param data - the raw `callback_data`.
 * @returns the decoded action, or undefined when it belongs to someone else.
 */
export function parseModelCallback(data: string): ModelCallback | undefined {
	const parts = data.split(":");
	if (parts[0] !== MODEL_CALLBACK.prefix) return undefined;
	if (parts[1] === "back") return { kind: "back" };
	const providerIndex = Number(parts[2]);
	if (!Number.isInteger(providerIndex) || providerIndex < 0) return undefined;
	if (parts[1] === "p") return { kind: "provider", providerIndex };
	const modelIndex = Number(parts[3]);
	if (!Number.isInteger(modelIndex) || modelIndex < 0) return undefined;
	if (parts[1] === "m") return { kind: "model", providerIndex, modelIndex };
	return undefined;
}

/** One selectable reasoning effort. */
export interface ModelEffort {
	readonly id: string;
	readonly name: string;
}

/** One routable model. */
export interface CatalogModel {
	readonly id: string;
	readonly name: string;
	readonly description?: string | undefined;
	readonly reasoning?: { readonly efforts: readonly ModelEffort[]; readonly defaultEffort?: string } | undefined;
}

/** One provider and its models. */
export interface CatalogGroup {
	readonly id: string;
	readonly name: string;
	readonly models: readonly CatalogModel[];
}

/** Failures the host reported while building the catalog. */
export interface CatalogFailure {
	readonly id: string;
	readonly name: string;
	readonly message: string;
}

/** The model catalog, as `sessionController.modelCatalog()` returns it. */
export interface ModelCatalog {
	readonly default: ModelSelection;
	readonly routableProviders: readonly string[];
	readonly groups: readonly CatalogGroup[];
	readonly failures: readonly CatalogFailure[];
}

/**
 * Load the routable model catalog.
 * @param get - `ctx.get`.
 * @returns the catalog, or undefined when the profile has no session controller.
 */
export async function loadCatalog(get: (name: string) => unknown): Promise<ModelCatalog | undefined> {
	const controller = get("sessionController") as { modelCatalog(): Promise<ModelCatalog> } | undefined;
	if (controller === undefined) return undefined;
	return controller.modelCatalog();
}

/**
 * Validate a selection before installing it.
 *
 * `resolveCallConfig` catches a missing adapter, an unconfigured model, and an
 * unsupported reasoning effort. It does **not** catch a missing API key — that
 * surfaces when the adapter issues the request — so the message here never claims
 * a model is "ready", only that the route resolves.
 * @param get - `ctx.get`.
 * @param selection - the candidate selection.
 * @returns ok, or the reason the route cannot serve it.
 */
export async function validateSelection(
	get: (name: string) => unknown,
	selection: ModelSelection,
): Promise<{ ok: true } | { ok: false; message: string }> {
	const llm = get("llm") as { resolveCallConfig(config: Record<string, unknown>): Promise<unknown> } | undefined;
	if (llm === undefined) return { ok: true };
	try {
		await llm.resolveCallConfig({ ...selection });
		return { ok: true };
	} catch (error) {
		return { ok: false, message: (error as Error).message };
	}
}

/** The default effort a model advertises, when it advertises one. */
export function defaultEffortOf(model: CatalogModel): string | undefined {
	return model.reasoning?.defaultEffort;
}

/**
 * Per-chat menu state for the two-step `/model` flow.
 *
 * Telegram never tells us which message a button belonged to beyond what we put
 * in `callback_data`, so the lists a press can refer to are held here, keyed by
 * chat, and replaced on each `/model`.
 */
export class ModelMenu {
	readonly #catalogs = new Map<string, ModelCatalog>();

	/**
	 * Remember the catalog a chat is choosing from.
	 * @param chatId - the Telegram chat id, as a string.
	 * @param catalog - the freshly loaded catalog.
	 */
	open(chatId: string, catalog: ModelCatalog): void {
		this.#catalogs.set(chatId, catalog);
	}

	/** Forget a chat's menu (after a choice, or on `/new`). */
	close(chatId: string): void {
		this.#catalogs.delete(chatId);
	}


	/** Provider at an index in the chat's menu. */
	providerAt(chatId: string, index: number): CatalogGroup | undefined {
		return this.#catalogs.get(chatId)?.groups[index];
	}

	/** Model at an index inside one provider of the chat's menu. */
	modelAt(chatId: string, providerIndex: number, index: number): CatalogModel | undefined {
		return this.#catalogs.get(chatId)?.groups[providerIndex]?.models[index];
	}

	/**
	 * The provider step: one button per provider, current one marked.
	 * @param chatId - the Telegram chat id, as a string.
	 * @param currentProvider - the provider the chat is on now.
	 * @returns inline keyboard rows.
	 */
	providerKeyboard(chatId: string, currentProvider: string | undefined): TelegramInlineButton[][] {
		const catalog = this.#catalogs.get(chatId);
		if (catalog === undefined) return [];
		return catalog.groups.map((group, index) => [
			{
				text: `${group.id === currentProvider ? "• " : ""}${group.name} (${group.models.length})`,
				callback_data: MODEL_CALLBACK.provider(index),
			},
		]);
	}

	/**
	 * The model step: one button per model of one provider.
	 *
	 * Both indices travel in `callback_data` (`md:m:<provider>:<model>`) so a
	 * press is self-describing and no per-chat "current step" has to be kept.
	 * @param chatId - the Telegram chat id, as a string.
	 * @param providerIndex - index of the chosen provider in the menu.
	 * @param currentModel - the model the chat is on now, marked with a dot.
	 * @returns inline keyboard rows.
	 */
	modelKeyboard(chatId: string, providerIndex: number, currentModel: string | undefined): TelegramInlineButton[][] {
		const group = this.#catalogs.get(chatId)?.groups[providerIndex];
		if (group === undefined) return [];
		const rows: TelegramInlineButton[][] = group.models.map((model, index) => [
			{ text: `${model.id === currentModel ? "• " : ""}${model.name}`, callback_data: MODEL_CALLBACK.model(providerIndex, index) },
		]);
		rows.push([{ text: "← Change provider", callback_data: MODEL_CALLBACK.back }]);
		return rows;
	}
}
