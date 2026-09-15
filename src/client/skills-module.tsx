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
import type { ReactNode } from "react";
import { Button, Input, Switch } from "@deepseek-ai/dsh-client-ui-primitives";
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

/** The two word tiers a skill may hold. */
type WordTier = (typeof WORD_TIERS)[number];

/** Prefix the host requires on a project tier. */
const PROJECT_PREFIX = "project:";

/** Locale key for one tier's label. */
const TIER_KEYS: Record<WordTier, string> = {
	buddy: "skillsVisibilityBuddy",
	global: "skillsVisibilityGlobal",
};

/** One choice in the visibility selector. */
interface TierOption {
	readonly id: WordTier;
	readonly label: string;
}

/** Collaborators supplied by the plugin's `apply`. */
export interface SkillsModuleDeps {
	call: Call;
	t(key: string): string;
}

/**
 * The selector's options and the value to preselect.
 *
 * Only the two word tiers are offered here: the host's `parseTier` accepts
 * `buddy`, `global` and a non-empty `project:<path>`, but a project tier is a
 * path the *human* names (spec §7.1 — "只在该项目目录下的会话"). A bare
 * `"project"` would be refused before any write, and picking a path on the
 * user's behalf would be this module deciding a tier for them, so the project
 * tier gets its own labelled input and apply button instead. A skill already in
 * a project tier preselects nothing rather than claiming a word tier it is not
 * in.
 * @param visibility - the skill's declared tier.
 * @param t - the locale lookup.
 * @returns the selector's options and the skill's current word tier.
 */
function tierChoice(visibility: string, t: (key: string) => string): { options: TierOption[]; value: string } {
	const value = (WORD_TIERS as readonly string[]).includes(visibility) ? visibility : "";
	return {
		options: WORD_TIERS.map((tier) => ({ id: tier, label: t(TIER_KEYS[tier]) })),
		value,
	};
}

/**
 * Read a project tier off the wire value.
 *
 * The one path-free form the host would accept — `project:` with nothing after
 * it — is deliberately not a project at all: `resolveVisibility`
 * (`src/skills/provider.ts:451`) falls back to the private tier for it, because
 * "a `project:` with no absolute path cannot be scoped honestly". Only a
 * non-empty, absolute path is a project tier.
 * @param visibility - the skill's declared tier.
 * @returns the path, when the tier really names one.
 */
function projectPathOf(visibility: string): string | undefined {
	if (!visibility.startsWith(PROJECT_PREFIX)) return undefined;
	const path = visibility.slice(PROJECT_PREFIX.length).trim();
	return path.startsWith("/") ? path : undefined;
}

/**
 * One skill row: its telemetry and the three human-only controls.
 *
 * Its own component, not an inline `map` callback, because the project-path
 * draft is per-row state — a hook in a callback would merge into the module's
 * own hook list and break the Rules of Hooks (see the panel's `<Module />`
 * rule). Only this row's own draft lives here; the listing, the error surface
 * and every write stay with the module, so one row's refusal is visible on the
 * same surface a transport failure is.
 * @param props - the skill, the locale, and the module's write/refusal callbacks.
 * @returns the row.
 */
