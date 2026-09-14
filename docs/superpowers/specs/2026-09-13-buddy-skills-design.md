# dsh-buddy 第 3 期设计：技能自动进化（创建半边）

- 日期：2026-09-13
- 状态：待评审
- 范围：第 3a 期（技能自动总结 / 创建半边）。第 3b 期（curator 生命周期、确定性剪枝、报告）只在本文件中留接口与常量，不出实施计划。
- 参考实现：`NousResearch/hermes-agent`，快照 `/tmp/hermes-research/src/hermes-agent-main`（下称 `$H`）。凡本文写 `$H:path:line` 的都是从该快照读出来的原码位置。
- 本仓库事实：DSH 安装于 `/home/panda-nuc/.npm-global/lib/node_modules/@deepseek-ai/dsh/`（下称 `$DSH`）。

## 0. 一句话

让 Buddy 在对话结束后**自己开一个独立会话回头看刚才那段对话**，把可复用的做法写成技能文件；这些技能**在结构上只对 Buddy 会话可见**，并且写入全程有快照、账本、可一键回滚，且只有"后台总结自己产出"的技能才归自动管理。

## 1. 非目标（第 3a 期不做）

- 记忆系统（`$H` 的 `_MEMORY_REVIEW_PROMPT` / combined 分支）——等第 2 期。
- curator 生命周期：确定性剪枝（30/90 天）、`interval_hours`、报告文件 `run.json` / `REPORT.md`、LLM 整合 pass —— 第 3b 期。
- defer 空闲队列、前台抢断、模型忙碌计量器 —— 见 §11.3。
- cron 引用豁免（`$H` 的 `_cron_referenced_skills`）—— DSH 第 4 期才有 scheduler。
- `skills_list()` 工具 —— DSH 的技能目录是随会话发布的 context 消息（`$DSH/node_modules/@deepseek-ai/dsh-tool-skill/lib/types/index.d.ts` 的 `SkillCatalogSource`），不是工具。

## 2. 事实基础（逐条核过，不是推测）

### 2.1 隔离所依赖的 DSH 机制

| 事实 | 证据 |
|---|---|
| `ctx.skills` 是**按 scope 分层**的注册表；注册落进**调用者 ctx 所属的层**；读取合并 global 层与观察者的 scope 链，"最近层的同名条目直接获胜" | `dsh-skill/lib/index.js` `SkillRegistry` 注释与 `layers.effect(this.ctx, …)` |
| `tools.register()` 走同一个 `ScopedLayers.effect(this.ctx, …)`，工具同样按层隔离 | `dsh-tools/lib/index.js:2592,2781` |
| agent 的 scope key 由 `bindScopeParent(agentKey, standing.key)` 挂在 preset 的 standing key 之下 | `dsh-agent-presets/lib/index.js:1504,1538,1702` |
| 无 tag 的宿主监听器被**全局**接纳；有 tag 的监听器只收自身及祖先 scope 的事件 | `dsh-scope/lib/index.js` `scopeTarget()` |
| host composition 里有一个 **global 层**的 `skill-filesystem` provider，扫描 `~/.dsh/skills`、`~/.agents/skills`、`<cwd>/.dsh/skills` 等默认根 | `dsh-base/cordis.patch.yml:273-285` |
| `buddy` preset 已挂 `skill-filesystem` + `tool-skill` 两行，注释明说"these rows register into THIS preset's layer of it" | `assets/preset/agent.cordis.yml` skills 段 |

### 2.2 触发与子会话

| 事实 | 证据 |
|---|---|
| `session/event` 是 post-commit 的事件流，携带 `SessionEvent`，`Scoped<Session>` | host Event inspect provider |
| `turn/end` 事件带 `{turn, reason: TurnEndReason}`，`reason.kind ∈ {completed, aborted, blocked, error, max-tokens, interrupted}` | `SessionEventMap`（sessionQuery 契约） |
| 一个 step = 一次模型调用加上它请求的工具执行 | `SessionEventMap` 的 `step/start` 注释：*"one model call plus the tool executions it requested"* |
| `assistant/message` 事件带 `usage?: TokenUsage`，`TokenUsage` 含 `inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens/reasoningTokens` | sessionQuery 契约引用类型 |
| `ctx.subagents.start('fork', …)` 的 seed = 父日志**已完成回合前缀**（`turn/end` 之前），因此 `turn/end` 之后触发必然包含刚结束那一轮 | `dsh-subagent-fork-in-process/lib/index.js` `completedTurnPrefix` |
| `SubagentStartRequest` 支持 `agentOptions`（provider/model 合并覆盖父路由）、`toolFilter`（子会话内 `tools.restrict`，**既不可见也拒绝执行**）、`outputSchema`、`maxDepth` | `dsh-subagent/lib/types/types.d.ts:136-198` |
| 子会话 `meta` 由 `childSessionMeta()` 构造：继承 `cwd`、`agentPreset`（取自父的 live scope chain）、`parentSession`、`isSeeded`、`origin:'subagent'`、`delegationDepth` | `dsh-subagent/lib/types/child-agent.js:110-125` |
| `SubagentRun.id` **就是**已发布子会话的 session id | `dsh-subagent/lib/types/types.d.ts:292-298` |
| `subagents.interrupt(targetSessionId, authority)`，authority 为 `{kind:'user', parentSessionId}` 或 `{kind:'ancestor', agent}` | `dsh-subagent/lib/types/types.d.ts:57-63` |
| `fork` 与 `spawn` 两个内进程 provider 都由 **host composition** 装载 | `dsh-base/cordis.patch.yml:331-337` |
| `ToolExecutionInput` 带 `name`、`arguments`（已解析）、`agent?`；`tools/post-execute` 是 `Scoped<ToolRuntime>` | `dsh-tools/lib/types/index.d.ts:197-221` |
| `ctx.commands.register()` 的定义按 agent 分层：经 agent 作用域子 ctx 注册的定义为该 agent 独享 | `dsh-commands/lib/types/index.d.ts:72-77` |
| `GenerationOptions.sessionId` 与 `purpose` 是 DSH 给辅助模型调用打会话标签的方式（session-title / compaction 就是这么做的） | `dsh-llm` 的 `GenerateOptions` |
| token 投影只折**该会话日志里 provider 上报的用量** | `dsh-token-meter/lib/types/projection.d.ts:7` |
| 下游插件往会话日志追加自有事件**必须带 `ignorable` 标记**，否则读路径拒绝解析；**没有事件名注册 API**（原文：*"event-name registration was rejected because it does not classify omission safety"*） | `dsh-session/lib/types/known-event-types.d.ts` 全文 + `dsh-session/lib/index.js:270` |

