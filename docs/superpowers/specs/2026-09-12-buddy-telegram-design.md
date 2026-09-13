# dsh-buddy 第六期：Telegram 吸收 + 主界面重组

> **2026-09-13 后续修订（以此为准）：** Buddy 目录布局改为 `<buddy home>/main/`（存放 `SOUL.md`、`AGENTS.md`）与 `<buddy home>/main/workspace/`（会话工作目录），由 `src/paths.ts` 的 `resolveBuddyPaths` 解析；不再有 `~/buddy-workspace` 默认值或 `BUDDY_WORKSPACE_DEFAULT` 常量。Telegram/web 新会话**不再**注册进 `workspaceRegistry`，也**不再**被强制命名为 `Telegram: <chat>`——`meta.cwd` 直接用解析出的 workspace，会话只出现在 Buddy 文件夹、不在顶部 Workspaces 分组下，标题交由 harness 依内容自动生成。下文凡涉及 `~/buddy-workspace`、workspace 挂载、`Telegram:` 标题处，均以此修订为准（权威描述见仓库 `CLAUDE.md` 与源码）。

- 日期：2026-09-12
- 状态：设计已逐节确认，待用户审阅 spec
- 上位文档：`2026-09-12-dsh-buddy-design.md`（第 12 节「第 6 期：Telegram（吸收 dsh-telegram）」）
- 范围：`buddy-telegram` row、设置迁移与切换、Buddy 主界面模块化、侧边栏 Buddy 文件夹、Buddy 默认模型

## 1. 目标与已定决策

把现在由独立插件 dsh-telegram 驱动的 Telegram bot 改由 Buddy 驱动：从 Telegram 发来的消息进入
**带 `buddy` preset 的会话**，Telegram 的配置入口也移进 Buddy。

| # | 决策 |
|---|---|
| D1 | 沿用现有 bot `@example_dev_bot`（凭据 `TELEGRAM_BOT_TOKEN`、owner `1000000000`） |
| D2 | 吸收：dsh-telegram 源码搬进 dsh-buddy 成为 row `dsh-buddy/telegram`；web profile 卸载 dsh-telegram；dsh-telegram 仓库原样保留 |
| D3 | 每个 Telegram chat 绑定一条独立的 buddy 会话，`/new` 开新会话 |
| D4 | Bot 发出的所有文字为英文 |
| D5 | Settings → Buddy 只放元设置；Buddy 主界面承载 Buddy 自身的全部配置 |
| D6 | 左侧边栏 Settings 上方放 Buddy 文件夹，取代顶部 `sidebar.panellist` 按钮 |
| D7 | 本期加入 Buddy 默认模型 |

### 1.1 非目标

Skills 模块（第 3 期）、Kanban 模块（第 5 期）、记忆、调度器、Telegram 群组、多 bot、webhook 模式。
主界面不为未来模块放空卡片或「即将推出」占位。

## 2. 事实基础

均已在本机 harness 与 dsh-telegram 源码上核实。

| 事实 | 出处 |
|---|---|
| 一个 bot token 同时只能有一个长轮询者，第二个得到 409 Conflict | Telegram Bot API `getUpdates` 语义 |
| dsh-telegram 当前 `running`、`@example_dev_bot`、无 webhook、pending 0 | `telegram/status` 端点；`getWebhookInfo` |
| settings 命名空间正则 `/^[a-z][a-z0-9-]*$/`（允许连字符，不允许下划线） | `dsh-settings/lib/index.js:82` |
| storage unit 名正则 `/^[a-z][a-z0-9_]*$/`（允许下划线，不允许连字符） | `dsh-storage/lib/index.js:80` |
| dsh-telegram 建会话时 preset 取 `presets.resolve(undefined)`（全局默认），解析失败则不带 preset 建会话 | `dsh-telegram/src/session.ts:619,651-661` |
| 模型选择：chat 本地 `/model` > `agent-default-model.currentSelection()`；目录来自 `sessionController.modelCatalog()` | `session.ts:442,557-567`；`model.ts:109` |
| `sidebar.footer.action` 是 list slot，渲染在 `footArea` 内、`sidebar.settings` 之前（即 Settings 正上方）；该区为 `flex-direction:column`，`footerActions` 本身为横向 flex | `dsh-client-ui-sidebar/lib/client.js:28,296,299,375-403` |
| `ui-cordis` 已在 `sidebar.footer.action` 注册 `cordis-panel` | `dsh-client-ui-cordis/lib/client.js:1339` |
| 客户端 `SessionSummary` 不含 `agentPreset`，无法在浏览器端筛 buddy 会话 | `dsh-api-session-controller/lib/types/types.d.ts:145-154` |
| dsh-better-sidebar 只注册右侧 `sidebar.right.pane.tab*` | 其 `lib/client.js` |
| `dsh-client-modules` 只读取「row 名恰为包名」的包的 `dsh.client` | `exactPackageSpecifier`；本仓库 `test/patch.test.ts` |

