/**
 * Browser half of dsh-buddy.
 *
 * Two registrations are a pair that must not be split: the sidebar folder's
 * title (`sidebar.footer.action`) selects the main panel (`main`), and the
 * sidebar addresses it by the shared panel key. A title without a panel throws
 * on click, so both are registered here or neither is — which is why
 * {@link MAIN_PANEL_KEY} is imported from the shared constants module instead
 * of being restated on either side.
 *
 * The main panel is a module table (Soul, Agents, Model, Telegram); the
 * Settings tab surfaces Buddy's own settings, not the conversations, which the
 * sidebar folder lists directly above Settings.
 * @module dsh-buddy/client
 */
// Imported, never restated: the sidebar folder (sidebar.footer.action) and the
// panel it selects (main) must address the same string, and one shared
// constant is the only way they cannot drift apart in a later edit. Bundling
// inlines the value either way, so no assertion against the built artifact can
// tell a hand-restated constant from the shared one — which is why the "one
// constant" rule is pinned by a source-text assertion in
// `test/client-ui.test.ts` instead.
import { MAIN_PANEL_KEY } from "../index.ts";
import { TELEGRAM_TOKEN_KEY } from "../telegram/credential-key.ts";
import { createCall } from "./call.ts";
import { createDocumentModule } from "./document-module.tsx";
import { createBuddyFolder } from "./folder.tsx";
import { installCss } from "./css.ts";
import { FOLDER_CSS, FOLDER_CSS_ID } from "./folder-css.ts";
import { FORM_CSS, FORM_CSS_ID } from "./form-css.ts";
import { createModelModule } from "./model-module.tsx";
import type { PanelModule } from "./modules.ts";
import { createNotifier } from "./notifier.ts";
import { createBuddyPanel } from "./panel.tsx";
import { createBuddySettingsSection } from "./settings.tsx";
import { createTelegramModule } from "./telegram-module.tsx";

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
 * `remote.session` supplies the model catalog; `remote.credentials` is what
 * the Telegram module writes the bot token through — `remote` alone carries
 * only `$on`/`$mount`, not the namespace.
 */
export const inject = [
	"slots",
	"locale",
	"connection",
	"layout",
	"sessions",
	"remote",
	"remote.session",
	"remote.credentials",
];

const en = {
	nav: "Buddy",
	panelTitle: "Buddy",
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
	more: "More actions",
	archive: "Archive",
	modelHint: "Default model for new Buddy conversations. A chat's own /model choice still wins.",
	modelFollow: "Follow the global default model",
	modelProvider: "Provider",
	modelModel: "Model",
	modelEffort: "Reasoning effort",
	modelEffortDefault: "Model default",
	modelChoose: "Choose…",
	telegramTokenTitle: "Bot token",
	telegramTokenHint: "From @BotFather. Stored in your harness credential file and never shown again once saved.",
	telegramTokenConfigured: "Token configured",
	telegramTokenMissing: "No token yet",
	telegramTokenWritable: "editable",
	telegramTokenReadOnly: "read-only",
	telegramTokenPlaceholder: "123456:ABC-DEF…",
	tokenSave: "Save token",
	tokenClear: "Clear token",
	telegramSave: "Save",
	telegramSaved: "Saved.",
	telegramCleared: "Token cleared.",
	telegramConfigTitle: "Configuration",
	telegramOwnerLabel: "Owner user id",
	telegramOwnerHint: "The only Telegram account allowed to use this bot. Message @userinfobot to find yours.",
	telegramCwdLabel: "Working directory",
	telegramCwdHint: "Where Buddy's Telegram conversations run. Created on first use if it does not exist.",
	telegramPresetLabel: "Permission level",
	telegramPresetHint: "Telegram sessions ask for approval before risky calls, and answer with buttons in the chat.",
	telegramPresetReadOnly: "Read only",
	telegramPresetWorkspace: "Workspace write",
	telegramPresetFull: "Full access",
	telegramMarkdownLabel: "Native formatting",
	telegramMarkdownHint:
		"Render the agent's Markdown as Telegram formatting: bold headings, lists, quotes, links, tables, language-tagged code blocks.",
	telegramMediaLabel: "Send media back",
	telegramMediaHint:
		"Images and files the agent produces arrive in the chat. Files are only ever read from inside the session's working directory.",
	telegramMediaOff: "Text only",
	telegramMediaPresented: "Delivered files only",
	telegramMediaAll: "Generated images and delivered files",
	telegramEnabledLabel: "Enable the bot",
	telegramEnabledHint: "Start polling while a token is configured.",
	telegramStatusTitle: "Status",
	telegramStatusOff: "Stopped",
	telegramStatusStarting: "Starting…",
	telegramStatusRunning: "Running",
	telegramStatusError: "Error",
	telegramStatusSessions: (count: number) => `${String(count)} session(s)`,
	telegramLoading: "Loading…",
	telegramRetry: "Retry",
	telegramUnsaved: "You have unsaved changes.",
};

