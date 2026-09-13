/**
 * Which model a new buddy conversation starts on.
 *
 * Pure and dependency-free on purpose: the Telegram row and the browser's
 * New Buddy conversation button both apply the same precedence, and the browser
 * bundle must not pull in a host module to do it.
 * @module dsh-buddy/model-selection
 */
import type { BuddyModelDefault } from "./config.ts";

/** A concrete model route, as the harness's session APIs accept it. */
export interface ModelSelection {
	readonly provider: string;
	readonly model: string;
	readonly reasoningEffort?: string;
}

/**
 * Buddy's stored default as a selection.
 * @param value - the `buddy.model` settings value.
 * @returns the selection, or `undefined` when provider or model is empty.
 */
export function selectionFromDefault(value: BuddyModelDefault): ModelSelection | undefined {
	if (value.provider === "" || value.model === "") return undefined;
	return value.reasoningEffort === ""
		? { provider: value.provider, model: value.model }
		: { provider: value.provider, model: value.model, reasoningEffort: value.reasoningEffort };
}

/**
 * Apply the precedence: chat-local, then Buddy default, then global default.
 * @param chatLocal - a per-chat `/model` choice.
 * @param buddyDefault - `selectionFromDefault(buddy.model)`.
 * @param globalDefault - the harness's global default selection.
 * @returns the first defined selection.
 */
export function resolveModelSelection(
	chatLocal: ModelSelection | undefined,
	buddyDefault: ModelSelection | undefined,
	globalDefault: ModelSelection | undefined,
): ModelSelection | undefined {
	return chatLocal ?? buddyDefault ?? globalDefault;
}
