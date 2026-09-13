/**
 * A single-choice selector built the way the harness builds its own: a `Menu`
 * from the shared primitives, anchored to a pill button with a chevron
 * (`dsh-client-locale`'s LanguageRow). The kit ships no `<select>`.
 * @module dsh-buddy/client/select
 */
import { useState } from "react";
import type { ReactNode } from "react";
import { IconChevronDownOutline14, Menu } from "@deepseek-ai/dsh-client-ui-primitives";
import { FORM_CLASS } from "./form-css.ts";

export interface SelectProps {
	/** Identifies the control; carried on the anchor button. */
	name: string;
	value: string;
	options: readonly { id: string; label: string }[];
	/** Shown when `value` matches no option. */
	placeholder?: string;
	disabled?: boolean;
	onChange(value: string): void;
}

/**
 * @param props - the choice, its options and the change handler.
 * @returns the selector.
 */
export function Select(props: SelectProps): ReactNode {
	const [open, setOpen] = useState(false);
	const current = props.options.find((option) => option.id === props.value)?.label ?? props.placeholder ?? "";
	return (
		<Menu
			open={open}
			onClose={() => setOpen(false)}
			items={props.options.map((option) => ({ id: option.id, label: option.label }))}
			selectedId={props.value}
			onSelect={(id: string) => {
				setOpen(false);
				props.onChange(id);
			}}
			align="start"
			portal
			anchor={
				<button
					type="button"
					name={props.name}
					className={FORM_CLASS.selector}
					aria-haspopup="menu"
					aria-expanded={open}
					disabled={props.disabled === true}
					onClick={() => setOpen((value) => !value)}
				>
					<span className={FORM_CLASS.selectorLabel}>{current}</span>
					<IconChevronDownOutline14 className={FORM_CLASS.chevron} />
				</button>
			}
		/>
	);
}
