/**
 * The Buddy main panel is a table of modules. Later phases add rows here; the
 * panel itself never changes shape to accommodate them.
 * @module dsh-buddy/client/modules
 */
import type { PanelSectionId } from "../config.ts";

/** One main-panel module. */
export interface PanelModule<C> {
	readonly id: PanelSectionId;
	/** Ascending display order. */
	readonly order: number;
	/** Locale key of the module title. */
	readonly titleKey: string;
	readonly Component: C;
}

/**
 * @param modules - the module table.
 * @param sections - `buddy.panel.sections`; a module is hidden only by an explicit `false`.
 * @returns the visible modules, ordered.
 */
export function visibleModules<C>(
	modules: readonly PanelModule<C>[],
	sections: Partial<Record<PanelSectionId, boolean>> | undefined,
): PanelModule<C>[] {
	return modules.filter((module) => sections?.[module.id] !== false).sort((a, b) => a.order - b.order);
}