const zh: typeof en = {
	nav: "Buddy",
	panelTitle: "Buddy",
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
	more: "更多操作",
	archive: "归档",
	modelHint: "新建 Buddy 对话默认使用的模型。聊天里用 /model 单独选的模型仍然优先。",
	modelFollow: "跟随全局默认模型",
	modelProvider: "Provider",
	modelModel: "模型",
	modelEffort: "推理强度",
	modelEffortDefault: "模型默认",
	modelChoose: "请选择…",
	telegramTokenTitle: "Bot token",
	telegramTokenHint: "从 @BotFather 拿。存在 harness 的凭据文件里，保存后不再回显。",
	telegramTokenConfigured: "已配置 token",
	telegramTokenMissing: "还没有 token",
	telegramTokenWritable: "可修改",
	telegramTokenReadOnly: "只读",
	telegramTokenPlaceholder: "123456:ABC-DEF…",
	tokenSave: "保存 token",
	tokenClear: "清除 token",
	telegramSave: "保存",
	telegramSaved: "已保存。",
	telegramCleared: "token 已清除。",
	telegramConfigTitle: "配置",
	telegramOwnerLabel: "Owner user id",
	telegramOwnerHint: "只有这个 Telegram 账号能用这个 bot。给 @userinfobot 发条消息就能查到自己的 id。",
	telegramCwdLabel: "工作目录",
	telegramCwdHint: "Buddy 的 Telegram 对话在这里跑。目录不存在会在首次使用时创建。",
	telegramPresetLabel: "权限级别",
	telegramPresetHint: "Telegram 会话在危险操作前会请求许可，在聊天里用按钮回答。",
	telegramPresetReadOnly: "只读",
	telegramPresetWorkspace: "工作区可写",
	telegramPresetFull: "完全访问",
	telegramMarkdownLabel: "原生格式渲染",
	telegramMarkdownHint: "把 agent 的 Markdown 渲染成 Telegram 原生格式：标题加粗、列表、引用、链接、表格、带语言标记的代码块。",
	telegramMediaLabel: "回传图片与文件",
	telegramMediaHint: "agent 产出的图片和文件直接出现在聊天里。文件只会从会话的工作目录内部读取。",
	telegramMediaOff: "只发文字",
	telegramMediaPresented: "只回传明确交付的文件",
	telegramMediaAll: "工具生成的图片与交付的文件",
	telegramEnabledLabel: "启用 bot",
	telegramEnabledHint: "填了 token 且打开时会开始轮询。",
	telegramStatusTitle: "状态",
	telegramStatusOff: "已停止",
	telegramStatusStarting: "启动中…",
	telegramStatusRunning: "运行中",
	telegramStatusError: "出错",
	telegramStatusSessions: (count: number) => `${String(count)} 条会话`,
	telegramLoading: "载入中…",
	telegramRetry: "重试",
	telegramUnsaved: "有改动还没保存。",
};

