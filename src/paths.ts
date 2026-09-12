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

/** Absolute locations of buddy's authored files. */
export interface BuddyPaths {
	/** The buddy home directory itself. */
	readonly home: string;
	/** Persona: voice, attitude, opinions. */
	readonly soul: string;
	/** Operating rules, kept separate from voice on purpose. */
	readonly agents: string;
}

/**
 * Resolve the buddy home and the files inside it.
 *
 * @param configuredHome - the `buddy.home` setting; empty or whitespace means
 * "use the harness home", which is the documented default.
 * @returns absolute paths; the directory is not created here (see `ensureBuddyHome`).
 */
export function resolveBuddyPaths(configuredHome: string): BuddyPaths {
	const raw = configuredHome.trim();
	const home = raw === "" ? dshHomePath("buddy") : absolute(expandHomePath(raw));
	return { home, soul: join(home, "SOUL.md"), agents: join(home, "AGENTS.md") };
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
