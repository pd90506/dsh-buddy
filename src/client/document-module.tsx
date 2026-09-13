/**
 * The Soul and Agents modules: one authored Markdown file each.
 *
 * They stay two modules because only SOUL.md reaches the prompt as
 * `{{buddy_soul}}`; merging them would put operating rules into the voice.
 * @module dsh-buddy/client/document-module
 */
import { useCallback, useEffect, useState } from "react";
import type { Call } from "./call.ts";

/** Collaborators supplied by the plugin's `apply`. */
export interface DocumentModuleDeps {
	call: Call;
	t(key: string): string;
}

const styles = {
	block: { display: "flex", flexDirection: "column", gap: 8 },
	hint: { fontSize: 12, color: "var(--dsw-alias-label-secondary)", margin: 0 },
	error: { fontSize: 13, color: "var(--dsw-alias-status-error, #d64545)", margin: 0 },
	area: {
		minHeight: 160,
		fontFamily: "var(--dsw-font-mono, monospace)",
		fontSize: 13,
		padding: 8,
		borderRadius: 6,
		border: "1px solid var(--dsw-alias-border, #ccc)",
		background: "var(--dsw-alias-fill-input, transparent)",
		color: "inherit",
		resize: "vertical",
	},
	row: { display: "flex", alignItems: "center", gap: 8 },
	button: { padding: "6px 14px", borderRadius: 6, cursor: "pointer" },
} as const;

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
			<section style={styles.block}>
				<p style={styles.hint}>{deps.t(field === "soul" ? "soulHint" : "agentsHint")}</p>
				<textarea
					style={styles.area}
					value={text}
					onChange={(event: { target: { value: string } }) => setText(event.target.value)}
				/>
				<div style={styles.row}>
					<button style={styles.button} type="button" disabled={busy || loaded === undefined} onClick={() => void save()}>
						{deps.t("save")}
					</button>
				</div>
				{error !== undefined && <p style={styles.error}>{error}</p>}
			</section>
		);
	};
}