### 2.3 参考实现的关键常量（`$H`）

| 常量 | 值 | 位置 |
|---|---|---|
| `skills.creation_nudge_interval`（代码默认，不在 DEFAULT_CONFIG） | **10** | `agent/agent_init.py:1307-1309` |
| `_REVIEW_MAX_ITERATIONS` | **16** | `agent/background_review.py:149` |
| `_REVIEW_MAX_INPUT_TOKENS_DEFAULT`（`max_input_tokens`） | **600000** | `agent/background_review.py:155` |
| digest `tail` / user 截断 / assistant 截断 | **24 / 300 / 200** | `agent/background_review.py:264-294` |
| `_BACKGROUND_REVIEW_CANCEL_TIMEOUT_SECONDS` | 2.0 | `agent/background_review.py:23` |
| `_IDLE_SETTLE_S` / `_POLL_INTERVAL_S` / `_MAX_AGE_DEFAULT_S` | 15 / 5 / 1800 | `agent/review_idle_queue.py:25-27` |
| name 正则（hermes） | `^[a-z0-9][a-z0-9._-]*$`，≤64 | `tools/skill_manager_tool.py:83-114` |
| `MAX_DESCRIPTION_LENGTH` / 创建时 `SKILL_PROMPT_DESC_LIMIT` | 1024 / 60 | `tools/skill_manager_tool.py:130-163` |
| `MAX_SKILL_CONTENT_CHARS` / `MAX_SKILL_FILE_BYTES` / `ALLOWED_SUBDIRS` | 100000 / 1048576 / {references, templates, scripts, assets} | `tools/skill_manager_tool.py:83-90` |
| 批量操作上限 | 20（`delete` 必须独占） | `tools/skill_manager_batch.py:14-15` |
| ledger 记录 | `{id, ts, actor, action, skill, evidence, before[], after[]}`；actor ∈ {curator, agent, user} | `tools/skill_ledger.py:37,254-258` |
| linter `_INCIDENT_REF_MIN` / `_INCIDENT_REF_PER_KCHAR` / `_MAX_REFERENCE_FILES` | 4 / 0.5 / 60 | `tools/skill_linter.py:46-51` |
| 遥测记录字段 | `created_by,use_count,view_count,last_used_at,last_viewed_at,patch_count,patch_generation,last_reused_patch_generation,last_patched_at,created_at,state,pinned,archived_at` | `tools/skill_usage.py:329-332` |
| 派生字段 | `latest_activity_at = max(last_used_at, last_viewed_at, last_patched_at)`（**排除 `created_at`**）；`activity_count = use+view+patch` | `tools/skill_usage.py:106-126` |

## 3. 架构

### 3.1 两个新行

```
host composition（cordis.patch.yml）        buddy preset（assets/preset/agent.cordis.yml）
──────────────────────────────────────      ──────────────────────────────────────────────
- id: buddy-skills                          - id: buddy-skills-agent
  name: 'dsh-buddy/skills'                    name: 'dsh-buddy/skills-agent'
  发布 ctx.buddySkills                        registers（全部落进 buddy 的 scope 层）：
  · 技能根目录 <home>/main/skills/               · SkillProvider（buddy 层，visibility: buddy）
  · 遥测/账本/用量 → storage domain "buddy"      · skill_manage 工具
  · review 编排（起 fork/spawn、数 step、         · session/event 监听（nudge 计数 + turn/end 触发）
    累加 token、16/60万 预算、记用量）            · tools/post-execute 监听（技能使用计数 + read 标记）
  · skill_manage 的实现与守卫                     · commands.refine
  · global 层 provider（只贡献 visibility:       · 上报"我已挂载"给宿主行
    global / project:<path> 的技能）
```

拆分理由（与仓库既有 persona / subagents / tokenMeter 的拆法同构）：

- **注册必须在 preset 层**：`registerProvider` / `tools.register` / `commands.register` / `ctx.on` 都落进**调用者 ctx 所属的层**。从 host 行注册 → global 层 → 每个会话都看得见，包括普通编码会话，这正是要禁止的。没有可靠的"从外面塞进别人层"的办法：`standingKeyFor()` 每次重建 mount 都 mint 新 key 对象，旧 key 下的注册会静默失联。
- **服务于 host 平面**：`ctx.buddySkills` 的读者在 preset 之外（typert 网关 / 面板；将来第 4 期的 scheduler、第 5 期的 board）。preset 内的 service 是 realm 私有的，外面解析不到。
- **配置与领域必须在 host**：settings 命名空间要在任何 buddy 会话出现之前就能被描述；同名 storage domain 一个进程只能开一次。

### 3.2 数据归属

