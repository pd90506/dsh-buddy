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
 *
 * Task 11 turns the main panel into a module table (Soul, Agents, New Buddy
 * conversation) and slims the Settings tab down to surfaces about Buddy rather
 * than Buddy's own persona.
 * @module dsh-buddy/client
 */
// Imported, never restated: the button (sidebar.panellist) and the panel it
// selects (main) must address the same string, and one shared constant is the
// only way they cannot drift apart in a later edit. Bundling inlines the value
// either way, so no assertion against the built artifact can tell a hand-
// restated constant from the shared one — which is why the "one constant" rule
// is pinned by a source-text assertion in `test/client-ui.test.ts` instead.
import { MAIN_PANEL_KEY, BUDDY_PRESET_ID } from "../index.ts";
import { selectionFromDefault } from "../model-selection.ts";
import { createCall } from "./call.ts";
import { createDocumentModule } from "./document-module.tsx";
import type { PanelModule } from "./modules.ts";
import { createBuddyIcon, createBuddyPanel } from "./panel.tsx";
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
 * endpoints; `layout` selects the main panel; `sessions` opens a conversation;
 * `remote.session` creates a buddy conversation with its preset and model.
 */
export const inject = ["slots", "locale", "connection", "layout", "sessions", "remote", "remote.session"];

const en = {
	nav: "Buddy",
	panelTitle: "Buddy",
	newConversation: "New Buddy conversation",
	soulTitle: "Soul",
	soulHint: "Voice, attitude and opinions. Saved to SOUL.md and used by buddy conversations only.",
	agentsTitle: "Agents",
	agentsHint: "Rules Buddy follows. Saved to AGENTS.md, kept separate from voice on purpose.",
	modelTitle: "Model",
	telegramTitle: "Telegram",
	save: "Save",
	homeLabel: "Files:",
	settingsHint: "Choose what the Buddy main panel shows. Buddy itself is configured from the main panel.",
	sectionsTitle: "Main panel modules",
	folderTitle: "Buddy",
	folderEmpty: "No conversations yet",
	untitled: "Untitled",
	fromTelegram: "Telegram",
	expand: "Show conversations",
	collapse: "Hide conversations",
};

const zh: typeof en = {
	nav: "Buddy",
	panelTitle: "Buddy",
	newConversation: "新建 Buddy 对话",
	soulTitle: "Soul",
	soulHint: "声音、态度与观点。保存到 SOUL.md，仅对 buddy 对话生效。",
	agentsTitle: "Agents",
	agentsHint: "Buddy 遵循的规则。保存到 AGENTS.md，与人格刻意分开。",
	modelTitle: "模型",
	telegramTitle: "Telegram",
	save: "保存",
	homeLabel: "文件位置：",
	settingsHint: "选择 Buddy 主界面显示哪些模块。Buddy 本身在主界面里配置。",
	sectionsTitle: "主界面模块",
	folderTitle: "Buddy",
	folderEmpty: "还没有对话",
	untitled: "未命名",
	fromTelegram: "Telegram",
	expand: "展开对话",
	collapse: "收起对话",
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

	const modules: PanelModule<() => unknown>[] = [
		{ id: "soul", order: 10, titleKey: "soulTitle", Component: createDocumentModule({ call, t }, "soul") },
		{ id: "agents", order: 20, titleKey: "agentsTitle", Component: createDocumentModule({ call, t }, "agents") },
	];

	const openSession = (sessionId: string): void => {
		ctx.sessions.open(sessionId);
		// null returns the centre column to the Conversation.
		ctx.layout.selectPanel(null);
	};

	/** Unwrap a `remote.*` RemoteResult. */
	const remoteValue = (result: any, what: string): any => {
		if (result?.ok !== true) throw new Error(result?.error?.message ?? `${what} failed`);
		return result.value;
	};

	const newConversation = async (): Promise<void> => {
		const session = ctx.remote?.session;
		if (session === undefined) throw new Error("remote.session is not mounted");
		const prefs = (await call("buddyPersona/preferences", {})) as {
			model: { provider: string; model: string; reasoningEffort: string };
			conversationCwd: string;
		};
		const created = remoteValue(
			await session.create({ cwd: prefs.conversationCwd, agentPreset: BUDDY_PRESET_ID }),
			"session create",
		) as { sessionId: string };
		const selection = selectionFromDefault(prefs.model);
		if (selection !== undefined) {
			remoteValue(await session.selectModel({ sessionId: created.sessionId, ...selection }), "model selection");
		}
		// A raw remote create bypasses the client list; refresh before opening.
		await ctx.sessions.refresh();
		openSession(created.sessionId);
	};

	const BuddyPanel = createBuddyPanel({ call, t, modules, newConversation });
	const BuddyIcon = createBuddyIcon();

	// One shared constant for both registrations, so the id and the key cannot
	// drift apart in a later edit.
	ctx.slots.inject("main", function* () {
		yield ctx.slots.register({ name: "main", key: MAIN_PANEL_KEY }, BuddyPanel);
	});

	ctx.slots.inject("sidebar.panellist", () =>
		ctx.slots.register(
			{ name: "sidebar.panellist", id: MAIN_PANEL_KEY, order: 10, label: () => t("nav"), locale: NS },
			BuddyIcon,
		),
	);
}