## 3. Row 结构

`cordis.patch.yml` 追加：

```yaml
    - id: buddy-telegram
      name: 'dsh-buddy/telegram'
      config: {}
```

- 产物 `lib/telegram.js`，在 `build.mjs` 的 `hostEntries` 中显式追加；`package.json` `exports` 增加 `./telegram`。
- **硬依赖** `inject = ["typert", "storageDomain", "buddyStore"]`。`buddyStore` 保证 buddy home 与 `buddy` preset 已就位后才开始建会话。
- **软依赖**一律 `ctx.get`：`settings`、`credentials`、`agents`、`agentPresets`、`approval`、`permissionPresets`、`attachments`、`sessionController`、`agentDefaultModel`、`sessionTitle`、`sessions`。
- 独立 effect 作用域：Telegram 故障不影响 `buddy-store` / `buddy-persona`；profile 可对 `buddy-telegram` 单独 `disabled: true`。

### 3.1 代码搬迁

- `dsh-telegram/src/**` → `dsh-buddy/src/telegram/**`，内部相对结构不变（`src/telegram/telegram/{api,render,media,...}.ts` 这一层保留原名）。
- `dsh-telegram/test/**` → `dsh-buddy/test/telegram/**`；`package.json` 的 `test` 脚本改为同时覆盖子目录。
- 只改身份相关的点：插件名、settings 命名空间、domain 名、preset 来源、模型默认值链、用户可见文案（第 5 节）。其余逻辑不重写。
- 内部非 service 类（`SessionManager`、`TelegramRuntime` 等）的 `#` 私有字段保留；注册为 typert 端点的 gateway 类遵守本仓库不变式（TypeScript `private`、`ctx.typert.register`），并由走 proxy 派发的测试钉住。
- dsh-telegram `AGENTS.md` 中本仓库尚未记录的真机踩坑并入 `CLAUDE.md`。
- 新增运行时依赖（若搬迁代码需要，如 `@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-credentials`）一律列入 `dependencies` 以保持 external。

## 4. 数据归属与迁移

| 数据 | 原位置 | 新位置 |
|---|---|---|
| bot token | credentials `TELEGRAM_BOT_TOKEN` | **不变** |
| Telegram 设置 | settings `telegram` | settings `buddy-telegram` |
| chat↔session 映射、`updateOffset`、状态 | domain `telegram` | domain `buddy_telegram` |
| Buddy 默认模型 | —— | settings `buddy`：`model.provider` / `model.model` / `model.reasoningEffort`，空串 = 跟随全局 |
| 主界面模块可见性 | —— | settings `buddy`：`panel.sections.<id>`（布尔，默认全部 `true`） |

`buddy-telegram` 设置字段与 dsh-telegram 相同：`enabled`、`ownerUserId`、`defaultCwd`、`permissionPreset`、
`renderMarkdown`、`mediaDelivery`。`defaultCwd` 的出厂默认值改为 `~/buddy-workspace`；**不使用 buddy home**，
避免 agent 在工作目录里改写自己的 SOUL.md / AGENTS.md（自我修改属于第 3 期）。