| 平面 | 内容 |
|---|---|
| 文件 | `<home>/main/skills/<name>/SKILL.md` + `references/ templates/ scripts/ assets/`；内容寻址快照 `<home>/main/skills/.snapshots/blobs/<sha256>` |
| storage domain `buddy` | `skill_usage` 表（hermes `.usage.json` 字段逐个照抄）、`skill_ledger` 表、`review_usage` 表（§8.4）。**表名是存储单元名，受 `UNIT_NAME_RE`（`/^[a-z][a-z0-9_]*$/`）约束，必须 snake_case**——代码侧的 handle 字段与 TS 类型仍是 camelCase |
| settings `buddy`（扩展现有 schema） | `skills.enabled`、`skills.creationNudgeInterval`(10)、`skills.reviewProvider`/`skills.reviewModel`（空 = 跟随父模型）、`skills.maxInputTokens`(600000)、`skills.maxReviewSteps`(16)、`skills.writeApproval`(false)、`skills.ledger`(true) |

技能保持纯文件的理由（沿用第 1 期设计文档 §3）：`skill_manage` 自己做文件 I/O，因此技能可 grep、可 git、可手改、可备份。

## 4. 隔离契约（本期的硬要求）

三层叠加，全部是结构性的：

1. **注册层**：provider / `skill_manage` / 事件监听 / `refine` 命令全部由 **preset 行**注册 → 只进 buddy 层。普通编码会话合并不到这一层，工具目录里也没有 `skill_manage`。
2. **文件层**：技能写在 `<home>/main/skills/`，**不是任何默认扫描根**。宿主 composition 那个 global 层的 `skill-filesystem` 永远读不到它，因此普通编码会话（哪怕 cwd 就在 buddy workspace 下）也看不到。
3. **声明层**：frontmatter `visibility` 默认 `buddy`；`global` / `project: <path>` 的技能由**宿主行的 global 层 provider**贡献（`project:` 用 `SkillLookupOptions.cwd` 过滤）。`skill_manage` **拒绝**把 `visibility` 写成非 `buddy`。**Agent 无法自我提升作用域**，只有人能改。
4. **配套修改**：`buddyPersona/sessions` 必须过滤 `header.origin === 'subagent'`。已核实 review 子会话会继承 `agentPreset: 'buddy'`（`childSessionMeta` 从父的 live scope chain 取），而现有列表只按 preset + archived 过滤，不处理就会每次自动总结都多出一条幽灵对话。

## 5. preset 归属变更：从"用户文件"改为"插件生成物"

### 5.1 为什么必须改

现行不变量（`src/store/preset.ts` 文件头、`CLAUDE.md:58`、设计文档 §5/§9）是"目录已有内容就一字不写"。它的本意是**别毁掉用户手改的东西**，用"永不写入"来实现，只因为当时**无法判断有没有人改过**。

代价：插件**自己**的路线图走不下去。第 2 期要加 memory 行、第 4 期加 scheduler 行、第 5 期加 board 行——每一期都要往同一个文件加一行，每一次都撞上"永不写入"，且失败方式是**静默无效**（功能装了、什么都不发生、不报错）。本期就是第一次撞上。

同时，用户可编辑的面按仓库三平面铁律只有三处：settings（可调项）、文件（`SOUL.md` / `AGENTS.md` 这类人写的散文）、domain（派生态）。那份 preset 是唯一漏在铁律之外的文件。

### 5.2 新规则

`installPreset` 改名并改语义为 `syncPreset`：

```
目录不存在或为空              → 写入模板 + 写标记文件 .dsh-buddy-generated
目录存在且有标记（插件的产物）  → 模板内容不同就同步覆盖（升级路径自动打通）
目录存在但无标记              → 认作"用户自己的 buddy 预设" → 一字不动 + 面板提示 id 被占用
```

> **2026-09-14 订正：** 第一行原文只写了「目录不存在」。第 3a 期实现保留了旧版 `installPreset` 那句
> 「目录为空也算没写过」的判定（空目录里没有任何东西可丢），而第二行只覆盖「存在且有标记」，于是
> 「存在、为空、无标记」这一格在两行之间没有归属。更正为「不存在**或为空**」：空目录 → 写模板 +
> 标记，返回 `installed`。若把它判成 `kept`，一个被清空的目录会让插件永远装不上 preset，正是 §5.1
> 要消灭的那种静默无效。无标记**且非空**的目录仍然一字不动。

安全阀：

- **首次覆盖前**，若磁盘上那份内容与插件上次写出的不同（= 有人手改过），先写一份 `.bak` 并在面板提示"已备份"。
- 模板文件头改成生成物声明：这份接线文件由 dsh-buddy 生成、升级按插件版本重写；要改人格去 `SOUL.md`，要改规则去 `AGENTS.md`，要改开关用 Buddy 面板 / `settings.yaml`；**要自定义接线请用 GUI 的"复制预设"复制成新 id 再改**（harness 的 `agentPresets.copy` 是 Remote 暴露的既有能力）。
- 行挂载失败的可观测性：preset 行挂载时向宿主行上报"我在"；宿主行启动后 **10 秒**（内部常量，不进 settings，与 store 行那个 2 秒等待上限同类）仍未收到上报，就在面板显示"预设未同步"。这样"静默无效"这个失败模式被消除。

### 5.3 要一并改掉的既有产物

| 文件 | 改什么 |
|---|---|
| `src/store/preset.ts` | 文件头注释 + `installPreset` → `syncPreset`（标记 + 备份） |
| `CLAUDE.md:58` | 那条不变量按新语义重写 |
| `docs/superpowers/specs/2026-09-12-dsh-buddy-design.md` §5 / §9 | 同步 |
| `test/preset-install.test.ts` | 现在断言 "kept" 的用例按新语义重写（明确改，不是为了变绿偷改） |
| `assets/preset/agent.cordis.yml` | 文件头生成物声明 + 新增 `buddy-skills-agent` 行 |

## 6. 触发与调度（与 `$H` 一致，无自创）

