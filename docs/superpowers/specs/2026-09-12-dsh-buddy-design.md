# dsh-buddy 设计方案

- 日期：2026-09-12
- 状态：已通过设计评审，待实施计划
- 范围：终局架构 + 第一期（窥探切片）详设

## 1. 目标

把 DeepSeek Harness 变成一个常驻的个人助理，具备：

- **记忆系统** —— 跨会话记住你和你的偏好
- **人格系统** —— 稳定的声音与态度
- **自动进化** —— 自己积累、整理、淘汰技能
- **远程聊天** —— 首个目标 Telegram
- **专属主界面** —— 左栏按钮接管中央面板，承载对话列表、定时任务、看板

参考产品是 [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) 与
[openclaw/openclaw](https://github.com/openclaw/openclaw)：吸收二者收敛一致的设计，剔除各自的臃肿部分。
调研记录见 `docs/research/hermes-agent-research.md`。

### 1.1 非目标

- 不做多聊天通道（只 Telegram）
- 不做技能市场
- 不做叙事装饰（梦境日记、星图、宠物、玩具人格库）
- 不做看板卡片自动派发给 subagent 执行
- 第一期不做记忆、进化、调度、看板、Telegram —— 只留架构插槽

## 2. 事实基础

以下每一条都对着本机 shipped source 核过，不是推测。DSH 安装位置
`/home/panda-nuc/.npm-global/lib/node_modules/@deepseek-ai/dsh/`（下称 `$DSH`）。

| 事实 | 证据 |
|---|---|
| `sidebar.panellist` 是 root-scoped list slot，"Global panel icons"，list id 即对应 main panel key | `$DSH/node_modules/@deepseek-ai/dsh-client-ui-sidebar/lib/types/client/contract/slots.d.ts:39` |
| 左栏渲染顺序为 `panellist → workspaces → settings → footer.action` | `dsh-client-ui-sidebar/lib/client.js:387-399` |
| `main` 是 root-scoped keyed slot，keyDomain 开放，已占用 `conversation` | client Slots inspect provider |
| `ctx.layout.selectPanel(id)` 选中未注册的 key 会抛错并保持原选中 | `dsh-client-ui-layout/lib/types/client/service.d.ts:30` |
| client 侧有 `ctx.sessions.open(id)` | client Service inspect provider |
| `ctx.skills` 注册表**按 scope 分层**；`SkillViewOptions.scope` 选层 | `dsh-skill/lib/types/index.d.ts:100-103` |
| `SkillLookupOptions.cwd` 用于选择 workspace-sensitive 技能 | `dsh-skill/lib/types/index.d.ts:176` |
| `ctx.agentPresets.standingKeyFor(id)` 返回一个 preset 的 `ScopeKey` | host Service inspect provider |
| `ScopeKey` 是不透明对象，带 parent 链 | `dsh-scope/lib/types/index.d.ts` |
| `ctx.systemPrompt.section({name, order, text})`，`text` 可为 `(ctx) => string` | `dsh-system-prompt/lib/types/index.d.ts:47-68` |
| **人格行必须是 scope-only**：`dsh-system-prompt` 无条件注册 deployment persona，一个全局挂载的人格行会与它**冲突并响亮失败**；挂在 agent preset 里才会 shadow 掉它 | `$DSH/node_modules/@deepseek-ai/dsh-persona/lib/index.js:4-16` |
| 官方 `@deepseek-ai/dsh-persona` 的 `prefix`/`suffix` 只接受**静态字符串**（`z.string()`） | `dsh-persona/lib/index.js:23-28` |
| **但静态字符串不等于静态取值**：prompt 变量的 provider 在**每次 `assemble()` 都被重新调用**，所以 `prefix: '{{buddySoul}}'` 是动态的，改文件无需重载 | `dsh-system-prompt/lib/index.js:308-314` |
| 渲染器**不会二次扫描被替换进去的值**，`{{` 若无配对 `}}` 按字面散文处理 | `dsh-system-prompt/lib/index.js:106-107, 171-172` |
| 同名 prompt 变量重复注册会抛错；错误信息提示按 agent 作用域注册可得每-agent 取值 | `dsh-system-prompt/lib/index.js:190` |
| agent preset = 一个目录，含 `agent.cordis.yml`（行列表）+ `preset.yml`（`name`/`description`/`order`）；用户 preset 根目录为 `<dshHome>/.agent-presets/` | `dsh-agent-presets/lib/index.js:182,195`；`presets/minimal/` |
| `ctx.sessionQuery` 提供 `searchSessions` / `searchEvents` / `readSession` | host Service inspect provider |
| **DSH 没有 cron/scheduler 服务** | host Service 全表 70 项，无对应条目 |
| `@deepseek-ai/dsh-home-paths` 提供 `dshHomePath(...segments)` 与 `expandHomePath(path)`；home 解析优先级为「显式配置 > `$DSH_HOME` > `~/.dsh`」 | `$DSH/node_modules/@deepseek-ai/dsh-home-paths/lib/types/index.d.ts` |

以及本地已有资产：`~/repo/dsh-plugins/dsh-telegram`（6,501 行，可运行），其 `AGENTS.md`
记录的三条真机踩坑（credentials 平面、`#` 私有字段穿不过 cordis proxy、软依赖必须
`ctx.get`）本方案全部继承。

## 3. 数据归属：三平面 + 文件

本设计最重要的结构决策。两个参考产品独立收敛到同一答案：**人/Agent 写的内容放纯文件，
机器派生的状态放数据库**。这同时满足 dsh-telegram 已验证的 DSH 三平面铁律。

| 平面 | 内容 | 位置 |
|---|---|---|
| credentials | Telegram bot token 等密钥 | `ctx.credentials`；只有 `describe()` 的结果（configured/source/writable）可以出现在配置、日志、浏览器里 |
| settings | 非密可调项：buddy home 路径、各能力开关、面板 order | `ctx.settings.register('buddy', schema)` |
| 文件 | `SOUL.md`（声音）、`AGENTS.md`（规则）、`MEMORY.md`、`USER.md`、`skills/` | buddy home，默认 `dshHomePath('buddy')`；可由 settings 覆盖，覆盖值过 `expandHomePath()` 以支持 `~` |
| storage domain | 派生态：会话↔人格绑定、记忆索引与 provenance 列、定时任务、看板卡、轮询游标、技能快照 ledger | `ctx.storageDomain`，domain 名 `buddy` |

**人格与记忆必须是文件的理由**：后期自动进化要让 Agent 用普通 `read`/`edit` 工具修改自己的
人格与记忆。存进数据库就必须为它造一套专用工具，且不可 grep、不可 git、不可手改、不可备份。

`SOUL.md`（声音、态度、观点）与 `AGENTS.md`（操作规则）分开，是两个参考产品的共同做法。

## 4. 终局架构

单仓库 / 多 cordis row / 一个 bundle。每个能力是自己的 plugin row，由同一份
`cordis.patch.yml` 一次插入。用户改一行 `disabled: true` 即可关掉某能力，无需改代码
（DSH 红线：不得硬编码可调参数）。

### 4.1 Host composition 行

| row | 职责 | 发布 |
|---|---|---|
| `buddy-store` | 打开 domain `buddy`；用 `dshHomePath('buddy')`（或 settings 覆盖值经 `expandHomePath`）解析 buddy home 并保证目录存在 | `ctx.buddyStore` |
| `buddy-persona` | 读写 `SOUL.md` / `AGENTS.md`，暴露 typert 端点给设置页。**不注册任何 prompt section** | `ctx.buddyPersona` |
| `buddy-memory` | tier1 策略层（预算、provenance、冻结快照）；tier2 直接打 `ctx.sessionQuery` | `ctx.buddyMemory` |
| `buddy-skills` | `ctx.skills.registerProvider()`；curation 与快照 ledger | `ctx.buddySkills` |
| `buddy-scheduler` | 全新基础设施：任务存储、tick 循环、preflight | `ctx.buddyScheduler` |
| `buddy-board` | 看板卡片存储与端点 | `ctx.buddyBoard` |
| `buddy-telegram` | 吸收现有 dsh-telegram | — |

### 4.2 Client 行

`buddy-panel`：注册 `sidebar.panellist` 按钮、`main` 面板、`settings.section` 标签页。

### 4.3 Agent preset `buddy`

挂人格注入与 buddy 专属工具。**人格只作用于 buddy 会话**，不污染既有编码会话。

这不是风格选择而是**硬约束**：`dsh-system-prompt` 无条件注册 deployment persona，一个全局挂载的
人格行会与它冲突并在启动时响亮失败。官方 `@deepseek-ai/dsh-persona` 的模块文档原话是
"mounted globally it collides with the registry's own registration and fails loud"，以及
"an agent preset cannot mount the prompt registry itself, so without a row of its own a preset
could change an agent's tools but never its identity"。

因此人格能力**拆成两半，但只写一行代码**：

| 半边 | 平面 | 职责 |
|---|---|---|
| `buddy-persona`（我们写） | host composition | `SOUL.md` / `AGENTS.md` 文件读写 + 设置页 typert 端点；发布 `ctx.buddyPersona`；注册 prompt **变量** `buddySoul`。**不注册任何 prompt section** |
| `@deepseek-ai/dsh-persona`（官方现成） | 仅 `buddy` preset | preset 里一行 `prefix: '{{buddySoul}}'` |

**为什么不自写 preset-only 行**（评审中一度提出，核实源码后否决）：否决理由曾是「`prefix` 是静态
字符串，改了 `SOUL.md` 必须重载才生效」。这个结论不成立——变量 provider 在**每次 `assemble()` 都会
被重新调用**（`dsh-system-prompt/lib/index.js:308-314`），所以 `'{{buddySoul}}'` 这个静态字符串
承载的是动态取值，保存即生效。既然官方行已经满足需求，自写行只会多出一个子路径导出、一套测试，
并且要自行重现 dsh-persona 规避 deployment persona 冲突的那套处理。

**变量而非 section，是一道结构性隔离**：变量在被引用前完全惰性。人格只出现在 buddy preset 的
那一行 `{{buddySoul}}` 里，所以它**在结构上**到不了普通编码会话——这比「注册时挑对 scope」更难写错。

**为什么人格文本可以放心含 `{{`**：渲染器不会二次扫描被替换进去的值
（`dsh-system-prompt/lib/index.js:106-107, 171-172`）。这对一个**将来由 Agent 自己编辑**的文件是硬要求。

**`suffix` 暂不使用**：`AGENTS.md` 的规则拼在 `prefix` 里（人格之后、加一个小标题），不走
`suffix`。官方文档写明 `suffix` 省略或为空会「shadow the deployment suffix away」——若用户没写规则，
就会静默删掉官方的 first-party guidance。语义上 `suffix`（渲染在工具指引之后）确实更适合放规则，
这个改进留给后续期，届时需要一个「空规则时回落占位文本」的方案。

preset 落在 `<dshHome>/.agent-presets/buddy/`，含 `agent.cordis.yml` 与 `preset.yml`。

一条 buddy 对话 = 一个**普通 DSH Session**，只是携带 `buddy` preset。因此持久化、全文检索、
工具、审批、附件、回放、Telegram 桥接全部继承，无需重写。

### 4.4 主面板的角色

buddy 主面板是**指挥中心**，不是聊天器。点击对话列表中的一条：

```
ctx.sessions.open(sessionId)  →  ctx.layout.selectPanel(null)
```

回到官方聊天界面。官方的消息渲染、工具卡片、审批、流式输出、附件全部白拿，且不会长期
落后于官方。第一期按此实现；若实际使用中"跳来跳去"体感确实难受，后续单开一期评估内嵌聊天。

## 5. 第一期：窥探切片

端到端一条细线，每一段都是真的：

```
Settings → dsh-buddy 标签页写 persona
   ↓ typert 端点
buddy-persona 写 $DSH_HOME/buddy/SOUL.md
   ↓
buddy-persona 注册 prompt 变量 buddySoul（provider 每次 assemble 重调）
   ↓
buddy preset 的 @deepseek-ai/dsh-persona 行：prefix: '{{buddySoul}}'
   ↓
新建 buddy 会话，模型语气真的变了            ← 可验收
```

同时：左栏 Settings 上方出现 dsh-buddy 按钮 → 点击后主面板接管 → 显示 buddy 会话列表
→ 点一条回到官方聊天页。

落地两行 + 一个浏览器半边 + 一个 preset：

| 交付物 | 平面 |
|---|---|
| `buddy-store` | host row |
| `buddy-persona` | host row |
| 浏览器半边（按钮 + 主面板 + 设置页） | 包的 `dsh.client` bundle（不是 patch 行） |
| `buddy` agent preset（`agent.cordis.yml` + `preset.yml`） | `<dshHome>/.agent-presets/buddy/` |

preset 的安装由 `buddy-store` 在首次加载时完成：目录不存在则写入，**已存在则一律不覆盖**
（用户可能已经手改过自己的 preset）。

内置的 `agent.cordis.yml` **模板不是手写的**：先把官方 `standard` 拷成 `buddy`、加上人格行、
用 `agentPresets.standingKeyFor('buddy')` mount-validate 通过，再把验证过的成品收进仓库当模板。
composition 技能明确警告「从零写的 composition 常常漏掉 isolate realm 或 consumer 行」，
拷贝法从一开始就是可加载的。

### 5.1 第一期不做

记忆、进化、调度、看板、Telegram。架构插槽留好，代码一行不写。

## 6. 关键实现契约

### 6.1 Slot 注册

```js
// 左栏按钮 —— id 必须等于 main 的 key，否则 selectPanel 抛错
ctx.slots.inject("sidebar.panellist", () => ctx.slots.register(
  { name: "sidebar.panellist", id: "dsh-buddy", order: 10, label: () => t("nav"), locale: NS },
  BuddyIcon))

// 主面板接管
ctx.slots.inject("main", function* () {
  yield ctx.slots.register({ name: "main", key: "dsh-buddy" }, BuddyPanel)
})
```

按钮与面板必须同生同死：只注册按钮而没注册面板，点击即抛错。

### 6.2 继承自 dsh-telegram 的三条硬约定

1. **Cordis service 方法里禁止 `#` 私有字段。** cordis 把 service 包成 traceable proxy，
   api-gateway 用 `Reflect.apply` 派发，`#` 字段的 brand 穿不过 proxy —— 离线测试全绿、
   真机第一次调用就炸。用 TypeScript 的 `private`。同理禁止把方法掏出来裸调。
2. **软依赖一律 `ctx.get(name)`，不写 `ctx.name`。** 未进 `inject` 的服务，cordis Guard 在
   属性读取时直接抛 `cannot get property "x" without inject`。`inject` 只留给真正的硬依赖。
3. **DSH 不做任何转译。** TypeScript / JSX 必须在这边编译掉：host 半边 → `lib/index.js`（ESM，
   `@deepseek-ai/*` 全部 external）；浏览器半边 → `lib/client.js`（CJS，包在
   `window.__ModuleLoader__.load({id, factory})` 工厂里，React external）。

### 6.3 storage domain

一个进程只能开一个同名 domain，热重载会撞 `already-open`。照抄 dsh-telegram `openStore` 的
fallback：捕获 `code === 'already-open'` 后改用 `facility.get(name)` 复用活句柄。

domain 名须小写（`UNIT_NAME_RE`）。

### 6.4 注册即 effect

一切贡献走 `ctx.effect()` / `ctx.on()` / 服务 `register()` 的 disposer。禁止手动
`removeListener` / `clearInterval` 式收尾。waterfall 监听器必须调用 `next()`。

## 7. 技能可见性与自动进化

### 7.1 三层可见性

每个 buddy 生成的技能，frontmatter 带一个**声明式** `visibility` 字段（provenance 声明，
不从正文推断）：

| `visibility` | 实现机制 | 谁能看见 |
|---|---|---|
| `buddy`（默认） | provider 注册在 `agentPresets.standingKeyFor('buddy')` 的 scope 层 | 只有 buddy 会话 |
| `project: <path>` | global 层 provider，按 `SkillLookupOptions.cwd` 过滤 | 只在该项目目录下的会话 |
| `global` | global 层 provider，不过滤 | 所有会话，包括既有编码会话 |

**升级只能由人发起。** Agent 写出来的技能永远落在 `buddy`；改成 `project` / `global` 是设置页
里的显式动作，或用户手改 frontmatter。Agent 不能提升自己的作用域 —— 这是防止 buddy 学歪一个
习惯后污染所有编码会话的唯一硬保障。

### 7.2 auto 模式与三道闸

默认 `auto`（允许自动写入），但比 openclaw 多三道闸 —— 它的 auto 模式默认开启且**不留回滚
快照**，是那个产品最锋利的边：

1. **写前 content-addressed 快照。** 每次写入前把整个技能目录按内容哈希存进
   `$DSH_HOME/buddy/skills/.snapshots/<hash>/`，并写一条 ledger 记录。可一键回滚到任意历史点。
2. **只动自己的产物。** 沿用 hermes 的 `created_by: agent` 标记。用户手写的、或用户明确要求
   写的技能，curator 永不触碰。
3. **确定性剪枝先行。** 30 天未用 → 标记 stale；90 天 → 归档（**永不删除**）；
   `use_count == 0` 有宽限期；被 cron 引用的、被 pin 的豁免。LLM 整合是之后的**可选**第二阶段，
   默认关闭（Nous 自己实测一次 sweep 50–100 次 API 调用）。

失败模式明确：磁盘上永远有完整历史，最坏情况是多了些没用的技能文件，而不是丢了要用的那个。

## 8. 从参考产品吸收的六条

1. **记忆硬字符预算，写入失败时回传 `current_entries`**，逼 Agent 当场整合 —— 而不是静默
   淘汰错的那条。
2. **记忆块在会话开始冻结快照**，牺牲新鲜度换 prefix-cache 稳定。
3. **provenance 声明式、存成列**，不从正文解析；untrusted 来源**结构性禁止**进入 curated core
   （是前置条件，不是打分惩罚）。
4. **curation 跑在回复路径之外**（后台 fork 或定时 sweep）。
5. **cron preflight**：配置错 → `blocked_config` + 一次告警 + **零 token**；每 tick 全新会话；
   **no-agent 模式**（纯脚本、stdout 原样、零 LLM）。
6. **心跳 `NO_REPLY` 契约**：默认沉默的主动性。

## 9. 错误处理

| 情况 | 处理 |
|---|---|
| `storageDomain` 未挂载 | `buddy-store` 加载期响亮失败，其余行因 `inject` 未满足而等待 |
| domain `already-open` | 复用活句柄（热重载路径） |
| 存储数据 schema 漂移 | 响亮失败（`invalid-record`），不静默吞掉 |
| `SOUL.md` 不存在 | 回落到内置默认人格文本。**绝不返回空串**：空 `prefix` 会把 deployment persona 遮蔽掉却不放任何东西进去，得到一个没有任何身份的会话 |
| `SOUL.md` 读取失败 | 同上回落到默认人格，不抛出。人格损坏绝不能阻止会话启动 |
| `buddySoul` provider 返回 `undefined` | 不允许发生。渲染器对「被引用但本次装配无取值」的变量直接抛错，会打挂每一个 buddy 会话 |
| dsh-buddy 未安装但 `buddy` preset 仍在 | 装配以 `unknown prompt variable "{{buddySoul}}"` 响亮失败。**这是期望行为**：静默回落会得到一个自称 Buddy 却没有 Buddy 身份的会话 |
| 面板注册失败 | 按钮同时不注册 —— 二者同生同死 |
| `buddy` preset 目录已存在 | **一律不覆盖**，只记一条日志（用户可能已手改） |
| 技能写入前快照失败 | 拒绝写入（快照是写入的前置条件，不是尽力而为） |

## 10. 测试策略

| 测试 | 守什么 |
|---|---|
| `test/mount.test.ts`（挂真 cordis） | 软依赖必须 `ctx.get`，不能 `ctx.name` |
| `test/gateway.test.ts`（走 typert proxy 真实路径） | service 方法里没有 `#` 私有字段 |
| `test/store.test.ts` | domain schema、`already-open` fallback |
| `test/persona.test.ts` | `SOUL.md` 缺失/损坏时的降级；section 文本装配 |
| `test/client-ui.test.ts` | panellist id 与 main key 一致 |

host 侧真机验证用**隔离 profile**，不打扰正在使用的 3080 实例：

```bash
T=/tmp/dsh-probe; mkdir -p $T/profiles/web; cd ~/.dsh/profiles/web
cp cordis.yml cordis.patch.yml package.json pnpm-workspace.yaml $T/profiles/web/
ln -s ~/.dsh/profiles/web/node_modules $T/profiles/web/node_modules
DSH_HOME=$T dsh --profile web --no-open --port 3099
```

验完 `find ~/.dsh -newermt <开始时间>` 应为空。

**注意：web profile 下插件日志不到 stdout**，`ctx.logger.info` 不落任何文件。要看 host 侧真实
行为必须走隔离 profile，不能让用户帮忙看日志。

## 11. 第一期验收标准

1. 左栏 Settings 上方出现 dsh-buddy 按钮
2. 点击后主面板被 buddy 界面接管
3. buddy 界面列出 buddy 会话；点一条回到官方聊天页并打开该会话
4. Settings 出现 dsh-buddy 标签页，可编辑 persona 并保存
5. 保存后 `$DSH_HOME/buddy/SOUL.md` 内容正确
6. `buddy` preset 出现在 preset 选择器里；用它新建会话，模型行为体现该人格；
   非 buddy 会话（例如现有编码会话）完全不受影响
6b. 改完 `SOUL.md` 后**无需重载**，下一个新会话即生效
7. `dsh --profile <name> --dump-config` 中 patch 行生效，启动日志无 FAILED
8. 上述测试全绿；typecheck 通过

## 12. 后续期

下表是各期的**依赖约束**，不是承诺的执行顺序：除记忆需先于看板之外，2–6 期彼此独立，
实际先做哪一期在第一期交付后按当时价值决定。

| 期 | 内容 | 依赖 |
|---|---|---|
| 2 | 记忆系统（tier1 策略层 + tier2 打 sessionQuery） | buddy-store |
| 3 | 技能自动进化（provider + 三层可见性 + 快照 ledger） | buddy-store |
| 4 | 定时任务与调度器（含 preflight、no-agent 模式、心跳） | buddy-store |
| 5 | 看板 | buddy-store、buddy-scheduler |
| 6 | Telegram（吸收 dsh-telegram） | buddy-persona |

每期只新增 row，不重构既有代码。

**本文档的实施计划只覆盖第一期。** 每个后续期在启动时各自出一份实施计划。

## 13. 部署

插件不进 profile 的 bundle 栈就不生效：

1. `package.json` 同时声明 `dsh.bundle.patch: "./cordis.patch.yml"` 与 `dsh.client`
2. `~/.dsh/profiles/web/package.json` 加 `"dsh-buddy": "link:/home/panda-nuc/repo/dsh-buddy"`，
   且该名字进 `dsh.profile.bundles`
3. `dsh plugin --profile web install`
4. **host 半边改动要重启 dsh；浏览器半边 build 之后热重载**
