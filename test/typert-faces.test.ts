/**
 * Cross-row guard: two host rows may not claim the same typert package face.
 *
 * The typert registry is a **host-plane singleton** keyed on
 * `${package}#${face}` (`dsh-typert-registry/lib/index.js`'s `typertPackageKey`,
 * checked by `validatePackage`). A second claim under a taken key throws
 * `typert: package face "…" is already registered`, and the throw travels out of
 * the row's `apply` as `plugin tree failed to load` — the whole harness refuses
 * to boot, not just the offending feature. Separate cordis fibers do not help:
 * the map is one.
 *
 * This is why the guard cannot live in either gateway's own suite. Each row's
 * suite mounts *that* row against a recording fake, and a fake that merely
 * records an accepted contribution cannot see a collision with a row it never
 * mounted — `test/skills-mount.test.ts`'s own comment ("a second registration of
 * the package throws in production") names the gap exactly. So this file mounts
 * every host row into **one** recording registry and asserts the claims are
 * distinct. A new host row that contributes a typert package belongs in
 * {@link ROWS}; the assertion then covers it automatically.
 *
 * Same-repo precedent for the naming rule: `buddy-telegram` already carries its
 * own package name rather than sharing the anchor row's.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { BuddyPersonaGateway } from "../src/persona/gateway.ts";
import { BuddySkillsGateway } from "../src/skills/gateway.ts";
import { TelegramGateway } from "../src/telegram/gateway.ts";

/** The registration surface a gateway reaches for, and nothing else. */
interface RegistryHost {
	reflect: { provide(name: string, value: unknown): void };
	get(name: string): unknown;
}

/** One package-face claim, as `typert.register` received it. */
interface Claim {
	readonly package: string;
	readonly face: string;
}

/** One host row, named the way `cordis.patch.yml` names it. */
interface Row {
	/** The patch row id, so a collision names the two rows that caused it. */
	readonly row: string;
	/** Construct the row's gateway on the given host. */
	readonly mount: (ctx: RegistryHost) => unknown;
}

/**
 * Every host row that contributes a typert package.
 *
 * Each constructor registers its contribution before it ever reads its
 * collaborator, so an empty object stands in for the deps: this file is about
 * package identity, and each row's own suite covers behaviour.
 */
const ROWS: readonly Row[] = [
	{ row: "buddy-persona", mount: (ctx) => new BuddyPersonaGateway(ctx as never, {} as never) },
	{ row: "buddy-skills", mount: (ctx) => new BuddySkillsGateway(ctx as never, {} as never) },
	{ row: "buddy-telegram", mount: (ctx) => new TelegramGateway(ctx as never, {} as never) },
];

/**
 * A `typert` registry that records every claim and rejects none.
 *
 * It deliberately does not reproduce `validatePackage`'s rejection: if it did,
 * the failure would surface as a throw from whichever row mounted second, and
 * the duplicate itself — the fact this file exists to pin — would never be
 * asserted on.
 * @returns the recorded claims and the host the rows mount on.
 */
function recordingRegistry(): { readonly claims: Claim[]; readonly ctx: RegistryHost } {
	const claims: Claim[] = [];
	const ctx = new Context() as unknown as RegistryHost;
	ctx.reflect.provide("typert", {
		register: (claim: Claim) => {
			claims.push(claim);
			return () => undefined;
		},
	});
	return { claims, ctx };
}

test("no two host rows claim the same typert package face", () => {
	const { claims, ctx } = recordingRegistry();
	for (const entry of ROWS) entry.mount(ctx);

	assert.equal(claims.length, ROWS.length, "every host row must contribute exactly one typert package");

	const owners = new Map<string, string[]>();
	for (const [index, claim] of claims.entries()) {
		const key = `${claim.package}#${claim.face}`;
		owners.set(key, [...(owners.get(key) ?? []), ROWS[index]?.row ?? `claim #${index}`]);
	}
	const collisions = [...owners].filter(([, rows]) => rows.length > 1);
	assert.deepEqual(
		collisions,
		[],
		"two host rows cannot share a typert package face: the registry is one host-plane map and rejects the " +
			"second with `package face \"<key>\" is already registered`, which takes the whole plugin tree down — " +
			collisions.map(([key, rows]) => `${key} <- ${rows.join(" + ")}`).join("; "),
	);
});