| `$H` 行为 | 本期实现 |
|---|---|
| 每轮工具循环 `_iters_since_skill += 1` | 数 buddy 会话 `session/event` 的 `step/end`（一个 step = 一次模型调用，见 §2.2） |
| 调用 `skill_manage` 时清零 | 我们的工具 `execute` 被调用时清零（同会话） |
| `skills.creation_nudge_interval` = 10 | `buddy.skills.creationNudgeInterval` = 10 |
| 回合 finalize 后、有 final response、未中断 | post-commit `turn/end` 且 `reason.kind === 'completed'` |
| `_delegate_depth > 0` 跳过（子代理回合不自动 review） | `header.origin === 'subagent'` 或 `delegationDepth > 0` 跳过。这一条同时保证 review 不会套娃 |
| 同一 agent 已有 review 在跑 → 静默丢弃 | 宿主行按 session id 持锁；在跑就丢弃（**不排队、不重排**） |
| `/refine [focus]`，`explicit=True` | preset 行注册 `refine` 命令；`focus` 存在时走焦点后缀 |
| 触发点为何选 `turn/end` 而非 `agent/turn-stopping` | 后者在 boundary 提交**之前**，fork 的 seed 只到上一个已完成回合，会漏掉刚结束那一轮 |

**前台抢断：不做**（偏差，理由见 §11.3）。**空闲队列：不做**（偏差，见 §11.3）。

## 7. review 的输入、模型与预算

### 7.1 两条路径

- **同模型路径**（`reviewProvider`/`reviewModel` 为空或等于父模型）：`ctx.subagents.start('fork', {parent, prompt, signal})`，**不传 `agentOptions`**。fork 后端 seed = 父日志已完成回合前缀，继承完整上下文；同 provider/model 使继承的历史仍可用于 KV cache 复用（`assets/preset/agent.cordis.yml:204` 的既有依据）。等价于 `$H` 的 `routed=False` / cache-parity fork。
- **便宜模型路径**（配了且不同于父）：`ctx.subagents.start('spawn', {parent, prompt: digest + 提示词, agentOptions: {provider, model}, signal})`。**为什么不用 fork**：`CreateAgentOptions.seed` 的契约是"父日志的连续已完成回合前缀"，合成 digest 不是合法 seed；而 digest 路径在 `$H` 里本来就是"一段合成 user 消息 + 后 24 条原文"，用无 seed 的 `spawn` 承载语义完全一致。
- digest 算法逐个照抄 `$H:agent/background_review.py:264-294`：保留最后 **24** 条；若第 24 条是 tool result 就往下扩，使保留段不以 tool result 开头；更早的消息压成**一条**合成 user 消息，前缀文本照抄，逐条 `USER: {text[:300]}`、assistant 有工具调用时 `ASSISTANT[tools: n1, n2]`、有正文时 `ASSISTANT: {text[:200]}`，换行换成空格，**tool result 全部丢弃**。原料来自 `ctx.sessionQuery.readSurface(sessionId)`。

### 7.2 提示词与产出

- skill-only 分支照抄 `$H` 的 `_SKILL_REVIEW_PROMPT`（`$H:agent/background_review.py:368-452`）+ `_LESSON_LAYER_BLOCK`（`:313-340`）+ `_DO_NOT_CAPTURE_BLOCK`（`:343-366`）：偏好顺序（先更新当前已加载的技能、再更新既有 umbrella、再加 `references/` 等支撑文件、最后才新建 CLASS-LEVEL umbrella）、read-before-write 契约、受保护清单、"只更新受保护技能时就说 Nothing to save."。
- 末尾追加句照抄其形状：`You can only call skill management tools. Other tools will be denied at runtime — do not attempt them.`
- `/refine <focus>` 后缀照抄 `$H:1196-1200`。
- **产出无 schema**：自由文本或工具调用，`Nothing to save.` 是合法终态。`$H` 没有 outputSchema，我们**也不用**（DSH 的 `outputSchema` 能力在此刻意不用）。

### 7.3 工具白名单

`toolFilter: {allow: ['skill', 'skill_manage', 'read', 'grep', 'glob']}`。

- `$H` 的对应物是 `$H:background_review.py:957-997` 的 dispatch 侧白名单（`skills_list/skill_view/skill_manage` + `read_file/search_files` + 可配 `extra_tools`）。
- **偏差**：DSH 的 `toolFilter` 效果是"既不可见也拒绝执行"（单一可见性），比 `$H` 的"可见但 dispatch 拒绝"更严。这是平台唯一的限制手段，也是我们想要的效果：review 子会话的工具目录里根本没有 write/edit/bash。
- DSH 没有 `skills_list` 工具（目录是 context 消息，见 §1），故白名单以 `skill` 加载器替代 `skill_view`/`skills_list`。

### 7.4 预算执行（两项都按 `$H` 原意，靠观察子会话实现）

- **16 轮**：数 review 子会话的 `step/end`；到 `maxReviewSteps`（16）→ 停。**不是**数工具调用。重试是另一个事件（`assistant/attempt`），不计数。
- **60 万输入 token**：累加 review 子会话每条 `assistant/message` 的 `usage.inputTokens`；到 `maxInputTokens`（600000）→ 停。这正是 `$H` 的 `session_input_tokens` 语义（累计输入，回合间检查）。
- **停的手段**：`ctx.subagents.interrupt(childSessionId, {kind:'ancestor', agent: parentAgent})`，在一步结束之后停（不在工具执行中间打断），避免留下半个批量写入。
- **cache 实证**：同时记录 `cacheReadTokens`。`$H` 自己的完成日志就是 `"Background review complete: thread=bg-review calls=%d in=%d out=%d cache_read=%d result=%s"`（`$H:background_review.py:753-760`），我们照抄这个形状，好让"同模型 fork 确实吃到缓存"是可验证的事实而不是保证。
- **不做**起飞前的体积降级：60 万是累计预算，不是"transcript 多大"的门槛；同模型 fork 能吃 cache，没有理由因为长就降级（这是我先前版本的错误，已废弃）。

