/**
 * The Skills module: automatic review, the skill listing, and the change ledger.
 *
 * Reads the host row's `buddySkills/*` endpoints and the one `skills` slice of
 * `buddyPersona/preferences`. Every write answers with the fresh listing, so a
 * mutation redraws the list from its own response rather than issuing a second
 * `list` round trip.
 *
 * Raising a skill's tier is deliberately a panel-only action: `skill_manage`
 * refuses a visibility write from the automatic pass, so this module never
 * promotes anything on its own and never guesses a tier for the user.
 * @module dsh-buddy/client/skills-module
 */
import { useCallback, useEffect, useState } from "react";
import { Button, Switch } from "@deepseek-ai/dsh-client-ui-primitives";
import type { Call } from "./call.ts";
import { FORM_CLASS } from "./form-css.ts";
import { Select } from "./select.tsx";

/** One skill as the panel lists it, mirroring `src/skills/gateway.ts`'s view. */
interface Skill {
	readonly name: string;
	readonly description: string;
	readonly visibility: string;
	readonly useCount: number;
	readonly activityCount: number;
	readonly latestActivityAt?: string | undefined;
	readonly pinned: boolean;
	readonly curatorManaged: boolean;
}

/** One mutation-ledger row. */
interface LedgerEntry {
	readonly id: string;
	readonly ts: string;
	readonly actor: string;
	readonly action: string;
	readonly skill: string;
}

/** Whether the preset's skills row reported in, and who owns the preset id. */
interface SkillsStatus {
	readonly synced: boolean;
	readonly missed: boolean;
	readonly preset: string;
}

/** The two path-free visibility tiers, spelled exactly as the host parses them. */
const WORD_TIERS = ["buddy", "global"] as const;

/** Prefix the host requires on a project tier. */
const PROJECT_PREFIX = "project:";

/** Locale key for one path-free tier's label. */
const TIER_KEYS: Record<(typeof WORD_TIERS)[number], string> = {
	buddy: "skillsVisibilityBuddy",
	global: "skillsVisibilityGlobal",
};

/** One choice in the visibility selector. */
interface TierOption {
	readonly id: string;
	readonly label: string;
}

/**
 * The tiers the panel may write, and which of them is the skill's own.
 *
 * A project tier is not a bare word: the host's `parseTier` accepts only
 * `buddy`, `global` or `project:<absolute path>`, and refuses anything else
 * before it touches a document. Sending a bare `"project"` would therefore be a
 * control that silently does nothing, so the project choice carries the
 * conversation cwd — the project this panel is open in. A skill already in a
 * different project keeps its own path as a third choice, so selecting it is a
 * no-op rather than a demotion, and no tier is ever invented for the user.
 * @param visibility - the skill's declared tier.
 * @param cwd - the conversation's working directory, when the host reported one.
 * @param t - the locale lookup.
 * @returns the selector's options and the skill's current one.
 */
function tierChoice(
	visibility: string,
	cwd: string,
	t: (key: string) => string,
): { options: TierOption[]; value: string } {
	const parsed = visibility.startsWith(PROJECT_PREFIX) ? visibility : (WORD_TIERS as readonly string[]).includes(visibility) ? visibility : "";
	const own = parsed.startsWith(PROJECT_PREFIX) && parsed.slice(PROJECT_PREFIX.length).trim() !== "" ? parsed : undefined;
	const current = own ?? (cwd === "" ? "" : `${PROJECT_PREFIX}${cwd}`);
	const options: TierOption[] = [
		{ id: "buddy", label: t("skillsVisibilityBuddy") },
		{ id: "global", label: t("skillsVisibilityGlobal") },
	];
	if (current !== "") options.splice(1, 0, { id: current, label: t("skillsVisibilityProject") });
	return { options, value: parsed };
}

/** Collaborators supplied by the plugin's `apply`. */
export interface SkillsModuleDeps {
	call: Call;
	t(key: string): string;
}

/** A write's outcome plus the fresh listing the host sends back with it. */
interface Mutation {
	readonly success: boolean;
	readonly message: string;
	readonly skills: readonly Skill[];
}

/**
 * @param deps - RPC and locale.
 * @returns the module component.
 */
