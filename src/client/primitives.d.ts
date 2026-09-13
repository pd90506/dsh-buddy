/**
 * The slice of the harness's shared UI kit this plugin uses.
 *
 * `@deepseek-ai/dsh-client-ui-primitives` is a platform seed the browser
 * module loader resolves at runtime (every shipped client plugin requires it,
 * and so does third-party `dsh-better-sidebar`); it is not an npm dependency
 * of this repo, so its types are declared here by hand and the build leaves it
 * external. Using it is what makes these controls the harness's own — same
 * shape, colours, hover and disabled states, in both themes.
 */
declare module "@deepseek-ai/dsh-client-ui-primitives" {
	import type { ReactNode } from "react";

	/** `ghost` (default), `primary`, `outline` or `toolbar`; `md` (36px, default) or `sm` (28px). */
	export function Button(props: {
		variant?: "ghost" | "primary" | "outline" | "toolbar";
		size?: "md" | "sm";
		icon?: ReactNode;
		className?: string;
		disabled?: boolean;
		onClick?: () => void;
		children?: ReactNode;
		"aria-label"?: string;
	}): ReactNode;

	/** A `role="switch"` button; `label` becomes its accessible name. */
	export function Switch(props: {
		checked: boolean;
		onChange(checked: boolean): void;
		label: string;
		disabled?: boolean;
		title?: string;
		className?: string;
	}): ReactNode;

	/** A bordered text field; `className` lands on the wrapper, every other prop on the `<input>`. */
	export function Input(props: {
		icon?: ReactNode;
		className?: string;
		name?: string;
		type?: string;
		value?: string;
		placeholder?: string;
		autoComplete?: string;
		disabled?: boolean;
		"aria-label"?: string;
		onChange?: (event: { target: { value: string } }) => void;
	}): ReactNode;

	/** A popup menu that renders its own `anchor`. */
	export function Menu(props: {
		open: boolean;
		anchor: ReactNode;
		items: readonly { id: string; label: string }[];
		selectedId?: string;
		onSelect(id: string): void;
		onClose(): void;
		align?: "start" | "end";
		side?: "top" | "bottom";
		portal?: boolean;
	}): ReactNode;

	export function IconChevronRightOutline14(props: { size?: number; className?: string }): ReactNode;
	export function IconChevronDownOutline14(props: { size?: number; className?: string }): ReactNode;
}