## 8. 写路径

### 8.1 工具

新工具 `skill_manage`（名字不与 DSH 既有的 `skill` 加载器冲突），动作集与 `$H` 一致：`create | patch | edit | delete | write_file | remove_file`。

**`adopt` 不是模型工具动作**（§8.5）：`$H` 里它是人的命令（`hermes curator adopt`），只作为面板动作暴露。让模型自己 adopt 会绕过"只有人能扩大管辖范围 / 提升可见性"的原则。

- 一次调用携带一个 `operations` 数组（**上限 20**，`delete` 必须独占一次），**原子应用**：任一操作失败整体回滚。
- 校验照抄 `$H:tools/skill_manager_tool.py:83-163`：frontmatter 必须以 `---` 开头并有闭合栅栏、必须是 YAML 映射、必须有 `name` 与 `description`、`description ≤ 1024`（**创建时 ≤ 60**）、正文非空且 `≤ 100000` 字符、支撑文件 `≤ 1048576` 字节且只能落在 `{references, templates, scripts, assets}`。
- **名字语法用 DSH 的**（偏差，平台强制）：`^[a-z0-9]+(?:-[a-z0-9]+)*$`（`$DSH/dsh-skill/lib/index.js:17`）。hermes 的 `^[a-z0-9][a-z0-9._-]*$` 允许 `_` 与 `.`，DSH 注册表在候选名校验时会直接 throw，必须服从。

### 8.2 建议性 linter（照 `$H` 移植，14 条，全部 advisory，绝不阻断）

结构照抄：创建后跑一次，把 `lint_warnings` / `lint_hint` 附在工具返回值上（`$H:tools/skill_manager_tool.py:371-384`）。

规则与阈值照抄 `$H:tools/skill_linter.py`：

| 规则 | 检查 | 级别 |
|---|---|---|
| `name-format` | 名字语法 | error |
| `name-dir-mismatch` | frontmatter name 必须等于目录名 | error |
| `description-length` | > 60 | warn |
| `description-marketing` | 含 powerful / comprehensive / seamless / advanced / cutting-edge / state-of-the-art / revolutionary / robust | warn |
| `missing-section` | 无 `## When to Use` 标题 | warn |
| `incident-log-shape` | 正文（剥代码块）PR/issue 引用 ≥ 4 且 ≥ 0.5/千字符 | warn |
| `dangling-reference` | 正文引用的 `references/ templates/ assets/` 文件不存在 | warn |
| `platforms-value` | `platforms:` 取值不在 `{linux, macos, windows, darwin}` | warn |
| `platforms-gating` | `scripts/` 用 POSIX-only 原语（fcntl / termios / os.setsid / osascript / /proc/ / apt-get / systemctl）却未声明 `platforms:` | warn |
| `forbidden-file` | 带 README.md / CHANGELOG.md / install.sh / .env / .env.example / .gitignore | warn |
| `references-sprawl` | `references/` 下非 `_` 开头 .md 超过 60 个 | warn |

三处按 Buddy 实情改写（规则本身不动）：

1. `shell-utility-reference`：工具名映射换成 DSH 的——`grep → grep`、`cat/head/tail → read`、`sed/awk → edit`、`find/ls → glob`（`$H` 那套是它的 `search_files`/`read_file`/`patch`）。
2. `author-caps`（要求 `author: Hermes Agent`）：**删除**，Buddy 没有对应约定，留着只会产生无意义告警。
3. `missing-metadata`：`metadata.hermes.{tags,related_skills}` 换成 Buddy 自己的 frontmatter 约定（`visibility` 字段，§4）。`version` / `author` / `license` 那半保留。

合计 14 条规则来源，其中 `author-caps` 删除，**实际实现 13 条**。

### 8.3 快照、账本与回滚

**必须区分两种快照，语义相反**（这是我先前版本的错误，已核实订正）：

1. **原子性快照**（改/删已有技能）：写前 `copytree` 整个技能目录，**失败即中止**——`$H:tools/skill_manager_batch.py:60-75` 的注释原文是 *"no snapshot, no atomicity"*，失败返回 `"Could not snapshot 'X' for atomic batch: …"`。新建技能无可快照（回滚靠删掉半成品）。
2. **审计账本**（`capture_before` + blob）：**尽力而为，失败只 warning，写入继续**——`$H:tools/skill_ledger.py:8` 原文 *"TELEMETRY, NOT A GATE: every public write path swallows and logs — except `rollback_entry`, which FAILS CLOSED"*。这条与**第 1 期设计文档**（`2026-09-12-dsh-buddy-design.md`）§9 那句"快照失败 → 拒绝写入"不冲突：那句由上面第 1 条（原子性快照）满足。

（用户已就此处定调：审计账本快照失败**不阻断**写入，与 `$H` 一致。）

账本记录照抄：`{id, ts, actor, action, skill, evidence, before[], after[]}`，`before/after` 是 `[{path, sha256}]`，内容寻址 blob 去重存放；actor ∈ `{curator, agent, user}`，`agent` 专指 review 子会话的写入。

**单条回滚**（照抄 `$H:tools/skill_ledger.py:338-402`）：

1. 取条目；**校验所有 before/after 路径都在 buddy home 之内**（防止手改账本变成任意写）。
2. delete/archive 类先用最近一次全量快照补齐 `before`（否则恢复出来是空壳）。
3. **fail-closed 预检**：每个 `before[].sha256` 的 blob 必须都在，否则中止且不做任何改动。
4. 先写一条 `pre-rollback` 安全条目（记录当前状态）；写不出来就中止。
5. 恢复 `before` 的每个文件，删除只在 `after` 里的文件。
6. 再记一条 `rollback` 条目。