function SkillRow(props: {
	readonly skill: Skill;
	readonly t: (key: string) => string;
	readonly onWrite: (endpoint: string, args: Record<string, unknown>) => Promise<boolean>;
	readonly onError: (message: string) => void;
}): ReactNode {
	const { skill, t, onWrite, onError } = props;
	const [pathDraft, setPathDraft] = useState("");
	const choice = tierChoice(skill.visibility, t);
	const current = projectPathOf(skill.visibility);

	return (
		<div className={FORM_CLASS.field}>
			<div className={FORM_CLASS.title}>{skill.name}</div>
			<p className={FORM_CLASS.hint}>{skill.description}</p>
			{/* Separate text nodes, not one interpolated line: the panel reads each
			    fact on its own, and a test can assert on one without depending on
			    the others' wording. */}
			<p className={FORM_CLASS.status}>{skill.curatorManaged ? t("skillsManagedByAgent") : t("skillsManagedByHuman")}</p>
			<p className={FORM_CLASS.status}>{`${t("skillsUses")}: ${String(skill.useCount)}`}</p>
			{skill.latestActivityAt !== undefined && <p className={FORM_CLASS.hint}>{skill.latestActivityAt}</p>}
			{current !== undefined && <p className={FORM_CLASS.hint}>{`${t("skillsVisibilityProject")}: ${current}`}</p>}
			<div className={FORM_CLASS.actions}>
				<Button variant="outline" size="sm" onClick={() => void onWrite("buddySkills/pin", { skill: skill.name, pinned: !skill.pinned })}>
					{skill.pinned ? t("skillsUnpin") : t("skillsPin")}
				</Button>
				{/* Only a skill a human wrote can be handed over; an
				    already-curator-managed one offers nothing to adopt. */}
				{!skill.curatorManaged && (
					<Button variant="outline" size="sm" onClick={() => void onWrite("buddySkills/adopt", { skill: skill.name })}>
						{t("skillsAdopt")}
					</Button>
				)}
				{/* The one control that can lift a skill out of the buddy tier.
				    Human-only by construction: no `skill_manage` operation reaches
				    this write, and nothing here decides a tier for the user. */}
				<span className={FORM_CLASS.label}>{t("skillsPromote")}</span>
				<Select
					name={`visibility:${skill.name}`}
					value={choice.value}
					options={choice.options}
					onChange={(tier) => void onWrite("buddySkills/visibility", { skill: skill.name, tier })}
				/>
			</div>
			{/* A project tier names one directory, so the path is typed by hand and
			    never prefilled from anything this panel happens to know. A relative
			    path is refused here rather than sent: the host's `parseTier` would
			    accept it and the provider would then quietly rescope the skill to
			    the private tier, which is a promotion that silently does nothing. */}
			<div className={FORM_CLASS.field}>
				<span className={FORM_CLASS.label}>{t("skillsProjectPath")}</span>
				<div className={FORM_CLASS.actions}>
					<Input
						className={FORM_CLASS.input}
						name={`projectPath:${skill.name}`}
						aria-label={t("skillsProjectPath")}
						placeholder="/home/you/project"
						value={pathDraft}
						onChange={(event: { target: { value: string } }) => {
							setPathDraft(event.target.value);
						}}
					/>
					<Button
						variant="outline"
						size="sm"
						onClick={() => {
							const path = pathDraft.trim();
							// Refused before any write: a `project:` that is not an
							// absolute path is one the provider would quietly rescope to
							// the private tier, so applying it would look like a promotion
							// and change nothing.
							if (!path.startsWith("/")) {
								onError(t("skillsFailed"));
								return;
							}
							void onWrite("buddySkills/visibility", { skill: skill.name, tier: `${PROJECT_PREFIX}${path}` }).then(
								(applied) => {
									if (applied) setPathDraft("");
								},
							);
						}}
					>
						{t("skillsProjectApply")}
					</Button>
				</div>
				<p className={FORM_CLASS.hint}>{t("skillsProjectPathHint")}</p>
			</div>
		</div>
	);
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
		 *
		 * A refusal resolves with `success: false` and a message rather than
		 * throwing, so the message is what the panel has to say — a resolution
		 * that renders nothing is exactly the silent failure this phase forbids.
		 * @param endpoint - the `buddySkills/*` write.
		 * @param args - its wire arguments.
		 * @returns whether the host applied it.
		 */
		const mutate = async (endpoint: string, args: Record<string, unknown>): Promise<boolean> => {
			setNotice(undefined);
			try {
				const result = (await deps.call(endpoint, args)) as Mutation;
				if (Array.isArray(result.skills)) setSkills(result.skills);
				if (result.success === false) {
					// The host's own words when it sent any; a refusal is never
					// allowed to render as nothing.
					setError(result.message === "" ? deps.t("skillsFailed") : result.message);
					return false;
				}
				setError(undefined);
				return true;			} catch (failure) {
				setError((failure as Error).message);
				return false;
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
				const result = (await deps.call("buddySkills/rollback", { entryId })) as { success: boolean; message: string };
				// Same rule as `mutate`: a refusal resolves, so its message is the
				// only thing that makes it visible. A refused undo changed nothing,
				// so it must not reload — a reload would clear the message again.
				if (result.success === false) {
					setError(result.message === "" ? deps.t("skillsFailed") : result.message);
					return;
				}
				setNotice(deps.t("skillsRolledBack"));
				setError(undefined);
				await load();
			} catch (failure) {
				setError((failure as Error).message);
			}
		};

		if (!loaded) {
			return error === undefined ? <p className={FORM_CLASS.status}>{deps.t("skillsLoading")}</p> : <p className={FORM_CLASS.error}>{error}</p>;
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
						skills.map((skill) => (
							<SkillRow
								key={skill.name}
								skill={skill}
								t={deps.t}
								onWrite={mutate}
								onError={(message: string) => {
									setNotice(undefined);
									setError(message);
								}}
							/>
						))
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
