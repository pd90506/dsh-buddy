/**
 * Where buddy's human-and-agent-authored files live.
 *
 * Content a person or the agent writes — the persona, the rules, later the
 * memory files — belongs on disk as plain Markdown, not in the storage domain:
 * self-evolution edits these with ordinary file tools, and files stay
 * greppable, diffable and backup-able. Derived machine state goes to the
 * `buddy` domain instead (see `store/domain.ts`).
 *
 * The harness home is never hardcoded. `dshHomePath` applies the deployment's
 * own precedence (explicit configuration, then `$DSH_HOME`, then `~/.dsh`).
 * @module dsh-buddy/paths
 */
import { isAbsolute, join, resolve } from "node:path";
import { dshHomePath, expandHomePath } from "@deepseek-ai/dsh-home-paths";

/** Absolute locations of buddy's authored files and its working directory. */
export interface BuddyPaths {
	/** The buddy home directory itself. */
	readonly home: string;
	/** The `main` layer under the home: authored files and the workspace. */
	readonly main: string;
	/** Persona: voice, attitude, opinions. */
	readonly soul: string;
	/** Operating rules, kept separate from voice on purpose. */
	readonly agents: string;
	/**
	 * Where buddy conversations run. A sibling of the authored files under
	 * `main/`, never their directory: the `workspace-write` permission preset
	 * scopes writes to the session cwd, so an agent working here cannot reach
	 * `../SOUL.md` or `../AGENTS.md` — self-modification stays a later phase's
	 * decision.
	 */
	readonly workspace: string;
	/**
	 * Skill directories Buddy's auto-evolution writes.
	 *
	 * A sibling of the authored files under `main/`, and deliberately NOT under
	 * {@link workspace}: a skills directory inside the session cwd would be
	 * discovered as a project skill root by any session whose cwd is the
	 * workspace, which would defeat the isolation contract.
	 */
	readonly skills: string;
	/**
	 * Content-addressed pre-write snapshots.
	 *
	 * Under `skills/` rather than the home so it belongs to the same layer, and
	 * dot-prefixed so it can never collide with a skill directory — the skill
	 * name grammar forbids a leading dot.
	 */
	readonly skillSnapshots: string;
}

/**
 * Resolve the buddy home and the paths inside it.
 *
 * @param configuredHome - the `buddy.home` setting; empty or whitespace means
 * "use the harness home", which is the documented default.
 * @returns absolute paths; the directories are not created here (see the store row).
 */
export function resolveBuddyPaths(configuredHome: string): BuddyPaths {
	const raw = configuredHome.trim();
	const home = raw === "" ? dshHomePath("buddy") : absolute(expandHomePath(raw));
	const main = join(home, "main");
	const skills = join(main, "skills");
	return {
		home,
		main,
		soul: join(main, "SOUL.md"),
		agents: join(main, "AGENTS.md"),
		workspace: join(main, "workspace"),
		skills,
		skillSnapshots: join(skills, ".snapshots"),
	};
}

/**
 * Force an absolute path, because a relative buddy home would follow the
 * process working directory and silently move between launches.
 * @param path - an expanded path that may still be relative.
 * @returns the absolute form.
 */
function absolute(path: string): string {
	return isAbsolute(path) ? path : resolve(path);
}