/**
 * Mount the browser half.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: any): void {
	const { rpc } = ctx.get("connection");
	const t = ctx.locale.bind(NS);
	ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-buddy: dictionaries");

	ctx.effect(() => installCss(globalThis.document, FORM_CSS_ID, FORM_CSS), "dsh-buddy: form stylesheet");
	ctx.effect(() => installCss(globalThis.document, FOLDER_CSS_ID, FOLDER_CSS), "dsh-buddy: sidebar folder stylesheet");

	// rpc.call resolves with the gateway's { ok, value | error } envelope; see
	// ./call.ts for why unwrapping it exactly once matters.
	const call = createCall(rpc);

	// Shared by the settings tab and the main panel, mounted separately below:
	// this is the only channel a module-visibility change has to reach the
	// already-mounted panel without remounting it.
	const preferencesChanged = createNotifier();

	const BuddySettingsSection = createBuddySettingsSection({ call, t, preferencesChanged });

	ctx.slots.inject("settings.section", () =>
		ctx.slots.register(
			{ name: "settings.section", id: SECTION_ID, order: SECTION_ORDER, label: () => t("nav"), locale: NS },
			BuddySettingsSection,
		),
	);

	/** Unwrap a `remote.*` RemoteResult. */
	const remoteValue = (result: any, what: string): any => {
		if (result?.ok !== true) throw new Error(result?.error?.message ?? `${what} failed`);
		return result.value;
	};

	const modules: PanelModule<() => unknown>[] = [
		{ id: "soul", order: 10, titleKey: "soulTitle", Component: createDocumentModule({ call, t }, "soul") },
		{ id: "agents", order: 20, titleKey: "agentsTitle", Component: createDocumentModule({ call, t }, "agents") },
		{
			id: "model",
			order: 30,
			titleKey: "modelTitle",
			Component: createModelModule({
				call,
				t,
				catalog: async () => remoteValue(await ctx.remote.session.modelCatalog(), "model catalog"),
			}),
		},
		{
			id: "telegram",
			order: 40,
			titleKey: "telegramTitle",
			Component: createTelegramModule({
				call,
				t,
				writeToken: async (value) => {
					const credentials = ctx.remote?.credentials;
					if (credentials === undefined) throw new Error("remote.credentials is not mounted");
					const result =
						value === undefined ? await credentials.unset(TELEGRAM_TOKEN_KEY) : await credentials.set(TELEGRAM_TOKEN_KEY, value);
					if (result?.ok !== true) throw new Error(result?.error?.message ?? "credential write failed");
				},
			}),
		},
	];

	const openSession = (sessionId: string): void => {
		ctx.sessions.open(sessionId);
		// null returns the centre column to the Conversation.
		ctx.layout.selectPanel(null);
	};

	const BuddyPanel = createBuddyPanel({ call, t, modules, preferencesChanged });

	// One shared constant for both registrations, so the id and the key cannot
	// drift apart in a later edit.
	ctx.slots.inject("main", function* () {
		yield ctx.slots.register({ name: "main", key: MAIN_PANEL_KEY }, BuddyPanel);
	});

	const EXPANDED_KEY = "dsh-buddy.folder.expanded";
	const BuddyFolder = createBuddyFolder({
		call,
		t,
		openPanel: () => ctx.layout.selectPanel(MAIN_PANEL_KEY),
		openSession,
		list: ctx.sessions.list,
		expanded: {
			// Per-browser convenience only; storage may be absent or throw.
			read: () => {
				try {
					return globalThis.localStorage?.getItem(EXPANDED_KEY) === "1";
				} catch {
					return false;
				}
			},
			write: (value) => {
				try {
					globalThis.localStorage?.setItem(EXPANDED_KEY, value ? "1" : "0");
				} catch {
					// ignored
				}
			},
		},
		// `ctx.sessions.list` changes on every streaming/title snapshot, so this
		// must coalesce rapid-fire notifications into one reload rather than
		// firing `buddyPersona/sessions` per snapshot while the folder is open.
		// `test/client-folder.test.ts` proves the coalescing with real timers.
		reloadDelayMs: 500,
	});

	// Directly above Settings: `sidebar.footer.action` renders in the foot area
	// before `sidebar.settings`. Negative order sorts it ahead of ui-cordis's
	// `cordis-panel` (order 0), which renders nothing unless it has content.
	ctx.slots.inject("sidebar.footer.action", () =>
		ctx.slots.register({ name: "sidebar.footer.action", id: "buddy-folder", order: -10, locale: NS }, BuddyFolder),
	);
}