**已知缺口照实标明**：账本回滚能救回**文件**，但救不回被删技能的**遥测记录**（`$H` 的 manifest 只以技能目录为根；`.usage.json` 不在其中）。

### 8.4 管辖权（只有后台总结产出的技能才归自动管）

- `created_by` 记在**遥测记录**里（`$H` 同样放 sidecar，不放 frontmatter）。
- **只有 review 子会话创建的**记 `agent`：宿主行持有自己起过的 review 子会话 id 集合（`SubagentRun.id` = 子会话 id），工具据此**声明式**判定，不靠推断。**偏差**：`$H` 用进程内 ContextVar（`skill_write_origin` / `is_background_review()`），DSH 的 review 是真正的独立会话，无法往别人的回合里塞 ContextVar；两者都是声明式判定，语义相同。
- 前台（你在聊天里让 Buddy 建的）记 `None`。
- 自动改写守卫照抄 `$H:tools/skill_manager_guards.py:164-215`：拒绝 **pinned** / 非托管（`created_by` 不是 `agent`）/ 受保护对象，拒绝文案照抄其形状（提示用 `adopt` 把这个技能交给自动管理）。`$H` 里的 external / hub / bundled / 受保护内置四类在 Buddy 场景不存在，不实现。
- **read-before-write**（照抄 `$H:tools/skill_manager_guards.py:220-230`，**只在后台 review 下生效**）：要 patch 某个技能，这个 review 必须先读过它。读标记由 preset 行的 `tools/post-execute` 监听器在观察到 `skill` 工具调用时写入，按 review 子会话隔离——与 `$H` 的"每次 review 重置一份读集合"同构。

### 8.5 adopt

`adopt` 把 `created_by=None` 的技能交给自动管理，语义照抄 `$H:tools/skill_usage.py:302-325`：已经是托管的则原样返回成功；**不重置不活跃时钟**。这既是工具动作，也是面板动作（§9.3）。

### 8.6 写入审批（可选）

`skills.writeApproval: true` 时**无论谁写**都只暂存不落盘，写到待批目录，返回 `{success, staged, pending_id, gist, message}` 形状；默认 `false`（`$H` 默认也是 false，`$H:config_defaults.py:1354`）。

## 9. 遥测与面板

### 9.1 字段与写入点

字段名逐个照抄（§2.3），存在 storage domain 的 `skill_usage` 表。**有意偏差**：`$H` 放 `.usage.json` 文件，我们按仓库三平面铁律放 domain（派生态）。**后果要记住**：`$H` 的整树 tar.gz 快照**包含** `.usage.json`，整树回滚能恢复遥测；我们的领域表不在文件快照里，所以 3b 做整树快照时**必须显式把领域表一起快照**，否则会出现"文件回去了、账目没回去"。

写入点（照抄 `$H` 的时机）：

| 字段 | 何时写 |
|---|---|
| `created_by` | 创建时；create 会**重置整条记录**（`$H` 的 `record_created` 语义） |
| `use_count` / `last_used_at` | 技能被加载时（模型调 `skill` 工具）；DSH 本部署里这是**唯一确定存在**的"使用"路径（我把整个安装树 grep 过，`skill-invocation` 只有类型声明、没有装载的发射方；cron 注入等第 4 期） |
| `view_count` / `last_viewed_at` | 同上，一次加载记一次（`$H` 只在 `skill_view` 处写这一对） |
| `patch_count` / `last_patched_at` / `patch_generation` | 仅 `patch/edit/write_file/remove_file` 成功时；**create 不写** |
| `last_reused_patch_generation` | 在 patch 世代推进之后的一次使用 |
| `state` / `archived_at` | 3b 的剪枝与归档（本期只建字段） |
| `pinned` | 面板 pin/unpin（3a 提供动作） |

派生字段（算出来，不落库，**3b 的剪枝靠它**）：`latest_activity_at = max(last_used_at, last_viewed_at, last_patched_at)`（**排除 `created_at`**）、`activity_count = use+view+patch`。

**观测手段**：preset 行的 `tools/post-execute` 监听器（`Scoped<ToolRuntime>`，只收 buddy 会话）观察 `exec.name === 'skill'`，读 `exec.arguments` 拿技能名、`exec.agent` 拿会话——DSH 的技能加载器是 shipped 的 `dsh-tool-skill`，我们改不了它，只能观察。

### 9.2 review 用量归属（照 hermes 的机制，不改父会话日志）

每次 review 跑完，把用量写进领域的 `review_usage` 表：父会话 id、子会话 id、provider、model、step 数、`inputTokens`、`outputTokens`、`cacheReadTokens`、`cacheWriteTokens`、结果、时间。

- `$H` 的对应机制就是**它自己的旁表**（SQLite 的 `session_model_usage`，`record_auxiliary_usage(session_id, task="background_review")`），**不动 transcript**（fork 的 `_session_db = None`）。
- **明确偏差（可见性）**：DSH 的 stock token 投影只折**会话自己日志里 provider 上报的用量**（§2.2），所以 **DSH 原生会话页的成本视图不会包含这笔**。要进那个视图只能伪造模型消息，**不做**。可见位置是：Buddy 面板上每条对话的"自我改进花费" + `review_usage` 表。
- **`sessionTelemetry` 不是可用路径**（已核实，订正先前说法）：它是 **backend 契约**（`SessionTelemetryBackend`），`emit()` **由 coordinator 调用、不是插件接口**；coordinator 的采集只有三条路——会话 firehose（每个规范事件一条 ledger 记录）、`agent/error` 转发的 `agent-error` ops 记录、按需 `captureSession()` 重放规范日志（`dsh-session-telemetry/lib/types/coordinator.d.ts:29-100`）。**没有"插件自报一条 ops 记录"的 API**。即便有，它也是**出站遥测**（给分析后端用）而不是本地成本视图，并且受 `sharing: SessionTelemetrySharingStatus` 约束——分享关掉就发进空气。
- 备选（已评估并否决）：往父会话日志追加一条自有事件。DSH 允许，但**必须带 `ignorable` 标记**且没有事件名注册 API（§2.2），而 `$H` 自己也没动 transcript——用更重、更险的机制换不到任何东西，故不采用。
- **两条实现约束**：(1) **review 跑完时父会话可能已经结束或被销毁**，所以记录写领域表（不依赖活会话）——这也是不选日志路径的第二个理由；(2) **归属必须放在 `finally` 里**：`$H` 专门保证"一个烧了 token 然后才抛异常的 fork 也要归属"（其 issue #87250），取消与失败路径同样要记。