### 4.1 一次性设置迁移

`buddy-telegram` row 启动、settings 源就位后：

- 条件：`buddy-telegram` 节在用户文档中**不存在**，且 `telegram` 节存在。
- 动作：拷贝 `ownerUserId`、`defaultCwd`、`permissionPreset`、`renderMarkdown`、`mediaDelivery`；写入 `enabled: false`。
- `enabled` 永不迁移：新旧两个轮询者不能因迁移同时启动。
- 迁移只读旧节，从不修改或删除 `telegram` 节。
- 已存在 `buddy-telegram` 节时什么都不做（幂等）。
- 迁移只在 dsh-telegram 仍挂载时可见旧节；若首次启动时已卸载，迁移结果为 `no-legacy`，在 Telegram 模块手动填写 owner 即可。

### 4.2 不迁移的数据

- **chat 映射**：旧映射指向普通会话，不是 buddy 会话，从零开始。
- **`updateOffset`**：dsh-telegram 已确认所有 update（pending 0），新 domain 无游标时 Telegram 只重投未确认的 update，不会重放历史。代价：切换窗口内发出的消息可能丢失。
- 旧 domain `telegram` 原封不动，供回退使用。

### 4.3 占用保护

轮询启动前检查 loader 中是否存在未禁用、名为 `dsh-telegram` 的 row，且 settings `telegram.enabled` 为 `true`（经 `ctx.get('settings')` 读取；读不到 settings 视为不占用）。
成立则不轮询，状态为 `error`，详情 `dsh-telegram is still polling this bot; remove it from the profile first`。
这把「两边都在轮询、409 且无从查起」变成界面上可读的一句话。

## 5. 会话、preset、模型、命令

### 5.1 Preset

- 建会话：`presets.resolve(BUDDY_PRESET_ID)`，常量从 `src/index.ts` 导入。
- **fail-closed**：解析失败时不建会话、不写映射，回复 `Buddy preset unavailable: <reason>`。不回落到全局默认。
- 恢复：会话 header 中记录的 preset 优先（沿用现有逻辑）。
- 会话标题沿用 `Telegram: <chat title>`；因带 `buddy` preset，自动出现在 Buddy 文件夹。

### 5.2 模型优先级

1. chat 本地 `/model` 选择（`buddy_telegram.chats` 记录）
2. Buddy 默认模型（settings `buddy.model`，三字段 provider/model 非空才生效）
3. 全局默认（`agentDefaultModel.currentSelection()`）

只作用于**新建**会话；已有会话保持创建时的模型。优先级解析实现为一个纯函数，供 Telegram 与网页新建两条路径共用并单测。

### 5.3 命令

仅保留 `/new`、`/model`、`/stop`、`/help`，不新增。

### 5.4 文案

Bot 发出的一切文字为英文：`/help`、状态、错误、审批提示与按钮、`/model` 菜单、文件回执。
一个测试扫描 `src/telegram/**/*.ts`，先剥离 `//` 与 `/* */` 注释，再断言剩余源码不含 CJK 字符（`/[　-鿿＀-￯]/`）；`test/**` 不在扫描范围。

`/help` 内容：

```
I'm Buddy, running inside DeepSeek Harness on this machine. Message me and I'll work here.

Commands:
/new — start a new conversation (same working directory)
/model — change the model for this chat (desktop default unaffected)
/stop — stop the current turn
/help — this message

Working directory: <defaultCwd>
Model: <model | (follows default)>
Status: <off | starting… | running | error>
Permission level: <permissionPreset>

Files you send me are saved under downloads/ in the working directory.
```

### 5.5 原样继承

owner 白名单默认拒绝、审批按钮、文件收发、Markdown 渲染、媒体回传、网页端继续同一会话的行为。
网页继续会话的行为在 probe 中实测，不假设。

## 6. 界面

### 6.1 Settings → Buddy（精简）