export function createSkillsModule(deps: SkillsModuleDeps): () => unknown {
	return function SkillsModule(): unknown {
		const [status, setStatus] = useState<SkillsStatus | undefined>(undefined);
		const [skills, setSkills] = useState<readonly Skill[]>([]);
		const [ledger, setLedger] = useState<readonly LedgerEntry[]>([]);
		const [enabled, setEnabled] = useState(false);
		const [cwd, setCwd] = useState("");
		const [loaded, setLoaded] = useState(false);
		const [error, setError] = useState<string | undefined>(undefined);
		const [notice, setNotice] = useState<string | undefined>(undefined);

		const load = useCallback(async (): Promise<void> => {
			try {
				const [nextStatus, nextSkills, nextLedger, prefs] = await Promise.all([
					deps.call("buddySkills/status", {}),
					deps.call("buddySkills/list", {}),
					deps.call("buddySkills/ledger", {}),
					deps.call("buddyPersona/preferences", {}),
				]);
				setStatus(nextStatus as SkillsStatus);
				setSkills(Array.isArray(nextSkills) ? (nextSkills as readonly Skill[]) : []);
				setLedger(Array.isArray(nextLedger) ? (nextLedger as readonly LedgerEntry[]) : []);
				setEnabled((prefs as { skills?: { enabled?: boolean } }).skills?.enabled === true);
				setCwd((prefs as { conversationCwd?: string }).conversationCwd ?? "");
				setLoaded(true);
				setError(undefined);
			} catch (failure) {
				setError((failure as Error).message);
			}
		}, []);

		useEffect(() => {
			void load();
		}, [load]);

		/**
		 * Apply one write and redraw from the listing it carries back.
		 * @param endpoint - the `buddySkills/*` write.
		 * @param args - its wire arguments.
		 */
		const mutate = async (endpoint: string, args: Record<string, unknown>): Promise<void> => {
			setNotice(undefined);
			try {
				const result = (await deps.call(endpoint, args)) as Mutation;
				if (Array.isArray(result.skills)) setSkills(result.skills);
				setError(undefined);
			} catch (failure) {
				setError((failure as Error).message);
			}
		};

		/** Flip the automatic-review master switch through the persona preferences wire. */
		const setReview = async (next: boolean): Promise<void> => {
			setNotice(undefined);
			try {
				const prefs = (await deps.call("buddyPersona/updatePreferences", { patch: { skills: { enabled: next } } })) as {
					skills?: { enabled?: boolean };
				};
				setEnabled(prefs.skills?.enabled === true);
				setError(undefined);
			} catch (failure) {
				setError((failure as Error).message);
			}
		};

		/** Undo one ledger entry. */
		const rollback = async (entryId: string): Promise<void> => {
			setNotice(undefined);
			try {
				const result = (await deps.call("buddySkills/rollback", { entryId })) as { success: boolean };
				setNotice(result.success ? deps.t("skillsRolledBack") : deps.t("skillsFailed"));
				setError(undefined);
				await load();
			} catch (failure) {
				setError((failure as Error).message);
			}
		};

		if (!loaded) {
			return error === undefined ? <p className={FORM_CLASS.status}>{deps.t("telegramLoading")}</p> : <p className={FORM_CLASS.error}>{error}</p>;
		}

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
						<div className={FORM_CLASS.toggleRow}>
							<span className={FORM_CLASS.label}>{deps.t("skillsReview")}</span>
							<Switch checked={enabled} label={deps.t("skillsReview")} onChange={(checked: boolean) => void setReview(checked)} />
						</div>
						<p className={FORM_CLASS.hint}>{deps.t("skillsReviewHint")}</p>
					</div>
					{/* Both notices are rendered, never collapsed into one: an unowned
					    preset id keeps `missed` true forever, and the two together are
					    what explains why no heartbeat will ever clear it. */}
					{status?.missed === true && <p className={FORM_CLASS.error}>{deps.t("skillsPresetMissed")}</p>}
					{status?.preset === "user" && <p className={FORM_CLASS.error}>{deps.t("skillsPresetUser")}</p>}
				</section>

				<section className={FORM_CLASS.group}>
					<div className={FORM_CLASS.title}>{deps.t("skillsTitle")}</div>
					{skills.length === 0 ? (
						<p className={FORM_CLASS.status}>{deps.t("skillsEmpty")}</p>
					) : (
						skills.map((skill) => {
							const choice = tierChoice(skill.visibility, cwd, deps.t);
							return (
								<div key={skill.name} className={FORM_CLASS.field}>
									<div className={FORM_CLASS.title}>{skill.name}</div>
									<p className={FORM_CLASS.hint}>{skill.description}</p>
									{/* Separate text nodes, not one interpolated line: the panel
									    reads each fact on its own, and a test can assert on one
									    without depending on the others' wording. */}
									<p className={FORM_CLASS.status}>
										{skill.curatorManaged ? deps.t("skillsManagedByAgent") : deps.t("skillsManagedByHuman")}
									</p>
									<p className={FORM_CLASS.status}>{`${deps.t("skillsUses")}: ${String(skill.useCount)}`}</p>
									{skill.latestActivityAt !== undefined && <p className={FORM_CLASS.hint}>{skill.latestActivityAt}</p>}
									<div className={FORM_CLASS.actions}>
										<Button
											variant="outline"
											size="sm"
											onClick={() => void mutate("buddySkills/pin", { skill: skill.name, pinned: !skill.pinned })}
										>
											{skill.pinned ? deps.t("skillsUnpin") : deps.t("skillsPin")}
										</Button>
										{/* Only a skill a human wrote can be handed over; an
										    already-curator-managed one offers nothing to adopt. */}
										{!skill.curatorManaged && (
											<Button variant="outline" size="sm" onClick={() => void mutate("buddySkills/adopt", { skill: skill.name })}>
												{deps.t("skillsAdopt")}
											</Button>
										)}
										{/* The one control that can lift a skill out of the buddy
										    tier. Human-only by construction: no `skill_manage`
										    operation reaches this write, and nothing here decides
										    a tier for the user. */}
										<span className={FORM_CLASS.label}>{deps.t("skillsPromote")}</span>
										<Select
											name={`visibility:${skill.name}`}
											value={choice.value}
											options={choice.options}
											onChange={(tier) => void mutate("buddySkills/visibility", { skill: skill.name, tier })}
										/>
									</div>
								</div>
							);
						})
					)}
				</section>

				<section className={FORM_CLASS.group}>
					<div className={FORM_CLASS.title}>{deps.t("skillsLedgerTitle")}</div>
					{ledger.length === 0 ? (
						<p className={FORM_CLASS.status}>{deps.t("skillsLedgerEmpty")}</p>
					) : (
						ledger.map((row) => (
							<div key={row.id} className={FORM_CLASS.field}>
								<p className={FORM_CLASS.status}>{row.ts}</p>
								<p className={FORM_CLASS.status}>{row.action}</p>
								<p className={FORM_CLASS.status}>{row.skill}</p>
								<div className={FORM_CLASS.actions}>
									<Button variant="outline" size="sm" onClick={() => void rollback(row.id)}>
										{deps.t("skillsRollback")}
									</Button>
								</div>
							</div>
						))
					)}
				</section>
			</div>
		);
	};
}