### 9.3 面板 Skills 模块

放在 Buddy 主面板（§3.1 的 client 半边），功能对齐 `$H` 的 CLI 与 web 端点：

| 功能 | `$H` 对应 |
|---|---|
| 列技能：名字 / 描述 / 状态 / 使用次数 / 最后使用 / 是否 pinned / 是否归自动管 | `hermes curator list`、`list-unmanaged` |
| pin / unpin | `hermes curator pin` |
| 看账本（`skill_ledger`） | `hermes curator ledger` |
| 一键回滚到某条 | `hermes curator rollback <entry-id>` |
| adopt（把自己写的技能交给自动管理） | `hermes curator adopt` |
| 提升可见性 buddy → project → global（**仅人能点**） | 本仓库设计文档 §7.1 的既有决定（`$H` 无对应物） |
| review 总开关 | `$H` 的 `auxiliary.background_review.enabled` |

curator 的 **pause / run-now** 属于 3b（`$H` 有 `PUT /api/curator/paused`、`POST /api/curator/run`、`GET /api/curator`）。

## 10. 失败处理

| 情况 | 处理（对齐 `$H`） |
|---|---|
| review 线程/子会话里任何异常 | 一个宽 `except`：日志 warning 一次 + **给用户一条可见告警**（`$H` 的 `_emit_auxiliary_failure` → `⚠ Auxiliary background review failed: …`） |
| review 失败 | **review 这一层不重试**（下一次 nudge 就是下一次尝试）；它**内部**那次模型调用仍走普通循环的重试与 fallback（`$H` 的 `agent.api_max_retries` 默认 3） |
| 起子会话失败 | 清理未完成的运行并记录；**不静默**（`$H` 的自动路径用 `with suppress(Exception)` 吞掉，这是它的静默点，我们不照抄——列为偏差） |
| 账本 / 遥测写失败 | 只记日志，**永不阻断写入** |
| 原子性快照失败 | **中止这次写**（§8.3 第 1 条） |
| 批量中某操作失败 | 整体回滚，把失败位置回给模型（`$H` 的 `failed_index` / `completed_before_failure`） |
| 同一会话已有 review 在跑 | 丢弃，不排队 |
| 预算耗尽 | 到 16 step 或 60 万输入 token 就停（§7.4） |
| summary 计算抛异常 | 压成空值，保证**部分动作不丢**（`$H` 的做法） |

## 11. 与 `$H` 的偏差清单（全部有意，逐条给理由）

### 11.1 平台强制

| # | 偏差 | 理由 |
|---|---|---|
| 1 | 技能名语法用 DSH 的 kebab-case | DSH 注册表校验会 throw（§8.1） |
| 2 | 工具白名单是"不可见 + 拒绝"，`$H` 是"可见 + dispatch 拒绝" | `toolFilter` 是 DSH 唯一的限制手段（§7.3） |
| 3 | 用 `skill` 加载器替代 `skills_list`/`skill_view` | DSH 的技能目录是 context 消息，不是工具（§1） |
| 4 | `created_by` 判定用"宿主行记录的 review 子会话 id"，`$H` 用 ContextVar | DSH 的 review 是真正的独立会话（§8.4） |
| 5 | 遥测放 storage domain，`$H` 放 `.usage.json` 文件 | 仓库三平面铁律；后果见 §9.1。另外 review 用量只在 Buddy 面板可见，**DSH 原生会话页看不到**（§9.2） |

### 11.2 实现手段不同、语义相同

| # | 偏差 | 说明 |
|---|---|---|
| 6 | 16 轮 / 60 万 token 由**观察子会话事件**执行，`$H` 由它自己的循环变量执行 | 数字与语义照抄（§7.4） |
| 7 | digest 路径用 `spawn`（无 seed）+ 文本 digest，`$H` 用同一个 fork 传 `conversation_history` | DSH 的 `seed` 契约不接受合成历史（§7.1） |
| 8 | review 是**持久化**的独立子会话，`$H` 的 fork 明确不落库 | DSH 的 `agents.create` 是唯一会持久化的创建路径。**待实测**：fork 的 seed 等于父日志前缀，所以每条 review 子会话会复制一份当时的对话历史，长对话反复 review 的存储增长需要实测；若显著，把自动路径改走 `spawn` + digest（`$H` 在便宜模型路径上本来就是这么做的） |

### 11.3 功能取舍（用户已定）

