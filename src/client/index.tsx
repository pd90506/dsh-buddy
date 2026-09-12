/**
 * Browser half of dsh-buddy.
 *
 * Task 7 contributes the Settings → Buddy tab. Task 8 appends the remaining two
 * registrations, and those two are a pair that must not be split:
 * `sidebar.panellist` contributes the button, `main` contributes the panel it
 * selects, and the sidebar addresses the panel by the button's own list id. A
 * button without a panel throws on click, so both are registered here or neither
 * is — which is why {@link MAIN_PANEL_KEY} is imported from the shared constants
 * module instead of being restated on either side.
 * @module dsh-buddy/client
 */
// Imported, never restated: task 8's button and panel must address the same
// string, and one shared constant is the only way they cannot drift. Nothing in
// task 7 reads it yet, so esbuild drops it from the artifact — which is why the
// "one constant" rule is pinned by a source-text assertion in
// `test/client-ui.test.ts` rather than by anything read back off the bundle.
import { MAIN_PANEL_KEY } from "../index.ts";
import { createCall } from "./call.ts";
import { createBuddySettingsSection } from "./settings.tsx";

/** Dictionary namespace owned by this plugin. */
const NS = "settings.buddy";

/** Section id in the settings left nav. */
const SECTION_ID = "buddy";

/**
 * Nav position: after Telegram (26), before Plugin Market (40).
 *
 * The renderer sorts with a bare numeric comparator and no tie-breaker, so an
 * unused number is what keeps the position stable as other plugins come and go.
 */
const SECTION_ORDER = 27;

/**
 * Required services (cordis fiber inject).
 *
 * `connection` carries the RPC caller for this plugin's own `buddyPersona/*`
 * endpoints; `layout` selects the main panel; `sessions` opens a conversation.
 */
export const inject = ["slots", "locale", "connection", "layout", "sessions"];

const en = {
	nav: "Buddy",
	soulTitle: "Persona",
	soulHint: "Voice, attitude and opinions. Saved to SOUL.md and used by buddy sessions only.",
	rulesTitle: "Operating rules",
	rulesHint: "Rules the assistant follows. Saved to AGENTS.md, kept separate from voice on purpose.",
	save: "Save",
	homeLabel: "Files:",
	panelTitle: "Buddy",
	conversations: "Conversations",
	empty: "No buddy conversations yet. Start one with the buddy agent preset.",
	untitled: "Untitled",
	refresh: "Refresh",
};

const zh: typeof en = {
	nav: "Buddy",
	soulTitle: "人格",
	soulHint: "声音、态度与观点。保存到 SOUL.md，仅对 buddy 会话生效。",
	rulesTitle: "行为规则",
	rulesHint: "助理遵循的规则。保存到 AGENTS.md，与人格刻意分开。",
	save: "保存",
	homeLabel: "文件位置：",
	panelTitle: "Buddy",
	conversations: "对话",
	empty: "还没有 buddy 对话。用 buddy agent preset 新建一个。",
	untitled: "未命名",
	refresh: "刷新",
};

/**
 * Mount the browser half.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: any): void {
	const { rpc } = ctx.get("connection");
	const t = ctx.locale.bind(NS);
	ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-buddy: dictionaries");

	// rpc.call resolves with the gateway's { ok, value | error } envelope; see
	// ./call.ts for why unwrapping it exactly once matters.
	const call = createCall(rpc);

	const BuddySettingsSection = createBuddySettingsSection({ call, t });

	ctx.slots.inject("settings.section", () =>
		ctx.slots.register(
			{ name: "settings.section", id: SECTION_ID, order: SECTION_ORDER, label: () => t("nav"), locale: NS },
			BuddySettingsSection,
		),
	);
}