- 主界面各模块显示 / 隐藏开关（`panel.sections.<id>`）。
- `home` 路径（保留）。
- 现有 SOUL.md / AGENTS.md 编辑区移出。
- 文案 en + zh。

### 6.2 Buddy 主界面（模块注册表）

主界面由有序模块组成，每个模块 `{ id, order, title, Component }`，由一个模块表驱动；被 `panel.sections.<id> === false` 隐藏的模块不渲染。
后续各期只向表中追加模块，不改框架。

顶部：**New Buddy conversation** 按钮 —— 新建带 `buddy` preset 与 5.2 模型的会话并打开。
客户端经 `remote.session.create({ cwd, agentPreset })` 建会话，再以 `remote.session.selectModel` 应用模型；工作目录来自 `buddyPersona/preferences.conversationCwd`（`~/buddy-workspace`）。

| 模块 | 内容 |
|---|---|
| Soul | SOUL.md 编辑器（从 Settings 迁入） |
| Agents | AGENTS.md 编辑器（从 Settings 迁入） |
| Model | provider / model 下拉（`modelCatalog()`）、推理强度、「Follow global default」开关 |
| Telegram | 状态、`@bot`、会话数、错误详情（含 4.3 占用提示）；token 仅显示 configured/source/writable 并可替换；`enabled`、`ownerUserId`、`defaultCwd`、`permissionPreset`、`renderMarkdown`、`mediaDelivery` |

新增端点（均经 `ctx.typert.register`，浏览器不直接写 settings / credentials 之外的平面）：
- `buddyPersona/preferences` / `buddyPersona/updatePreferences`；模型目录来自 `remote.session.modelCatalog()`
- `buddyTelegram/status` / `buddyTelegram/config` / `buddyTelegram/updateConfig`
- token 写入沿用平台 `credentials.*` RPC（与 dsh-telegram 相同），token 永不回传浏览器

### 6.3 侧边栏 Buddy 文件夹

- 注册于 `sidebar.footer.action`，id `buddy-folder`；删除 `sidebar.panellist` 注册。根元素 `width:100%`，独占一行。
- 宽栏：`Buddy` 标题 + 展开箭头。点标题 → `ctx.layout.selectPanel(MAIN_PANEL_KEY)`；点箭头 → 展开/收起。
  展开后列出 buddy 会话（最近活动排序，Telegram 来源带标记，当前会话高亮），点击 → `ctx.sessions.open(id)` + `selectPanel(null)`。
  列表限高并可滚动。展开状态存 `localStorage`（try/catch 包裹，读不到则默认收起）。
- 窄栏（`wide === false`）：只显示图标，点击打开主界面。
- 数据：`buddyPersona/sessions`；展开时拉取，`ctx.sessions.list` 每次变化重拉。`BuddySessionSummary` 增加 `source: "telegram" | "web"`：`buddy-telegram` 发布服务 `ctx.buddyTelegram`，提供 `boundSessionIds(): Promise<Set<string>>`（读 `buddy_telegram.chats`）；`buddy-persona` 以 `ctx.get('buddyTelegram')` 软读取，服务不存在时全部标为 `web`。不以标题前缀判定（标题可被用户改名）。
- `MAIN_PANEL_KEY` 不变式保留：文件夹打开主界面与主界面注册同用该常量，同生同死。

## 7. 测试

- 搬迁的 dsh-telegram 测试全部在 `npm test` 下运行并通过。
- 新增：
  - 设置迁移：条件成立时拷贝且 `enabled: false`；已存在新节时不动；旧节不被修改。
  - preset fail-closed：解析失败不建会话、不写映射、回复英文错误。
  - 占用保护：`dsh-telegram` row 在且启用时拒绝轮询并给出状态。
  - 模型优先级纯函数的全部分支。
  - 英文文案扫描。
  - `test/patch.test.ts` 扩展：`buddy-telegram` row 存在。
  - `mount.test.ts` 扩展：三个 host row 在真 cordis 中挂载；`buddyTelegram` 端点经 proxy 派发。
  - `client-ui.test.ts`（针对 `lib/client.js`）：文件夹注册于 `sidebar.footer.action` 且无 `sidebar.panellist`；点标题选中 `MAIN_PANEL_KEY`；点会话调 `sessions.open`；模块表按可见性渲染；Settings → Buddy 只含元设置。