| # | 偏差 | 理由 |
|---|---|---|
| 9 | **不做** defer 空闲队列（15s 静默 / 1800s 上限 / 每会话一槽 / 重排 ≤3） | `$H` 只在"目标受管本地端点"时入队，而它的判定要求该端点是 `$H` 自己守护进程拉起的服务器（读 supervisor 状态文件）。本部署的模型路由是远程代理（`cliproxyapi` → `http://127.0.0.1:8317`），`$H` 在此同样会直接跑。用户明确不跑本地模型 → 不为不存在的场景写代码。常量已记在 §2.3，将来真要自建本地服务器时按原样补 |
| 10 | **不做**前台抢断在跑的 review | `$H` **无条件**在 `run_conversation` 开头取消同会话的在跑 review（`agent/turn_facade.py:35-37`），其 docstring 写明的动机是 *"A review shares this session_id for cache parity: fence review startup or interrupt an admitted request and await its exit before opening live-turn instrumentation"* —— 即"review 与前台**共用同一个 session_id**"带来的记账/仪表冲突，**不是 GPU**。DSH 的 review 是独立会话，这个前提不存在。**这是偏差，理由如此，不是"hermes 只在本地时这么做"** |
| 11 | **不做**前台抢断后的重排（≤3 次） | 它是 defer 门控的（`$H:run_agent.py:809-830` 注释 *"Only for automatic reviews on the managed local runtime"*），随 #9 一起去掉 |
| 12 | 用户可见告警（§10） | `$H` 有；我们照抄。反过来，起子会话失败**不静默**，比 `$H` 严格 |

### 11.4 无对应物（标 N/A）

| `$H` 行为 | 处理 |
|---|---|
| `_parent_can_emit_tool_calls` 为假则跳过 | N/A：DSH 天然假定模型能调工具 |
| 记忆半边（`_MEMORY_REVIEW_PROMPT` / combined） | 等第 2 期 |
| `extra_tools` 配置 | 不实现（白名单固定；用户可后续要求） |
| hub / bundled / external_dirs / 受保护内置豁免 | N/A：Buddy 场景不存在这些类别 |
| cron 引用豁免 | 等第 4 期 |
| `skills.guard_agent_created` 安全扫描（`$H` 默认 false） | 不实现（默认关闭的可选闸，等有证据再说） |

## 12. 预留插槽（第 3b 期）

只记接口与常量，不出实施计划：

- **确定性剪枝**照抄 `$H:agent/curator.py`：`stale_after_days=30`、`archive_after_days=90`、`interval_hours=168`、`min_idle_hours=2`、首轮延后一整个 interval、永不删除（归档到 `<home>/main/skills/.archive/`）、豁免 pinned 与 cron 引用、`use_count == 0` 的宽限 floor；"未使用"用**时间戳** `latest_activity_at`，`use_count` 只参与宽限。
- **状态**：`last_run_at / last_run_duration_seconds / last_run_summary / last_report_path / paused / run_count`。
- **整树快照**：按 `$H` 的 tar.gz + 保留 5 份 + 覆盖前备份；**必须把 domain 表一起快照**（§9.1 的后果）。
- **报告**：`<home>/logs/skills/<ts>/{run.json,REPORT.md}`，含 `--dry-run`。
- **LLM 整合 pass**：默认关闭（`$H` 的 `consolidate=False`，一次 sweep 50–100 次调用）。
- **面板**：pause / run-now。

## 13. 测试与验收

### 13.1 测试落点

| 测试 | 守什么 |
|---|---|
| `test/skills.test.ts` | 校验（名字/frontmatter/大小）、原子批量回滚、账本字段与 blob、单条回滚的 fail-closed 与安全条目、管辖权（`created_by` 与守卫）、pinned 拒绝、adopt |
| `test/skills-linter.test.ts` | 14 条规则各一例 + "警告不阻断" |
| `test/skills-isolation.test.ts` | 按层隔离：buddy 层注册的 provider 在**非 buddy** scope 下取不到；`skill_manage` 不在非 buddy 的工具目录里 |
| `test/skills-review.test.ts` | nudge 计数与清零、触发条件（`completed` / 子会话跳过 / 单飞丢弃）、digest 精确算法（tail 扩展、截断长度、tool result 丢弃）、16 与 60 万预算的停止、用量写入父会话记录 |
| `test/preset-sync.test.ts` | 生成物语义：无标记不动、有标记同步、覆盖前备份、标记写入 |
| `test/persona.test.ts`（既有） | 追加：`listSessions` 过滤 `origin:'subagent'` |

### 13.2 真机验收（隔离 probe profile）

1. 聊 10 步以上 → 回合结束后自动出现 review 子会话 → `<home>/main/skills/` 下出现技能文件。
2. **隔离**：同一个技能在**普通编码会话的技能列表里不出现**；编码会话的工具列表里**没有** `skill_manage`。
3. review 子会话**不出现在 Buddy 会话列表**（幽灵过滤）。
4. review 的 step 到 16 停、输入 token 到 60 万停，两个数字与 `cache_read` 都进日志。
5. **cache 实证**：`cacheReadTokens` > 0，证明同模型 fork 吃到前缀缓存。
6. 建一个技能 → 改它 → 从面板回滚 → 文件回到改动前。
7. 前台建的技能（`created_by=None`）在 review 里被拒绝改写并提示 adopt；pinned 的同样被拒。
8. 改 `created_by` 的手检：`skill_usage` 表里前台创建与 review 创建可区分。
9. 验完 `find ~/.dsh -newermt '<probe start>'` 为空。

## 14. 交付物清单

| 交付物 | 位置 |
|---|---|
| host 行 | `src/skills/`（新增）+ `cordis.patch.yml` + `build.mjs` + `package.json` exports |
| preset 行 | `src/skills-agent/`（新增，导出 `./skills-agent`）+ `assets/preset/agent.cordis.yml` |
| 生成物语义 | `src/store/preset.ts`（`syncPreset` + 标记 + 备份） |
| settings | `src/config.ts` 新增 `skills` 段 |
| 领域 | `src/store/domain.ts` 新增 `skill_usage` / `skill_ledger` / `review_usage` 三张表 |
| 幽灵过滤 | `src/persona/index.ts` 的 `listSessions` |
| 面板 | `src/client/` 新增 Skills 模块 + 可见性开关 |
| 文档 | 本文件；`CLAUDE.md:58`；设计文档 §5/§9 |
