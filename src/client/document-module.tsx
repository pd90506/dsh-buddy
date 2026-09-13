/**
 * The Soul and Agents modules: one authored Markdown file each.
 *
 * They stay two modules because only SOUL.md reaches the prompt as
 * `{{buddy_soul}}`; merging them would put operating rules into the voice.
 * @module dsh-buddy/client/document-module
 */
import { useCallback, useEffect, useState } from "react";
import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import type { Call } from "./call.ts";
import { FORM_CLASS } from "./form-css.ts";

/** Collaborators supplied by the plugin's `apply`. */
export interface DocumentModuleDeps {
	call: Call;
	t(key: string): string;
}

/**
 * @param deps - RPC and locale.
 * @param field - which document this module edits.
 * @returns the module component.
 */
export function createDocumentModule(deps: DocumentModuleDeps, field: "soul" | "agents"): () => unknown {
	return function DocumentModule(): unknown {
		const [loaded, setLoaded] = useState<{ home: string } | undefined>(undefined);
		const [text, setText] = useState("");
		const [busy, setBusy] = useState(false);
		const [error, setError] = useState<string | undefined>(undefined);

		const load = useCallback(async (): Promise<void> => {
			try {
				const view = (await deps.call("buddyPersona/persona", {})) as { soul: string; agents: string; home: string };
				setText(view[field]);
				setLoaded({ home: view.home });
				setError(undefined);
			} catch (cause) {
				setError((cause as Error).message);
			}
		}, []);

		useEffect(() => {
			void load();
		}, [load]);

		const save = async (): Promise<void> => {
			// Never before a successful load: the draft starts empty, and an empty
			// string is indistinguishable on the wire from "the user cleared it".
			if (loaded === undefined) return;
			setBusy(true);
			try {
				await deps.call("buddyPersona/updatePersona", { patch: { [field]: text } });
				setError(undefined);
			} catch (cause) {
				setError((cause as Error).message);
			} finally {
				setBusy(false);
			}
		};

		return (
			<section className={FORM_CLASS.field}>
				<p className={FORM_CLASS.hint}>{deps.t(field === "soul" ? "soulHint" : "agentsHint")}</p>
				<textarea
					className={FORM_CLASS.textarea}
					name={field}
					aria-label={deps.t(field === "soul" ? "soulTitle" : "agentsTitle")}
					value={text}
					onChange={(event: { target: { value: string } }) => setText(event.target.value)}
				/>
				<div className={FORM_CLASS.actions}>
					<Button variant="primary" size="sm" disabled={busy || loaded === undefined} onClick={() => void save()}>
						{deps.t("save")}
					</Button>
				</div>
				{error !== undefined && <p className={FORM_CLASS.error}>{error}</p>}
			</section>
		);
	};
}