## 8. 验证

### 8.1 Probe（隔离 `DSH_HOME`，不接真实 bot）

真实 token 仍被正式实例轮询，probe 不得轮询同一 token。probe 中验证：

1. 三个 host row + 前端加载，浏览器控制台无报错。
2. 预置含 `telegram` 节的 probe `settings.yaml`，重启后 `buddy-telegram` 已迁移且 `enabled: false`。
3. probe 同时挂 dsh-telegram 并启用时，Telegram 模块显示占用提示。
4. 无头 Chromium：文件夹在 Settings 上方；主界面四模块；Settings → Buddy 只剩元设置；隐藏开关生效。
5. New Buddy conversation 建出的会话带 `buddy` preset 与 Buddy 默认模型，并出现在文件夹。
6. 结束后 `find ~/.dsh -newermt '<probe start>'` 为空。

### 8.2 正式切换（执行前须用户当场确认）

1. 正式实例通过 `~/.dsh/profiles/web/node_modules/dsh-buddy` 的符号链接加载 `/home/panda-nuc/repo/dsh-buddy`（`master` checkout），不是本 worktree；且 `lib/` 未纳入版本控制。因此在 `/home/panda-nuc/repo/dsh-buddy` 里执行 `git merge --ff-only feat/phase-6-telegram`，接着 `npm install && npm run check`（在该 checkout 里，而非本 worktree），check 一结束立即 `systemctl --user restart dsh-web.service`——两步紧跟着做，中间不插入别的步骤：`npm run check` 会构建 `lib/client.js`，浏览器端一构建完就热重载，宿主端却不会，中间的空档就是热重载后的前端去调旧宿主进程还没有的 `buddyTelegram/*` 端点。合并完成之后才可以删除本 worktree。此时 dsh-telegram 仍挂载：`buddy-telegram` 因占用保护不轮询，但设置迁移在此时完成（settings 平面只能描述已注册的命名空间，dsh-telegram 卸载后就读不到旧节）。
2. 确认 `~/.dsh/settings.yaml` 出现 `buddy-telegram` 节，`ownerUserId` 已迁移、`enabled: false`；Telegram 模块显示占用提示。
3. `dsh plugin --profile web remove dsh-telegram`，重启 `dsh-web`。
4. 在主界面开启 Telegram，状态 `running @example_dev_bot`。
5. 用户手机实测：`/help` 为英文；普通消息得到 Buddy 口吻回复，会话出现在文件夹；审批按钮与发文件各一次。
6. 与 8.1 的 probe（隔离 `DSH_HOME`，用完即清）不同，本次切换作用于真实 `~/.dsh`，预期留下真实且永久的变化，确认恰好是这些、别无其它：`~/.dsh/settings.yaml` 新增 `buddy` 与 `buddy-telegram` 节（后者由旧 `telegram` 节迁移而来）；`~/.dsh/storages/buddy_telegram*` 为 Telegram row 自己的存储 domain；`~/.dsh/storages/workspace.json` 新增 `buddy-workspace` 及（一旦某个 Telegram 会话跑过一轮对话后）其 `cwd` 对应的 workspace 条目；`~/buddy-workspace` 在某个 buddy 会话（web 或 Telegram）首次需要默认工作目录时被创建。

## 9. 回退

迁移只读不写旧数据，dsh-telegram 仓库不变，因此回退无损：

1. 主界面关闭 Telegram，或 profile patch 中 `buddy-telegram` 设 `disabled: true`。
2. 把 dsh-telegram 加回 profile 并 install。
3. 重启。dsh-telegram 以原 token、原 `telegram` 设置、原 `telegram` domain 映射恢复。
