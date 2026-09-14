# Buddy Skill Auto-Evolution (Phase 3a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Buddy 在对话回合结束后自动开一个独立子会话回看这段对话，把可复用的做法写成技能文件；这些技能在结构上只对 buddy 会话可见，写入全程有快照、账本与一键回滚，且只有后台总结自己产出的技能才归自动管理。

**Architecture:** 一个包拆两行。host 行 `dsh-buddy/skills` 拥有技能文件根、storage domain 表（遥测/账本/用量）、review 编排与 `skill_manage` 的实现，发布 `ctx.buddySkills`；preset 行 `dsh-buddy/skills-agent` 挂在 `buddy` agent preset 里，注册 SkillProvider、`skill_manage` 工具、`session/event` 与 `tools/post-execute` 监听器与 `refine` 命令——**注册落进哪个 scope 层由行的位置决定**，这就是"技能只在 buddy 可见"的结构性保证。

**Tech Stack:** TypeScript（构建期剥类型，DSH 不做转译）、cordis、schemastery、zod、`@deepseek-ai/dsh-skill`、`@deepseek-ai/dsh-subagent`、`@deepseek-ai/dsh-storage-domain`、`@deepseek-ai/dsh-tools`、React（浏览器半边）、node:test。

**Spec:** `docs/superpowers/specs/2026-09-13-buddy-skills-design.md`（本计划的每一步都从该文档推出；实现者两份都要读）

## Global Constraints

- **DSH 不做任何转译**：TypeScript/JSX 必须在这边编译掉。host 入口是 ESM 且所有 `@deepseek-ai/*` 保持 external；浏览器入口是 CJS 包在 `window.__ModuleLoader__.load({id, factory})` 信封里。
- **`#` 私有字段禁止出现在注册为 cordis service 的类里**（cordis 用 proxy + `Reflect.apply` 派发，brand 穿不过 proxy）。用 TypeScript `private`。
- **软依赖一律 `ctx.get('name')`**，绝不写 `ctx.name`；`inject` 只留给硬依赖。
- **注册即 effect**：一切贡献走 `ctx.effect()` / `ctx.on()` / 服务 `register()` 返回的 disposer。
- **绝不序列化活的 harness 数据**（Session/Slot/service）：只读叶子字段，构造自己的小对象。
- **名字语法**：storage unit 只允许下划线（`buddy_skills_*` 不可用，全部走既有的 `buddy` 域），settings namespace 只允许连字符。技能名必须是 DSH 的 kebab-case：`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`。
- **任何测试文件都不得 import `.tsx`**；浏览器行为通过构建产物 `lib/client.js` 断言。
- **提交前跑 `npm run check`**（typecheck + build + test）。
- **参考实现常量（照抄，不得改数）**：nudge 间隔 `10`；review 步数上限 `16`；输入 token 预算 `600000`；digest 保留最后 `24` 条，user 截 `300`、assistant 截 `200`、tool result 丢弃；description ≤ `1024`（创建时 ≤ `60`）；正文 ≤ `100000` 字符；支撑文件 ≤ `1048576` 字节且只能落在 `references|templates|scripts|assets`；批量操作 ≤ `20` 且 `delete` 必须独占；linter 的 `incident-log-shape` 阈值 `≥4 refs` 且 `≥0.5/千字符`、`references-sprawl` `>60` 个文件；`defer` 相关常量（15s / 1800s / ≤3 次）本期**不实现**，见 spec §11.3。

## File Structure

| 文件 | 职责 |
|---|---|
| `src/paths.ts`（改） | 新增 `skills` 与 `skillSnapshots` 两个路径 |
| `src/config.ts`（改） | `buddy.skills` 段（开关、间隔、review 模型、预算、writeApproval、ledger） |
| `src/store/domain.ts`（改） | 新增 `skill_usage` / `skill_ledger` / `review_usage` 三张表（**存储名，snake_case**），并在 handle 上以同义 camelCase 字段暴露 |
| `src/store/index.ts`（改） | 把三张表挂到 `ctx.buddyStore` 上 |
| `src/store/preset.ts`（改） | `installPreset` → `syncPreset`：生成物标记 + 覆盖前备份 |
| `src/skills/validate.ts`（新） | 技能名 / frontmatter / 体积校验（纯函数） |
| `src/skills/linter.ts`（新） | 13 条 advisory 规则（纯函数） |
| `src/skills/snapshot.ts`（新） | 内容寻址 blob 存储 + 原子性快照（copytree 等价物） |
| `src/skills/ledger.ts`（新） | 账本记录、单条回滚（fail-closed） |
| `src/skills/usage.ts`（新） | 遥测读写、派生字段、adopt/pin |
| `src/skills/manage.ts`（新） | `skill_manage` 的动作实现与批量原子应用 |
| `src/skills/guards.ts`（新） | 管辖权（`created_by`）、pinned、read-before-write、provenance 判定 |
| `src/skills/provider.ts`（新） | 两层 SkillProvider（buddy 层 / global 过滤层） |
| `src/skills/digest.ts`（新） | digest 算法（纯函数） |
| `src/skills/prompt.ts`（新） | review 提示词字面量 |
| `src/skills/review.ts`（新） | 触发判定、单飞、fork/spawn、预算执行、用量归属 |
| `src/skills/gateway.ts`（新） | 面板用的 typert 端点（`buddySkills/*`） |
| `src/skills/index.ts`（新） | host 行装配：发布 `ctx.buddySkills` |
| `src/skills-agent/index.ts`（新） | preset 行装配：provider + 工具 + 监听器 + 命令 + 心跳 |
| `src/persona/index.ts`（改） | `listSessions` 过滤 `origin === 'subagent'` |
| `src/client/skills-module.tsx`（新） | 面板 Skills 模块 |
| `src/client/modules.ts`（改） | 模块表加一行 |
| `src/index.ts`（改） | `PANEL_SECTION_IDS` 加 `skills` |
| `cordis.patch.yml` / `build.mjs` / `package.json`（改） | 两行的接线 |
| `assets/preset/agent.cordis.yml`（改） | 生成物声明 + `buddy-skills-agent` 行 |
| `CLAUDE.md`（改:58）/ 设计文档 §5/§9 | 不变量改写 |
| 测试 | `test/skills-*.test.ts`、`test/preset-sync.test.ts`（改写既有 `preset-install.test.ts`） |

---

### Task 1: 目录布局与 settings

**Files:**
- Modify: `src/paths.ts`
- Modify: `src/config.ts`
- Test: `test/paths.test.ts`, `test/config.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `BuddyPaths.skills: string`、`BuddyPaths.skillSnapshots: string`；`BuddyConfig.skills` 形状 `{ enabled: boolean; creationNudgeInterval: number; reviewProvider: string; reviewModel: string; maxReviewSteps: number; maxInputTokens: number; writeApproval: boolean; ledger: boolean }`

- [ ] **Step 1: 写失败的测试**

在 `test/paths.test.ts` 追加：

```ts
test("the skills root is a sibling of SOUL.md under main/", () => {
	const paths = resolveBuddyPaths("/tmp/buddy-home");
	assert.equal(paths.skills, join("/tmp/buddy-home", "main", "skills"));
	assert.equal(paths.skillSnapshots, join("/tmp/buddy-home", "main", "skills", ".snapshots"));
	// 技能目录绝不能落在 workspace 里：workspace 是会话 cwd，落在里面的目录会被
	// 任何以它为 cwd 的会话当成项目根扫到（见 spec §4 的文件层隔离）。
	assert.ok(!paths.skills.startsWith(paths.workspace));
});
```

在 `test/config.test.ts` 追加：

```ts
test("skills settings carry the reference defaults", () => {
	const resolved = Config({} as never) as BuddyConfig;
	assert.equal(resolved.skills.enabled, true);
	assert.equal(resolved.skills.creationNudgeInterval, 10);
	assert.equal(resolved.skills.maxReviewSteps, 16);
	assert.equal(resolved.skills.maxInputTokens, 600000);
	assert.equal(resolved.skills.writeApproval, false);
	assert.equal(resolved.skills.ledger, true);
	assert.equal(resolved.skills.reviewProvider, "");
	assert.equal(resolved.skills.reviewModel, "");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/paths.test.ts test/config.test.ts`
Expected: FAIL — `paths.skills` undefined，`resolved.skills` undefined

- [ ] **Step 3: 实现**

`src/paths.ts`：接口加两个字段，`resolveBuddyPaths` 里补：

```ts
	const skills = join(main, "skills");
	return {
		home,
		main,
		soul: join(main, "SOUL.md"),
		agents: join(main, "AGENTS.md"),
		workspace: join(main, "workspace"),
		skills,
		// 内容寻址的写入前快照。放 skills/ 之下而不是 home 之下：它属于技能这一层，
		// 且以 `.` 开头，不会与技能目录名冲突（技能名语法不允许前导点）。
		skillSnapshots: join(skills, ".snapshots"),
	};
```

`src/config.ts`：`BuddyConfig` 加 `skills` 字段、`FALLBACK_CONFIG` 加默认值、`Config` 的 `z.object` 加一段（每个字段都要 `.description(...)`，与既有字段一致）：

```ts
	skills: z
		.object({
			enabled: z.boolean().default(true).description("自动总结技能的总开关"),
			creationNudgeInterval: z.number().default(10).description("每多少步触发一次后台总结"),
			reviewProvider: z.string().default("").description("后台总结使用的 provider；留空跟随父会话模型"),
			reviewModel: z.string().default("").description("后台总结使用的模型；留空跟随父会话模型"),
			maxReviewSteps: z.number().default(16).description("单次后台总结的模型轮数上限"),
			maxInputTokens: z.number().default(600000).description("单次后台总结累计输入 token 上限"),
			writeApproval: z.boolean().default(false).description("写入技能前先暂存待批"),
			ledger: z.boolean().default(true).description("记录技能变更账本"),
		})
		.default({ ...FALLBACK_CONFIG.skills })
		.description("技能自动进化"),
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/paths.test.ts test/config.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/paths.ts src/config.ts test/paths.test.ts test/config.test.ts
git commit -m "feat: buddy skills root and its settings section"
```

---

### Task 2: domain 表

**Files:**
- Modify: `src/store/domain.ts`
- Modify: `src/store/index.ts`
- Test: `test/domain.test.ts`, `test/store.test.ts`

**Interfaces:**
- Consumes: Task 1 无直接依赖
- Produces: `BuddyDomainHandle.skillUsage` / `.skillLedger` / `.reviewUsage`（三个 `KvTable`），以及导出的记录类型 `SkillUsageRecord`、`SkillLedgerRecord`、`ReviewUsageRecord` 与构造函数 `emptyUsageRecord(now: string): SkillUsageRecord`；`ctx.buddyStore.skillUsage()` 等同名访问器

- [ ] **Step 1: 写失败的测试**

`test/domain.test.ts` 追加：

```ts
test("the domain declares the three skill tables", () => {
	assert.deepEqual(Object.keys(buddyDomainSpec.tables).sort(), ["review_usage", "skill_ledger", "skill_usage"]);
});

test("a usage record round-trips and defaults are explicit", async () => {
	const handle = await openStore({ get: () => facility } as never);
	const record = emptyUsageRecord("2026-09-13T00:00:00.000Z");
	await handle.skillUsage.put("my-skill", record);
	assert.equal(handle.skillUsage.get("my-skill")?.use_count, 0);
	assert.equal(handle.skillUsage.get("my-skill")?.created_by, null);
	assert.equal(handle.skillUsage.get("my-skill")?.state, "active");
});
```

（`facility` 直接照抄 `test/domain.test.ts` 既有的内存 backend 构造与 `openStore` 往返写法——该文件已经有一处 `defineDomain` 的读写测试，把它的 helper 提出来复用即可。）

`emptyUsageRecord` 定义在 `src/store/domain.ts` 里、紧挨 `skillUsageSchema`（Task 6 的 `usage.ts` 从那里 import，不重复定义）：

```ts
/** 一条零值遥测记录；字段名与参考实现逐个对应。 */
export function emptyUsageRecord(now: string): SkillUsageRecord {
	return {
		created_by: null,
		use_count: 0,
		view_count: 0,
		last_used_at: null,
		last_viewed_at: null,
		patch_count: 0,
		patch_generation: 0,
		last_reused_patch_generation: 0,
		last_patched_at: null,
		created_at: now,
		state: "active",
		pinned: false,
		archived_at: null,
	};
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/domain.test.ts`
Expected: FAIL — `tables` 只有空对象

- [ ] **Step 3: 实现**

`src/store/domain.ts` 加三张表（字段名与 `$H:tools/skill_usage.py:329-332` 逐个对应）：

```ts
/** 一个技能的使用遥测。字段名与参考实现逐个对应；`latest_activity_at`/`activity_count` 是算出来的，不落库。 */
export const skillUsageSchema = z.object({
	created_by: z.string().nullable(),
	use_count: z.number(),
	view_count: z.number(),
	last_used_at: z.string().nullable(),
	last_viewed_at: z.string().nullable(),
	patch_count: z.number(),
	patch_generation: z.number(),
	last_reused_patch_generation: z.number(),
	last_patched_at: z.string().nullable(),
	created_at: z.string(),
	state: z.enum(["active", "stale", "archived"]),
	pinned: z.boolean(),
	archived_at: z.string().nullable(),
});

/** 技能变更账本的一条。`before`/`after` 是内容寻址的 `{path, sha256}` 清单。 */
export const skillLedgerSchema = z.object({
	id: z.string(),
	ts: z.string(),
	actor: z.enum(["curator", "agent", "user"]),
	action: z.enum(["create", "edit", "patch", "delete", "write_file", "remove_file", "archive", "restore", "pre-rollback", "rollback"]),
	skill: z.string(),
	evidence: z.record(z.string(), z.unknown()),
	before: z.array(z.object({ path: z.string(), sha256: z.string() })),
	after: z.array(z.object({ path: z.string(), sha256: z.string() })),
});

/** 一次后台总结的用量，归属到父会话（spec §9.2）。 */
export const reviewUsageSchema = z.object({
	id: z.string(),
	ts: z.string(),
	parentSessionId: z.string(),
	childSessionId: z.string(),
	provider: z.string(),
	model: z.string(),
	steps: z.number(),
	inputTokens: z.number(),
	outputTokens: z.number(),
	cacheReadTokens: z.number(),
	cacheWriteTokens: z.number(),
	outcome: z.string(),
});

export const buddyDomainSpec = defineDomain({
	name: BUDDY_DOMAIN_NAME,
	// 版本 +1：新增三张表。global 槽不变，旧数据可读。
	version: 2,
	compatibleVersions: [1],
	global: { schema: globalSchema, initial: {} },
	tables: {
		// 表名是**存储单元名**，受 `UNIT_NAME_RE`（`/^[a-z][a-z0-9_]*$/`）约束：
		// 必须 snake_case。写成 camelCase 会在 `defineDomain` 处（即模块加载时）抛错。
		skill_usage: { valueSchema: skillUsageSchema },
		skill_ledger: { valueSchema: skillLedgerSchema },
		review_usage: { valueSchema: reviewUsageSchema },
	},
});
```

`BuddyDomainHandle` 加三个只读字段（**camelCase 代码标识符**：`skillUsage` / `skillLedger` / `reviewUsage`）并在 `openStore` 里用**存储名** `domain.table('skill_usage')` / `'skill_ledger'` / `'review_usage'` 填上——两套拼写并存是刻意的：存储名受 `UNIT_NAME_RE` 约束，代码标识符不受。`src/store/index.ts` 的 `BuddyStore` 类加三个访问器方法（`skillUsage()` 等），与既有 `config()`/`paths()` 同风格。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/domain.test.ts test/store.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/store/domain.ts src/store/index.ts test/domain.test.ts
git commit -m "feat: skill usage, ledger and review-usage tables in the buddy domain"
```

---

### Task 3: 技能校验

**Files:**
- Create: `src/skills/validate.ts`
- Test: `test/skills-validate.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `SKILL_NAME_RE`、`ALLOWED_SUBDIRS`、`MAX_DESCRIPTION_LENGTH`(1024)、`SKILL_CREATE_DESC_LIMIT`(60)、`MAX_SKILL_CONTENT_CHARS`(100000)、`MAX_SKILL_FILE_BYTES`(1048576)；`validateSkillName(name): string | undefined`；`parseFrontmatter(content): { frontmatter: Record<string, unknown>; body: string } | { error: string }`；`validateSkillDocument(input: { name: string; content: string; creating: boolean }): { ok: true; frontmatter: Record<string, unknown>; body: string } | { ok: false; error: string }`；`validateSupportPath(rel: string): string | undefined`；`validateSupportBytes(rel: string, bytes: number): string | undefined`

- [ ] **Step 1: 写失败的测试**

```ts
test("the DSH skill-name grammar is enforced, not hermes' looser one", () => {
	assert.equal(validateSkillName("pdf-merge"), undefined);
	assert.match(String(validateSkillName("pdf_merge")), /lowercase letters, digits and hyphens/);
	assert.match(String(validateSkillName("pdf.merge")), /lowercase letters/);
	assert.match(String(validateSkillName("")), /required/);
});

test("frontmatter must be a closed YAML mapping with name and description", () => {
	const missing = validateSkillDocument({ name: "a-b", content: "# no fence\n", creating: true });
	assert.equal(missing.ok, false);
	const noDesc = validateSkillDocument({
		name: "a-b",
		content: "---\nname: a-b\n---\nbody\n",
		creating: true,
	});
	assert.equal(noDesc.ok, false);
	if (!noDesc.ok) assert.match(noDesc.error, /description/);
});

test("create caps the description at 60 chars, later writes at 1024", () => {
	const long = "x".repeat(80);
	const content = `---\nname: a-b\ndescription: ${long}\n---\nbody\n`;
	assert.equal(validateSkillDocument({ name: "a-b", content, creating: true }).ok, false);
	assert.equal(validateSkillDocument({ name: "a-b", content, creating: false }).ok, true);
});

test("a support file must live under an allowed subdir and fit the byte cap", () => {
	assert.equal(validateSupportPath("references/a.md"), undefined);
	assert.match(String(validateSupportPath("notes/a.md")), /references/);
	assert.match(String(validateSupportBytes("references/a.md", MAX_SKILL_FILE_BYTES + 1)), /1048576/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/skills-validate.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

```ts
/**
 * Skill document validation, ported from the reference implementation.
 *
 * The name grammar is DSH's, NOT hermes' looser `^[a-z0-9][a-z0-9._-]*$`: the
 * DSH registry validates candidate names with its own kebab-case grammar and
 * throws on a mismatch, so a name hermes would accept could not be loaded here.
 * @module dsh-buddy/skills/validate
 */
// 没有 YAML 依赖：本包的 `hostExternal` 等于 `dependencies ∪ peerDependencies`（build.mjs:23），
// 而 `yaml` 不在其中，裸 import 既解析不到也打不进产物；为一个扁平的 frontmatter 引入新依赖
// 不值得（且本机不能联网装包）。所以这里自带一个小解析器，并明确它接受的子集。

export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const ALLOWED_SUBDIRS = ["references", "templates", "scripts", "assets"] as const;
export const MAX_DESCRIPTION_LENGTH = 1024;
export const SKILL_CREATE_DESC_LIMIT = 60;
export const MAX_SKILL_CONTENT_CHARS = 100_000;
export const MAX_SKILL_FILE_BYTES = 1_048_576;

export function validateSkillName(name: string): string | undefined {
	if (name.trim() === "") return "a skill name is required";
	if (!SKILL_NAME_RE.test(name)) {
		return `skill name '${name}' must be lowercase letters, digits and hyphens only`;
	}
	return undefined;
}

export function validateSkillDocument(input: {
	name: string;
	content: string;
	creating: boolean;
}): { ok: true; frontmatter: Record<string, unknown>; body: string } | { ok: false; error: string } {
	const nameError = validateSkillName(input.name);
	if (nameError !== undefined) return { ok: false, error: nameError };
	if (input.content.length > MAX_SKILL_CONTENT_CHARS) {
		return { ok: false, error: `SKILL.md exceeds ${MAX_SKILL_CONTENT_CHARS} chars` };
	}
	const parsed = parseFrontmatter(input.content);
	if ("error" in parsed) return { ok: false, error: parsed.error };
	const rawName = parsed.frontmatter["name"];
	if (typeof rawName !== "string" || rawName.trim() === "") {
		return { ok: false, error: "frontmatter is missing 'name'" };
	}
	if (rawName !== input.name) {
		return { ok: false, error: `frontmatter name '${rawName}' does not match directory '${input.name}'` };
	}
	const description = parsed.frontmatter["description"];
	if (typeof description !== "string" || description.trim() === "") {
		return { ok: false, error: "frontmatter is missing 'description'" };
	}
	const limit = input.creating ? SKILL_CREATE_DESC_LIMIT : MAX_DESCRIPTION_LENGTH;
	if (description.length > limit) {
		return { ok: false, error: `description is ${description.length} chars; the create limit is ${limit}` };
	}
	if (parsed.body.trim() === "") return { ok: false, error: "the body is empty" };
	return { ok: true, frontmatter: parsed.frontmatter, body: parsed.body };
}
```

`parseFrontmatter` **不用 YAML 库**（理由见上）：首行必须是 `---`、必须找到闭合 `---`，中间按行解析成**扁平映射**——`key: value`，值支持裸标量、单/双引号字符串、行内列表 `[a, b]` 与块列表（`- item` 续行）；空行与 `#` 注释跳过。解析结果必须是映射（数组/标量都拒绝）。**只有一个导出名 `parseFrontmatter`**（内部实现细节不再另起名字，见 Task 3 的评审裁定）。**两条路径的严格度不同**：

- **写路径（`validateSkillDocument`）严格**：只接受这个子集，遇到无法解析的行返回 `{ ok: false, error }`，错误文案要告诉模型"frontmatter 必须是扁平的 key: value"。这是我们自己写出去的格式，收紧是有意的。
- **读路径必须容忍、永不抛**：provider 读 `visibility` 时若 frontmatter 解析失败或字段缺失，一律回落成默认 `visibility: "buddy"`，绝不让一个手写技能因为解析问题从技能列表里消失（`$H` 的加载器用真 YAML，比我们宽；读宽写严是这个差异的正确处理方式）。

`validateSupportPath` 检查首段在 `ALLOWED_SUBDIRS` 内且路径不含 `..`；`validateSupportBytes` 检查字节上限。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/skills-validate.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/skills/validate.ts test/skills-validate.test.ts
git commit -m "feat: skill document validation"
```

---

### Task 4: advisory linter

**Files:**
- Create: `src/skills/linter.ts`
- Test: `test/skills-linter.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `SKILL_CREATE_DESC_LIMIT`、`MAX_DESCRIPTION_LENGTH`
- Produces: `lintSkill(input: { content: string; skillDir: string; skillName: string; frontmatter: Record<string, unknown>; dirExists?: (rel: string) => boolean }): LintFinding[]`；`LintFinding = { severity: "error" | "warning"; rule: string; message: string }`

- [ ] **Step 1: 写失败的测试**

每条规则一个用例 + 一条"警告不阻断"的断言：

```ts
test("shell-utility-reference names the DSH tool, not hermes'", () => {
	const findings = lintSkill(skill({ body: "先 `cat` 文件再用 `sed` 改。\n\n## When to Use\nx\n" }));
	const rule = findings.find((f) => f.rule === "shell-utility-reference");
	assert.ok(rule);
	assert.match(rule.message, /`read`/);
	assert.match(rule.message, /`edit`/);
	assert.doesNotMatch(rule.message, /read_file|patch/);
});

test("incident-log-shape fires only at >=4 refs AND >=0.5 per 1k chars", () => {
	const dense = "## When to Use\n" + "see #1234 #1235 #1236 #1237 for why.\n".repeat(20);
	assert.ok(lintSkill(skill({ body: dense })).some((f) => f.rule === "incident-log-shape"));
	const one = "## When to Use\nfixed in #1234.\n" + "prose ".repeat(400);
	assert.ok(!lintSkill(skill({ body: one })).some((f) => f.rule === "incident-log-shape"));
});

test("every finding is advisory and the caller is told so", () => {
	const findings = lintSkill(skill({ body: "no headings at all" }));
	assert.ok(findings.length > 0);
	assert.ok(findings.every((f) => f.severity === "error" || f.severity === "warning"));
	// 这条断言的存在就是"不阻断"的契约：linter 只返回发现，没有任何 throw 路径。
	assert.doesNotThrow(() => lintSkill(skill({ body: "" })));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/skills-linter.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

按 spec §8.2 的 13 条实现（`author-caps` 删除）。移植时的三个平台改写点必须落实：

```ts
/** hermes 的映射是 search_files/read_file/patch；DSH 的工具名不同，映射跟着换。 */
const SHELL_UTIL_TO_TOOL: Record<string, string> = {
	grep: "grep",
	rg: "grep",
	cat: "read",
	head: "read",
	tail: "read",
	sed: "edit",
	awk: "edit",
	find: "glob",
	ls: "glob",
};
const MARKETING_WORDS = ["powerful", "comprehensive", "seamless", "advanced", "cutting-edge", "state-of-the-art", "revolutionary", "robust"];
const FORBIDDEN_FILES = ["README.md", "CHANGELOG.md", "install.sh", ".env", ".env.example", ".gitignore"];
const POSIX_PRIMITIVES = ["fcntl", "termios", "os.setsid", "osascript", "/proc/", "apt-get", "systemctl"];
const INCIDENT_REF_MIN = 4;
const INCIDENT_REF_PER_KCHAR = 0.5;
const MAX_REFERENCE_FILES = 60;
const EXPECTED_SECTIONS = ["When to Use", "When to use"];
```

`missing-metadata` 检查 `visibility`（Buddy 的字段）以及 `version`/`author`/`license`；`name-format` 与 `name-dir-mismatch` 复用 Task 3 的正则。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/skills-linter.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/skills/linter.ts test/skills-linter.test.ts
git commit -m "feat: advisory skill linter (13 rules ported)"
```

---

### Task 5: 快照、账本与回滚

**Files:**
- Create: `src/skills/snapshot.ts`, `src/skills/ledger.ts`
- Test: `test/skills-ledger.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `SkillLedgerRecord`
- Produces:
  - `storeBlob(snapshotsDir: string, bytes: Uint8Array): Promise<string>`（返回 sha256）
  - `readBlob(snapshotsDir: string, sha256: string): Promise<Uint8Array | undefined>`
  - `snapshotPaths(root: string): Promise<{ path: string; sha256: string }[]>`
  - `atomicSnapshot(dir: string, dest: string): Promise<{ ok: true } | { ok: false; error: string }>`（失败即中止，见 spec §8.3 第 1 条）
  - `recordMutation(deps, input: { actor; action; skill; evidence; before; afterRoot }): Promise<void>`（尽力而为，绝不抛）
  - `captureBefore(deps, root: string | undefined, options?: { completePackage?: boolean; skill?: string }): Promise<{ path: string; sha256: string }[] | undefined>`（尽力而为，失败返回 `undefined`）
  - `listEntries(deps, filter?: { skill?: string; limit?: number }): Promise<SkillLedgerRecord[]>`（最新在前，坏行跳过）
  - `rollbackEntry(deps, entryId: string): Promise<{ ok: boolean; message: string }>`

- [ ] **Step 1: 写失败的测试**

```ts
test("the audit snapshot is best-effort: a blob failure must NOT block the write", async () => {
	const deps = failingBlobDeps();
	const result = await captureBefore(deps, "/does/not/exist");
	assert.equal(result, undefined); // 调用方拿到 undefined 也要继续写
});

test("the atomicity snapshot DOES gate: an unreadable directory aborts the batch", async () => {
	const result = await atomicSnapshot("/does/not/exist", join(tmp, "snap"));
	assert.equal(result.ok, false);
	assert.match(result.ok === false ? result.error : "", /no snapshot, no atomicity/);
});

test("rollback fails closed when a before-blob is missing and changes nothing", async () => {
	await seedLedgerEntry({ id: "e1", action: "patch", skill: "a-b", before: [{ path: join(dir, "SKILL.md"), sha256: "deadbeef" }], after: [] });
	const result = await rollbackEntry(deps, "e1");
	assert.equal(result.ok, false);
	assert.match(result.message, /rollback aborted, nothing was changed/);
	assert.equal(await readFile(join(dir, "SKILL.md"), "utf8"), "current");
});

test("rollback writes a pre-rollback safety entry before restoring", async () => {
	// …构造一个 blob 齐全的 patch 条目，改坏文件，回滚
	const result = await rollbackEntry(deps, "e2");
	assert.equal(result.ok, true);
	assert.equal(await readFile(join(dir, "SKILL.md"), "utf8"), "original");
	const actions = (await listEntries(deps)).map((e) => e.action);
	assert.deepEqual(actions.slice(0, 2), ["rollback", "pre-rollback"]);
});

test("rollback refuses a ledger entry whose paths escape the buddy home", async () => {
	const result = await rollbackEntry(deps, "escapes");
	assert.equal(result.ok, false);
	assert.match(result.message, /outside the buddy home/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/skills-ledger.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

要点（照 spec §8.3）：

- blob 以小写十六进制 sha256 为文件名存进 `skillSnapshots`；写临时文件后 `os.replace` 落地；已存在则不重写（内容去重）。
- `captureBefore` 整体包 try/catch，失败 `console.error("skill_ledger: before-capture failed (%s) — mutation unaffected")` 并返回 `undefined`。
- `atomicSnapshot` 用 `fs.cp(dir, dest, { recursive: true })`，失败返回 `"Could not snapshot '<name>' for atomic batch: <err>"`。
- `rollbackEntry` 顺序：取条目 → **校验所有 path 都在 buddy home 之内** → delete/archive 类补齐 before → fail-closed 预检每个 blob 都在 → 写 `pre-rollback` 安全条目 → 恢复 before / 删除只在 after 的文件 → 写 `rollback` 条目。
- 账本与 blob 的**失败永不阻断写入**；唯一 fail-closed 的是 `rollbackEntry`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/skills-ledger.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/skills/snapshot.ts src/skills/ledger.ts test/skills-ledger.test.ts
git commit -m "feat: content-addressed skill snapshots and the mutation ledger"
```

---

### Task 6: 遥测

**Files:**
- Create: `src/skills/usage.ts`
- Test: `test/skills-usage.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `skill_usage` 表、`SkillUsageRecord` 与 `emptyUsageRecord`
- Produces: `recordCreated(table, name, { agentCreated, now })`、`bumpUse(table, name, now)`、`bumpView(table, name, now)`、`bumpPatch(table, name, action, now)`、`setPinned(table, name, pinned)`、`adopt(table, name)`、`latestActivityAt(record): string | undefined`、`activityCount(record): number`（`emptyUsageRecord` 来自 Task 2，本任务不重复定义）

- [ ] **Step 1: 写失败的测试**

```ts
test("recordCreated resets the whole record and stamps provenance", async () => {
	await table.put("a-b", { ...emptyUsageRecord(now), use_count: 5, pinned: true });
	await recordCreated(table, "a-b", { agentCreated: true, now });
	const record = table.get("a-b")!;
	assert.equal(record.created_by, "agent");
	assert.equal(record.use_count, 0); // 整条重置
	assert.equal(record.pinned, false);
});

test("create does not bump patch_count; the four mutating actions do", async () => {
	await recordCreated(table, "a-b", { agentCreated: false, now });
	assert.equal(table.get("a-b")!.patch_count, 0);
	await bumpPatch(table, "a-b", "patch", now);
	assert.equal(table.get("a-b")!.patch_count, 1);
	assert.equal(table.get("a-b")!.patch_generation, 1);
});

test("latest activity excludes created_at so a never-used skill stays distinguishable", () => {
	const record = emptyUsageRecord("2026-09-13T00:00:00.000Z");
	assert.equal(latestActivityAt(record), undefined);
	assert.equal(activityCount(record), 0);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/skills-usage.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

照 Task 2 的字段逐个实现；`bumpUse` 在 `patch_generation` 推进后的一次使用要更新 `last_reused_patch_generation`；`latestActivityAt` 取 `last_used_at`/`last_viewed_at`/`last_patched_at` 的最大值（ISO 字符串可字典序比较，但用 `Date.parse` 更稳），**不包含 `created_at`**。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/skills-usage.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/skills/usage.ts test/skills-usage.test.ts
git commit -m "feat: skill usage telemetry accessors"
```

---

### Task 7: `skill_manage` 的动作与批量原子

**Files:**
- Create: `src/skills/manage.ts`
- Test: `test/skills-manage.test.ts`

**Interfaces:**
- Consumes: Task 3 校验、Task 5 快照/账本、Task 6 遥测、Task 4 linter
- Produces: `runOperations(deps, operations: Operation[]): Promise<{ success: boolean; results: unknown[]; failed_index?: number; completed_before_failure?: number; error?: string }>`；`Operation = { action: "create"|"patch"|"edit"|"delete"|"write_file"|"remove_file"; name: string; content?: string; old_string?: string; new_string?: string; file_path?: string; absorbed_into?: string }`

- [ ] **Step 1: 写失败的测试**

```ts
test("a batch is atomic: a failure at index 1 restores index 0", async () => {
	const before = await readFile(join(skillsRoot, "a-b", "SKILL.md"), "utf8");
	const result = await runOperations(deps, [
		{ action: "patch", name: "a-b", old_string: "one", new_string: "two" },
		{ action: "patch", name: "c-d", old_string: "absent", new_string: "x" },
	]);
	assert.equal(result.success, false);
	assert.equal(result.failed_index, 1);
	assert.equal(await readFile(join(skillsRoot, "a-b", "SKILL.md"), "utf8"), before);
});

test("create refuses an existing name and validates the document first", async () => {
	const exists = await runOperations(deps, [{ action: "create", name: "a-b", content: validDoc("a-b") }]);
	assert.equal(exists.success, false);
	assert.match(String(exists.error), /already exists/);
	const bad = await runOperations(deps, [{ action: "create", name: "a-b", content: "---\nname: a-b\n---\n" }]);
	assert.equal(bad.success, false);
});

test("a create returns advisory lint findings without failing", async () => {
	const result = await runOperations(deps, [
		{ action: "create", name: "e-f", content: "---\nname: e-f\ndescription: robust helper\n---\nno heading here\n" },
	]);
	assert.equal(result.success, true);
	const first = result.results[0] as { lint_warnings?: unknown[]; lint_hint?: string };
	assert.ok(Array.isArray(first.lint_warnings) && first.lint_warnings.length > 0);
	assert.match(String(first.lint_hint), /not blockers/);
});

test("delete must be the sole operation in its call", async () => {
	const result = await runOperations(deps, [
		{ action: "delete", name: "a-b" },
		{ action: "patch", name: "c-d", old_string: "x", new_string: "y" },
	]);
	assert.equal(result.success, false);
	assert.match(String(result.error), /compose with other ops/);
});

test("more than 20 operations is refused", async () => {
	const ops = Array.from({ length: 21 }, () => ({ action: "patch" as const, name: "a-b", old_string: "x", new_string: "y" }));
	const result = await runOperations(deps, ops);
	assert.equal(result.success, false);
	assert.match(String(result.error), /20/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/skills-manage.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

```ts
export async function runOperations(deps: ManageDeps, operations: readonly Operation[]) {
	if (operations.length === 0) return { success: false, error: "no operations" };
	if (operations.length > MAX_BATCH_OPERATIONS) {
		return { success: false, error: `at most ${MAX_BATCH_OPERATIONS} operations per call` };
	}
	if (operations.some((op) => op.action === "delete") && operations.length > 1) {
		return { success: false, error: "delete must be the sole operation; compose with other ops' rollback" };
	}
	// 原子性快照：任一 touched skill 快照失败就整体中止（spec §8.3 第 1 条）。
	const snapshot = await snapshotTouched(deps, operations);
	if (!snapshot.ok) return { success: false, error: snapshot.error };
	// 审计账本的 before 快照：尽力而为，失败只是没有 before（spec §8.3 第 2 条）。
	// `captureBefore` 一次只取**一个**目录的清单，所以这里按 skill 逐个取、再合并成一个
	// before 清单交给 recordMutation（它本来就吃扁平的 `{path,sha256}[]`）。任一个取失败就
	// 整体放弃 before —— 宁可没有，也不要一份缺料的审计记录。
	const roots = [...new Set(operations.map((op) => join(deps.skillsRoot, op.name)))];
	const captured = await Promise.all(roots.map((root) => captureBefore(deps, root)));
	const before = captured.every((part) => part !== undefined) ? captured.flat() : undefined;
	const results: unknown[] = [];
	for (const [index, operation] of operations.entries()) {
		const outcome = await applyOne(deps, operation);
		if (!outcome.success) {
			const restored = await restoreSnapshot(deps, snapshot);
			return { success: false, results, failed_index: index, completed_before_failure: index, error: restored.ok ? outcome.error : `${outcome.error} (rollback failed: ${restored.error})` };
		}
		results.push(outcome.value);
	}
	await recordMutation(deps, { actor: deps.actor(), action: operations[0]!.action, skill: operations[0]!.name, evidence: {}, before, afterRoot: deps.skillsRoot });
	return { success: true, results };
}
```

`applyOne` 分发到 `createSkill` / `patchSkill` / `editSkill` / `deleteSkill` / `writeSkillFile` / `removeSkillFile`；`create` 成功后调 `recordCreated` 并按 Task 4 跑 linter 把结果挂到返回值；四个变更动作成功后调 `bumpPatch`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/skills-manage.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/skills/manage.ts test/skills-manage.test.ts
git commit -m "feat: skill_manage operations with atomic batches"
```

---

### Task 8: 管辖权与守卫

**Files:**
- Create: `src/skills/guards.ts`
- Modify: `src/skills/manage.ts`（把守卫接到 `applyOne` 的入口）
- Test: `test/skills-guards.test.ts`

**Interfaces:**
- Consumes: Task 2（usage 表）、Task 6、Task 7 的 `applyOne`
- Produces: `isCuratorManaged(record): boolean`；`backgroundWriteGuard(input: { reviewSession: boolean; record; pinned; action; skill; readSet: Set<string> }): { allow: true } | { allow: false; reason: string }`；`markRead(readSets: Map<string, Set<string>>, sessionId: string, skill: string): void`；`resetReadSet(readSets, sessionId): void`；并在 `ManageDeps` 上加 `guard(action, skill)` 字段、在 `applyOne` 入口调用它

- [ ] **Step 1: 写失败的测试**

```ts
test("an automatic review may not touch a skill the human created", () => {
	const verdict = backgroundWriteGuard({ reviewSession: true, record: { created_by: null, pinned: false }, pinned: false, action: "patch", skill: "a-b", readSet: new Set(["a-b"]) });
	assert.equal(verdict.allow, false);
	assert.match(verdict.allow === false ? verdict.reason : "", /not curator-managed/);
	assert.match(verdict.allow === false ? verdict.reason : "", /adopt/);
});

test("a pinned skill is refused even when managed", () => {
	const verdict = backgroundWriteGuard({ reviewSession: true, record: { created_by: "agent", pinned: true }, pinned: true, action: "patch", skill: "a-b", readSet: new Set(["a-b"]) });
	assert.equal(verdict.allow, false);
	assert.match(verdict.allow === false ? verdict.reason : "", /pinned/);
});

test("read-before-write applies only to the review and only to the target", () => {
	const managed = { created_by: "agent", pinned: false };
	const forgetful = backgroundWriteGuard({ reviewSession: true, record: managed, pinned: false, action: "patch", skill: "a-b", readSet: new Set() });
	assert.equal(forgetful.allow, false);
	assert.match(forgetful.allow === false ? forgetful.reason : "", /read/i);
	const foreground = backgroundWriteGuard({ reviewSession: false, record: { created_by: null, pinned: false }, pinned: false, action: "patch", skill: "a-b", readSet: new Set() });
	assert.equal(foreground.allow, true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/skills-guards.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

`isCuratorManaged(record) = record?.created_by === "agent"`。`backgroundWriteGuard` 对 `reviewSession === false` 直接放行（前台无此限制，与参考实现一致）；对 review 依次拒绝：pinned → 非托管（拒绝文案要给出 `adopt` 指引）→ 未读过（仅 `patch`/`edit`/`write_file`/`remove_file` 需要读标记）。`create` 不需要读标记。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/skills-guards.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 把守卫接进写路径（本任务的一部分，不是可选）**

`src/skills/manage.ts` 的 `applyOne` 入口调用守卫——**没有这一步，Task 7 的写入就是无守卫的**。
守卫经 `ManageDeps` 注入（`guard(action, skill)`），因为 `reviewSession`（这次调用是否来自本行起过的
review 子会话）与 `readSet`（Task 14 观察到的技能读取）都是宿主行的状态，`manage.ts` 不该知道
provenance 从哪来：

```ts
export interface ManageDeps extends LedgerDeps {
	// …既有：skillsRoot / usage / actor() / now()
	/** 管辖权与 read-before-write 的判定；由宿主行按调用方身份注入。 */
	guard(action: Operation["action"], skill: string): { allow: true } | { allow: false; reason: string };
}
```

```ts
	// applyOne 的第一件事：管辖权、pinned、read-before-write 三条都在这里判。
	const verdict = deps.guard(operation.action, operation.name);
	if (!verdict.allow) return { success: false, error: verdict.reason };
```

在 `test/skills-guards.test.ts` 补一条**穿过 `runOperations`** 的断言（证明接线存在，而不只是守卫函数正确）：

```ts
test("runOperations refuses an unmanaged skill for a review caller", async () => {
	const result = await runOperations(reviewDeps({ created_by: null }), [
		{ action: "patch", name: "a-b", old_string: "one", new_string: "two" },
	]);
	assert.equal(result.success, false);
	assert.match(String(result.error), /not curator-managed/);
});
```

Run: `node --test test/skills-guards.test.ts test/skills-manage.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/skills/guards.ts test/skills-guards.test.ts
git commit -m "feat: skill write guards and provenance jurisdiction"
```

---

### Task 9: 两层 SkillProvider

**Files:**
- Create: `src/skills/provider.ts`
- Test: `test/skills-provider.test.ts`

**Interfaces:**
- Consumes: Task 3（名字/解析）
- Produces: `createBuddyProvider(deps): SkillProvider`（只贡献 `visibility: buddy` 或缺失该字段的技能）；`createPromotedProvider(deps): SkillProvider`（只贡献 `visibility: global` 与 `visibility: project: <path>`，后者按 `options.cwd` 过滤）；provider 名分别为 `"buddy-skills"` 与 `"buddy-promoted"`

- [ ] **Step 1: 写失败的测试**

```ts
test("the buddy layer sees buddy-visibility skills and nothing else", async () => {
	await writeSkill("only-buddy", "visibility: buddy");
	await writeSkill("promoted", "visibility: global");
	await writeSkill("no-field", "");
	const names = (await createBuddyProvider(deps).list({})).map((c) => c.name).sort();
	assert.deepEqual(names, ["no-field", "only-buddy"]);
});

test("the promoted provider honours project scoping through cwd", async () => {
	await writeSkill("for-project", "visibility: project: /work/alpha");
	const provider = createPromotedProvider(deps);
	const inside = (await provider.list({ cwd: "/work/alpha/sub" })).map((c) => c.name);
	const outside = (await provider.list({ cwd: "/work/beta" })).map((c) => c.name);
	assert.deepEqual(inside, ["for-project"]);
	assert.deepEqual(outside, []);
});

test("a candidate is loadable and carries a directory resource base", async () => {
	const provider = createBuddyProvider(deps);
	const [candidate] = await provider.list({});
	const loaded = await provider.get(candidate!, {});
	assert.equal(loaded?.name, candidate!.name);
	assert.equal(loaded?.resourceBase?.kind, "directory");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/skills-provider.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

`list` 读 `<skillsRoot>/*/SKILL.md`（一层，不递归），**用 Task 3 的 `parseFrontmatter`**（不要引入 YAML 依赖——本包没有它）取 `visibility`，缺省为 `"buddy"`；**解析失败一律当作 `"buddy"` 且不抛**（读路径容忍，理由见 Task 3）。`rank` 用 `BUNDLED_SKILL_RANK` 之下的值（例如 `400`，与用户级一致）；`locator` 放绝对路径与目录名；`get` 重新读文件并返回 `content` 为**去掉 frontmatter 的正文**、`resourceBase: { kind: "directory", path: dirname }`。两个 provider 的差别只有可见性过滤与 `cwd` 判断。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/skills-provider.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/skills/provider.ts test/skills-provider.test.ts
git commit -m "feat: layered skill providers (buddy-only and human-promoted)"
```

---

### Task 10: preset 生成物语义

**Files:**
- Modify: `src/store/preset.ts`
- Modify: `CLAUDE.md:58`、`docs/superpowers/specs/2026-09-12-dsh-buddy-design.md` §5/§9
- Test: `test/preset-install.test.ts`（改写）

**Interfaces:**
- Consumes: 无
- Produces: `syncPreset(targetDir, templateDir): Promise<"installed" | "synced" | "kept" | "backed-up-synced">`、`GENERATED_MARKER = ".dsh-buddy-generated"`

- [ ] **Step 1: 改写测试为失败**

把断言 "kept" 的两个用例改成新语义，并补三条：

```ts
test("a fresh directory gets the template plus the generated marker", async () => {
	assert.equal(await syncPreset(target, await template()), "installed");
	assert.equal(existsSync(join(target, GENERATED_MARKER)), true);
});

test("a marked install is synced when the template moves on", async () => {
	// 订正（2026-09-14）：这一条原样写会把 "old\n" 覆盖到已安装文件上，而按标记里的「上次写出哈希」
	// 判定，那**就是**手改场景，应该得到 backed-up-synced —— 与下一条测试是同一件事。要让「模板前进
	// 而没人手改」可表达，唯一的办法是让 "old\n" 成为插件自己上次写出的内容，即在 install 之前把它
	// 写进模板。照抄时务必保留这个顺序，否则"永远备份"这种 bug 也能全绿。
	await writeFile(await templateFile("agent.cordis.yml"), "old\n");
	await syncPreset(target, await template());
	await writeFile(await templateFile("agent.cordis.yml"), "new\n");
	assert.equal(await syncPreset(target, await template()), "synced");
	assert.equal(await readFile(join(target, "agent.cordis.yml"), "utf8"), "new\n");
});

test("an unmarked directory belongs to the user and is never touched", async () => {
	await mkdir(target, { recursive: true });
	await writeFile(join(target, "agent.cordis.yml"), "mine\n");
	assert.equal(await syncPreset(target, await template()), "kept");
	assert.equal(await readFile(join(target, "agent.cordis.yml"), "utf8"), "mine\n");
});

test("a hand-edited marked install is backed up before being overwritten", async () => {
	await syncPreset(target, await template());
	await writeFile(join(target, "agent.cordis.yml"), "hand edited\n");
	await writeFile(await templateFile("agent.cordis.yml"), "new\n");
	assert.equal(await syncPreset(target, await template()), "backed-up-synced");
	assert.equal(await readFile(join(target, "agent.cordis.yml.bak"), "utf8"), "hand edited\n");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/preset-install.test.ts`
Expected: FAIL — `syncPreset` 未导出

- [ ] **Step 3: 实现**

`syncPreset` 的判定顺序（spec §5.2）：目录不存在 → 写模板 + 标记，返回 `installed`；有标记 → 逐个文件比较，内容相同返回 `kept`、不同则（若现有内容与模板不同且不是我们上次写的 → 先写 `.bak`）覆盖并返回 `synced` / `backed-up-synced`；无标记 → 返回 `kept`。同时改 `src/store/index.ts:268` 的调用点为 `syncPreset(...)`（日志文案与 `.catch` 保持既有形状）。

文档改写要精确：`CLAUDE.md:58` 那条不变量换成"buddy preset 是插件生成物"，并写明"要自定义接线请复制成新 id"；设计文档 §5/§9 同步。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/preset-install.test.ts test/preset.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/store/preset.ts src/store/index.ts test/preset-install.test.ts CLAUDE.md docs/superpowers/specs/2026-09-12-dsh-buddy-design.md
git commit -m "feat: the buddy preset becomes a generated artifact with a guarded sync"
```

---

### Task 11: digest 与提示词

**Files:**
- Create: `src/skills/digest.ts`, `src/skills/prompt.ts`
- Test: `test/skills-digest.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `digestHistory(messages: readonly DigestMessage[]): DigestMessage[]`；`SKILL_REVIEW_PROMPT: string`、`REVIEW_TOOL_CLAUSE: string`、`REFINE_FOCUS_SUFFIX: (focus: string) => string`；`DigestMessage = { role: "user" | "assistant" | "tool"; text: string; toolNames?: readonly string[] }`

> **订正（2026-09-14）：** 上面 Produces 原先把 `REFINE_FOCUS_SUFFIX` 列成 `string`，与下方 Step 3 的
> 代码块自相矛盾——后缀里要插用户 `/refine <focus>` 的原文，不可能是常量。以 Step 3 的函数形式为准。
> 提示词是**按 DSH 词汇改写**，不是逐字照抄 Hermes 原文：`skill_view`/`skills_list` 换成 DSH 的 `skill`
> 加载器（§7.3），`bundled`/`hub`/`external_dirs` 那几个受保护类别在 Buddy 场景不存在（§8.4），
> `hermes curator adopt` 换成面板的 `adopt`（§8.5），`execute_code` 换成 shell 工具。

- [ ] **Step 1: 写失败的测试**

```ts
test("a short history is returned unchanged", () => {
	const short = Array.from({ length: 24 }, (_, i) => message("user", `m${i}`));
	assert.deepEqual(digestHistory(short), short);
});

test("the kept tail never starts on a tool result", () => {
	const messages = [
		...Array.from({ length: 35 }, (_, i) => message("user", `old${i}`)),
		message("tool", "result"),
		message("assistant", "answer", ["read"]),
	];
	const out = digestHistory(messages);
	assert.notEqual(out[1]!.role, "tool"); // out[0] 是合成摘要
});

test("older turns collapse into ONE synthetic user message with the exact truncations", () => {
	const longUser = "u".repeat(400);
	const messages = [...Array.from({ length: 30 }, (_, i) => message("user", `${longUser}${i}`)), ...Array.from({ length: 24 }, () => message("assistant", "recent"))];
	const out = digestHistory(messages);
	assert.equal(out.length, 25);
	assert.equal(out[0]!.role, "user");
	assert.match(out[0]!.text, /^\[Earlier conversation digest/);
	assert.ok(out[0]!.text.includes(`USER: ${"u".repeat(300)}`));
	assert.ok(!out[0]!.text.includes("u".repeat(301)));
});

test("tool results are dropped from the digest", () => {
	const messages = [...Array.from({ length: 30 }, (_, i) => message("tool", `dropped${i}`)), ...Array.from({ length: 24 }, () => message("assistant", "recent"))];
	assert.ok(!digestHistory(messages)[0]!.text.includes("dropped"));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/skills-digest.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

`digestHistory` 严格按 spec §7.1：`tail = 24`；`while (messages.length > tail && messages[messages.length - tail]!.role === "tool") tail += 1`；若 `messages.length <= tail` 原样返回；否则合成一条 user 消息（前缀文本照抄参考实现）拼上被保留的尾段。每条更早的消息：`user → USER: {text.slice(0,300)}`、assistant 有工具名时 `ASSISTANT[tools: ${names.join(", ")}]` 且有正文时再追加 `ASSISTANT: {text.slice(0,200)}`，换行替换成空格，`tool` 直接跳过。

`prompt.ts` 放 skill-only 的审查提示词（移植参考实现的 `_SKILL_REVIEW_PROMPT` + `_LESSON_LAYER_BLOCK` + `_DO_NOT_CAPTURE_BLOCK` 语义）、白名单说明句、以及 `/refine` 的 focus 后缀：

```ts
export const REVIEW_TOOL_CLAUSE =
	"\n\nYou can only call skill management tools. Other tools will be denied at runtime — do not attempt them.";
export const REFINE_FOCUS_SUFFIX = (focus: string): string =>
	`\n\nThe user explicitly requested this review with the following focus — prioritize it over the general instructions above:\n${focus}`;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/skills-digest.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/skills/digest.ts src/skills/prompt.ts test/skills-digest.test.ts
git commit -m "feat: review digest algorithm and prompts"
```

---

### Task 12: review 编排

**Files:**
- Create: `src/skills/review.ts`
- Test: `test/skills-review.test.ts`

**Interfaces:**
- Consumes: Task 11、Task 2（`review_usage` 表）、Task 1 settings
- Produces: `class ReviewCoordinator`，方法 `noteStep(sessionId): void`、`noteSkillManageCalled(sessionId): void`、`onTurnEnd(input: { sessionId; reason; origin?; delegationDepth?; surface? }): Promise<void>`、`noteChildEvent(childSessionId, event): void`，构造参数 `{ config(); spawn(input: { provider: "fork" | "spawn"; prompt: string; toolFilter: readonly string[] }): { childSessionId: string; done: Promise<unknown> }; interrupt(childSessionId): void; now(); log(line) }`

> **订正（2026-09-14）：** `onTurnEnd` 的入参原先漏了 `surface`（本会话的转录面，Task 11 digest 的原料，
> 即 `ctx.sessionQuery.readSurface(sessionId)` 的产物）。便宜模型那条路径必须有它才能拼 digest，而
> 便宜模型路径不可能自己去取转录（协调器不该知道 `sessionQuery`）。`surface` 由宿主行按需传入；
> fork 路径不需要它。

- [ ] **Step 1: 写失败的测试**

```ts
test("the nudge counts steps and fires only on a completed turn", async () => {
	const coordinator = makeCoordinator();
	for (let i = 0; i < 10; i += 1) coordinator.noteStep("s1");
	await coordinator.onTurnEnd({ sessionId: "s1", reason: { kind: "completed" } });
	assert.equal(spawned.length, 1);
	assert.equal(spawned[0]!.provider, "fork");
});

test("an aborted turn never fires, and 9 steps is not enough", async () => {
	const coordinator = makeCoordinator();
	for (let i = 0; i < 10; i += 1) coordinator.noteStep("s1");
	await coordinator.onTurnEnd({ sessionId: "s1", reason: { kind: "aborted" } });
	assert.equal(spawned.length, 0);
	const other = makeCoordinator();
	for (let i = 0; i < 9; i += 1) other.noteStep("s2");
	await other.onTurnEnd({ sessionId: "s2", reason: { kind: "completed" } });
	assert.equal(spawned.length, 0);
});

test("calling skill_manage resets the counter", async () => {
	const coordinator = makeCoordinator();
	for (let i = 0; i < 9; i += 1) coordinator.noteStep("s1");
	coordinator.noteSkillManageCalled("s1");
	await coordinator.onTurnEnd({ sessionId: "s1", reason: { kind: "completed" } });
	assert.equal(spawned.length, 0);
});

test("a delegated session never triggers, and a session with a review in flight is dropped", async () => {
	const coordinator = makeCoordinator();
	for (let i = 0; i < 10; i += 1) coordinator.noteStep("sub");
	await coordinator.onTurnEnd({ sessionId: "sub", reason: { kind: "completed" }, origin: "subagent" });
	assert.equal(spawned.length, 0);
	for (let i = 0; i < 10; i += 1) coordinator.noteStep("s1");
	slowSpawn = true;
	void coordinator.onTurnEnd({ sessionId: "s1", reason: { kind: "completed" } });
	await coordinator.onTurnEnd({ sessionId: "s1", reason: { kind: "completed" } });
	assert.equal(spawned.length, 1);
});

test("a cheap-model review spawns instead of forking and carries the digest", async () => {
	const coordinator = makeCoordinator({ reviewProvider: "cliproxyapi", reviewModel: "cheap" });
	for (let i = 0; i < 10; i += 1) coordinator.noteStep("s1");
	await coordinator.onTurnEnd({ sessionId: "s1", reason: { kind: "completed" }, surface: manyMessages() });
	assert.equal(spawned[0]!.provider, "spawn");
	assert.match(spawned[0]!.prompt, /Earlier conversation digest/);
});

test("the review stops at the step budget and at the token budget", async () => {
	const coordinator = makeCoordinator();
	startReview(coordinator);
	for (let i = 0; i < 16; i += 1) coordinator.noteChildEvent("child", { type: "step/end" });
	assert.equal(interrupted, "child");
	const tokens = makeCoordinator({ maxInputTokens: 1000 });
	startReview(tokens);
	tokens.noteChildEvent("child2", { type: "assistant/message", usage: { inputTokens: 1001, cacheReadTokens: 900 } });
	assert.equal(interrupted, "child2");
});

test("usage is attributed to the parent session in a finally, even on failure", async () => {
	// spawn 返回一个立刻 reject 的结果，用量仍必须落到 reviewUsage
	await expectFailurePath();
	assert.equal(reviewUsage.length, 1);
	assert.equal(reviewUsage[0]!.parentSessionId, "s1");
	assert.equal(reviewUsage[0]!.cacheReadTokens, 900);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/skills-review.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

`ReviewCoordinator` 的规则（spec §6、§7.4、§9.2）：

- `noteStep` 只对 `config().skills.enabled` 为真的会话累加；`noteSkillManageCalled` 清零。
- `onTurnEnd` 判定链：`origin === "subagent"` 或 `delegationDepth > 0` → 返回；`reason.kind !== "completed"` → 返回；计数不足 → 返回；该会话已有在跑 → 丢弃。命中即清零并起 review。
- 起 review：`reviewProvider && reviewModel && (provider, model) !== 父路由` → `spawn` + digest + 提示词；否则 `fork` + 提示词。两者都传 `toolFilter` 白名单 `["skill", "skill_manage", "read", "grep", "glob"]`。
- `noteChildEvent`：`step/end` 累加步数；`assistant/message` 累加 `usage.inputTokens`（并记 `cacheReadTokens`/`cacheWriteTokens`/`outputTokens`）；任一超预算 → `interrupt(childSessionId)`。
- 结束时（成功/失败/取消都算）在 `finally` 里写 `review_usage` 表，并打一行形如 `"Background review complete: calls=%d in=%d out=%d cache_read=%d result=%s"` 的日志。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/skills-review.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/skills/review.ts test/skills-review.test.ts
git commit -m "feat: the post-turn skill review coordinator"
```

---

### Task 13: host 行装配与端点

**Files:**
- Create: `src/skills/index.ts`, `src/skills/gateway.ts`
- Test: `test/skills-mount.test.ts`

**Interfaces:**
- Consumes: Task 2、5、6、7、9、12
- Produces: `ctx.buddySkills`（含 `noteStep`、`noteSkillManageCalled`、`onTurnEnd`、`noteChildEvent`、`noteAgentRowMounted()`、`presetSynced()`、`refine(agent, focus)`、`manage()`、`usage()`、`rollback()`、`adopt()`、`setPinned()`、`setVisibility()`、`listSkills()`）；typert 端点 `buddySkills/list|manage|rollback|adopt|pin|visibility|reviewUsage`

- [ ] **Step 1: 写失败的测试**

仿 `test/mount.test.ts` 用真 cordis 挂载：

```ts
test("the skills row mounts on the store and publishes ctx.buddySkills", async () => {
	await mountSkills({ withStore: true });
	assert.equal(typeof service.onTurnEnd, "function");
	assert.equal(typeof service.manage, "function");
});

test("without the store the row waits instead of throwing", async () => {
	const failure = await mountSkills({ withStore: false });
	assert.equal(failure.mounted, false); // inject 未满足 → 行处于等待
});

test("the agent row's heartbeat is what clears the not-synced notice", async () => {
	await mountSkills({ withStore: true });
	assert.equal(await service.presetSynced(), false);
	service.noteAgentRowMounted();
	assert.equal(await service.presetSynced(), true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/skills-mount.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

`src/skills/index.ts`：

```ts
export const name = "dsh-buddy-skills";
/** 硬依赖：技能根、三张领域表、settings 全部经由 store 行。 */
export const inject = ["buddyStore"];

export function apply(ctx: PluginContext): void {
	// 一切贡献走 effect：服务注销、监听器、定时器都随 fiber 一起消失。
	ctx.effect(() => {
		const coordinator = new ReviewCoordinator(/* deps 全部来自 ctx.buddyStore 与 ctx.get(...) */);
		new BuddySkillsService(ctx, coordinator, /* … */);
		return () => coordinator.dispose();
	});
}
```

`ReviewCoordinator` 的 `spawn`/`interrupt` 依赖由行内注入：`spawn` 用 `ctx.get("subagents")`（软依赖，缺失时 review 直接跳过并记一行日志）；`interrupt` 同理。**硬依赖只有 `buddyStore`**，与既有两个行一致。

`gateway.ts` 照 `src/persona/gateway.ts` 的形状（`ctx.typert.register(...)`，绝不使用 `@Remote` 装饰器），端点只读叶子字段构造自己的小对象。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/skills-mount.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/skills/index.ts src/skills/gateway.ts test/skills-mount.test.ts
git commit -m "feat: the buddy-skills host row and its panel endpoints"
```

---

### Task 14: preset 行装配

**Files:**
- Create: `src/skills-agent/index.ts`
- Test: `test/skills-agent.test.ts`

**Interfaces:**
- Consumes: Task 8、9、13 的 `ctx.buddySkills`
- Produces: 一个 preset 行：注册 provider（buddy 层）、`skill_manage` 工具、`session/event` 与 `tools/post-execute` 监听器、`refine` 命令，并调用 `ctx.buddySkills.noteAgentRowMounted()`

- [ ] **Step 1: 写失败的测试**

```ts
test("the agent row registers a buddy-layer provider and the tool into the calling scope", async () => {
	const scope = await mountAgentRow({ withSkillsPlane: true });
	assert.deepEqual(providerNames(scope), ["buddy-skills"]);
	assert.ok(toolNames(scope).includes("skill_manage"));
	assert.deepEqual(commandNames(scope), ["refine"]);
});

test("step and turn events drive the coordinator through the host service", async () => {
	const scope = await mountAgentRow({ withSkillsPlane: true });
	emitSessionEvent(scope, "s1", { type: "step/end", seq: 1, time: 1, data: {} });
	emitSessionEvent(scope, "s1", { type: "turn/end", seq: 2, time: 2, data: { turn: 1, reason: { kind: "completed" } } });
	assert.equal(callsTo("onTurnEnd"), 1);
	assert.equal(callsTo("noteStep"), 1);
});

test("observing the skill loader bumps use and records a read mark", async () => {
	const scope = await mountAgentRow({ withSkillsPlane: true });
	await emitPostExecute(scope, { name: "skill", arguments: { name: "a-b" }, agent: { id: "s1" } });
	assert.deepEqual(callsTo("bumpUse"), ["a-b"]);
	assert.deepEqual(callsTo("markRead"), ["s1:a-b"]);
});

test("the tool resets the nudge counter and routes writes through the service", async () => {
	const scope = await mountAgentRow({ withSkillsPlane: true });
	await callTool(scope, "skill_manage", { operations: [{ action: "create", name: "x-y", content: "…" }] }, { id: "s1" });
	assert.deepEqual(callsTo("noteSkillManageCalled"), ["s1"]);
	assert.equal(callsTo("manage"), 1);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/skills-agent.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

```ts
export const name = "dsh-buddy-skills-agent";
/** 软依赖：宿主服务缺失时整行退化为"什么都不注册"，不阻塞 preset 挂载。 */
// 不导出 inject：preset 行必须能在 skills 宿主行缺席时仍然挂载。
```

要点：

- provider 用 `ctx.skills.registerProvider(...)`（**从 preset 行的 ctx 调用才会落进 buddy 层**），并从 `ctx.get("buddySkills")` 取技能根；宿主服务缺席时不注册。
- 工具用 `ctx.tools.register(defineTool({...}))`，`execute(args, exec)` 里先 `ctx.buddySkills.noteSkillManageCalled(exec.agent?.id)` 再转给 `manage()`；`exec.agent` 缺失时拒绝（review 之外没有 agent 的调用不可信）。
- `session/event` 监听器只做转发（`step/end` → `noteStep`；`turn/end` → `onTurnEnd`），并带上 `session.header.origin` 与 `delegationDepth`。
- `tools/post-execute` 监听器只处理 `exec.name === "skill"`：取 `exec.arguments.name`，调 `bumpUse` + `markRead(sessionId, skill)`。
- `commands.register({ name: "refine", description: "...", handler })` → `ctx.buddySkills.refine(invocation.agent, focus)`。
- 挂载时调 `ctx.buddySkills.noteAgentRowMounted()`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/skills-agent.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/skills-agent/index.ts test/skills-agent.test.ts
git commit -m "feat: the buddy preset skills row (provider, tool, listeners, refine)"
```

---

### Task 15: 隔离证明

**Files:**
- Test: `test/skills-isolation.test.ts`

**Interfaces:**
- Consumes: Task 14
- Produces: 无（只有测试）

- [ ] **Step 1: 写失败的测试**

在一个真 cordis app 里建两个 scope：一个装 skills-agent 行（模拟 buddy preset），一个不装（模拟普通编码会话），然后断言：

```ts
test("a skill registered in the buddy layer is invisible to another scope", async () => {
	const app = await twoScopes();
	await writeSkill(app.skillsRoot, "buddy-only", "visibility: buddy");
	assert.deepEqual(await skillNames(app.buddyScope), ["buddy-only"]);
	assert.deepEqual(await skillNames(app.codingScope), []);
});

test("skill_manage is not in another scope's tool catalog", async () => {
	const app = await twoScopes();
	assert.ok((await toolSchemas(app.buddyScope)).some((t) => t.name === "skill_manage"));
	assert.ok(!(await toolSchemas(app.codingScope)).some((t) => t.name === "skill_manage"));
});

test("skills on disk are not picked up by the deployment's default roots", async () => {
	// 技能根不能落在 <cwd>/.dsh/skills 或 ~/.agents/skills 之下
	assert.ok(!app.skillsRoot.includes(join(".dsh", "skills")));
	assert.ok(!app.skillsRoot.includes(join(".agents", "skills")));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/skills-isolation.test.ts`
Expected: FAIL — 第二个 scope 也能看到（说明注册位置不对）

- [ ] **Step 3: 让测试通过**

若 buddy scope 可见而 coding scope 不可见，测试即通过——**这一步不需要改产品代码**；若两个 scope 都能看到，说明 provider 是从宿主行注册的，回到 Task 14 修正注册位置。这是一条**证明性测试**，它的价值在于把"隔离"从设计意图变成可执行的断言。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/skills-isolation.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add test/skills-isolation.test.ts
git commit -m "test: prove buddy-layer skill isolation across scopes"
```

---

### Task 16: 幽灵会话过滤

**Files:**
- Modify: `src/persona/index.ts`（`listSessions` 的过滤条件）
- Test: `test/persona.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `listSessions` 排除 `header.origin === "subagent"`

- [ ] **Step 1: 写失败的测试**

```ts
test("a review child session never appears in the buddy conversation list", async () => {
	const sessions = [
		{ header: { id: "s1", agentPreset: BUDDY_PRESET_ID } },
		{ header: { id: "review-child", agentPreset: BUDDY_PRESET_ID, origin: "subagent" } },
	];
	const listed = await mountAndList({ sessions });
	assert.deepEqual(listed.map((s) => s.sessionId), ["s1"]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/persona.test.ts`
Expected: FAIL — 两个 id 都在列表里

- [ ] **Step 3: 实现**

`src/persona/index.ts:147-149` 的过滤条件加一项：

```ts
		const mine = records.filter(
			(record) =>
				record.header.agentPreset === BUDDY_PRESET_ID &&
				// 后台总结跑的是真子会话，且会继承 agentPreset='buddy'；不过滤就会每次总结
				// 都在 Buddy 文件夹里留一条幽灵对话。
				record.header.origin !== "subagent" &&
				!archived.has(record.header.id),
		);
```

`SessionStub` 的类型要加上 `origin?: string`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/persona.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/persona/index.ts test/persona.test.ts
git commit -m "fix: keep review child sessions out of the buddy conversation list"
```

---

### Task 17: 面板 Skills 模块

**Files:**
- Create: `src/client/skills-module.tsx`
- Modify: `src/client/modules.ts`, `src/index.ts`（`PANEL_SECTION_IDS`）, `src/config.ts`（`panel.sections.skills`）
- Test: `test/client-panel.test.ts`、`test/client-ui.test.ts`

**Interfaces:**
- Consumes: Task 13 的 `buddySkills/*` 端点
- Produces: `SkillsModule` React 组件；`PANEL_SECTION_IDS = ["soul", "agents", "skills", "model", "telegram"]`

- [ ] **Step 1: 写失败的测试**

```ts
test("the skills module appears in the panel and can be hidden", () => {
	const shown = visibleModules(MODULES, { soul: true, agents: true, skills: true, model: true, telegram: true });
	assert.deepEqual(shown.map((m) => m.id), ["soul", "agents", "skills", "model", "telegram"]);
	const hidden = visibleModules(MODULES, { skills: false });
	assert.ok(!hidden.some((m) => m.id === "skills"));
});

test("the built client renders the skills module without calling it as a function", () => {
	const html = renderPanel({ active: "skills" });
	assert.match(html, /data-module="skills"/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run build && node --test test/client-panel.test.ts`
Expected: FAIL — 没有 skills 模块

- [ ] **Step 3: 实现**

`skills-module.tsx` 用既有的 primitives（`Button` / `Switch` / `Input`）与 `src/client/form-css.ts` 的类样式，**不写内联 style**，**不调用组件函数**（必须以 `<SkillsModule />` 形式渲染）。内容：技能列表（名字、描述、用量、最后使用、pinned、是否托管）、pin/unpin 按钮、adopt 按钮、提升可见性按钮、回滚入口（账本列表 + 一键回滚）、review 总开关（读写 `buddy.skills.enabled`）。

`modules.ts` 的模块表加一行；**`order` 必须是"排在 agents 之后、model 之前"的那个数**——先读 `src/client/modules.ts` / `panel.tsx` 里既有模块的 `order` 值再定，不要照抄下面这个字面量（`20` 是占位猜测）：

```ts
{ id: "skills", order: 20, titleKey: "module.skills", Component: SkillsModule }
```

`config.ts` 的 `panel.sections` schema 加 `skills: z.boolean().default(true)`；`FALLBACK_CONFIG.panel.sections` 同步加 `skills: true`。**注意**：Task 1 已经在同一个 `config.ts` 里加了顶层 `skills` 设置段——本任务只动 `panel.sections`，不要重构或覆盖 Task 1 的段。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run build && node --test test/client-panel.test.ts test/client-ui.test.ts test/config.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/client/skills-module.tsx src/client/modules.ts src/index.ts src/config.ts test/client-panel.test.ts
git commit -m "feat: the Skills module in the buddy main panel"
```

---

### Task 18: 接线（补丁 / 构建 / 清单 / preset 模板）与真机验收

**Files:**
- Modify: `cordis.patch.yml`, `build.mjs`, `package.json`, `assets/preset/agent.cordis.yml`
- Test: `test/patch.test.ts`, `test/preset.test.ts`

**Interfaces:**
- Consumes: Task 13、14、10
- Produces: 两行进入各自组合；`./skills` 与 `./skills-agent` 两个导出

- [ ] **Step 1: 写失败的测试**

```ts
test("the patch mounts the buddy-skills host row", () => {
	assert.ok(rowNames().includes("dsh-buddy/skills"));
});

test("the shipped preset carries the agent row and the generated-artifact notice", () => {
	const preset = readFileSync(join(ROOT, "assets", "preset", "agent.cordis.yml"), "utf8");
	assert.match(preset, /name: 'dsh-buddy\/skills-agent'/);
	assert.match(preset, /generated/i);
});

test("both subpath exports resolve", () => {
	const exports = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).exports;
	assert.ok(exports["./skills"] && exports["./skills-agent"]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/patch.test.ts test/preset.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

- `cordis.patch.yml` 的 `insert` 列表加 `- { id: buddy-skills, name: 'dsh-buddy/skills', config: {} }`（放在 `buddy-persona` 之后，因为都依赖 store）。
- `package.json` 的 `exports` 加 `"./skills"` 与 `"./skills-agent"`。
- `build.mjs` 的 `hostEntries` 加 `["src/skills/index.ts", "lib/skills.js"]` 与 `["src/skills-agent/index.ts", "lib/skills-agent.js"]`。
- `assets/preset/agent.cordis.yml`：文件头加生成物声明（这份文件由 dsh-buddy 生成、升级按插件版本重写；改人格去 `SOUL.md`、改规则去 `AGENTS.md`、改开关用 Buddy 面板；要自定义接线请用 GUI 的"复制预设"复制成新 id），并在 skills 段末尾加：

```yaml
# 技能自动进化：provider / skill_manage / 事件监听都注册进 THIS preset 的层，
# 因此自动总结出来的技能对普通编码会话结构上不可见（见第 3 期设计文档 §4）。
- id: buddy-skills-agent
  name: 'dsh-buddy/skills-agent'
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run check`
Expected: PASS（typecheck + build + 全部测试）

- [ ] **Step 5: 真机验收（隔离 probe profile）**

按 `CLAUDE.md` 的配方起隔离实例（`DSH_HOME=/tmp/dsh-probe ... --port 3099`），逐条跑 spec §13.2 的 9 条验收，重点是：**编码会话的技能列表里没有自动总结出来的技能、工具列表里没有 `skill_manage`**；review 的 16 步与 60 万 token 都进日志；`cache_read` > 0。验完 `find ~/.dsh -newermt '<probe start>'` 必须为空。

- [ ] **Step 6: 提交**

```bash
git add cordis.patch.yml build.mjs package.json assets/preset/agent.cordis.yml test/patch.test.ts test/preset.test.ts
git commit -m "feat: wire the skills rows into the host composition and the buddy preset"
```

---

## Self-Review

**Spec coverage：** §3 两个行 → Task 13/14/18；§4 三层隔离 → Task 9/14/15 + Task 1 的路径断言；§5 preset 归属 → Task 10；§6 触发 → Task 12/14；§7 输入与预算 → Task 11/12；§8 写路径（校验/linter/快照账本回滚/管辖权/adopt/审批）→ Task 3-8（`writeApproval` 在 Task 7 的 `applyOne` 入口判定，按 §8.6 走暂存而非落盘）；§9 遥测与面板 → Task 2/6/12/17；§10 失败处理 → Task 5/7/12；§11 偏差 → 由 Task 3（名字语法）、Task 5（两种快照）、Task 12（不排队/不抢断）落实；§12 3b → 本期不做，仅 Task 2 已建字段；§13 测试 → Task 15 + Task 18 Step 5。

**Placeholder scan：** 无 TBD/TODO/占位断言；每个代码步骤都给了可直接落地的代码，或给出明确的移植源（`$H` 行号 + 规则名/常量值）。自检中发现并已修掉的两处：(1) Task 2 的测试原先引用 Task 6 才定义的 `emptyUsageRecord`（顺序倒置）→ 已把该构造函数移到 Task 2 的 `domain.ts`，Task 6 改为 import；(2) Task 3 曾留一条示意断言 → 已删除，只保留真实断言。

**Type consistency：** `SkillUsageRecord`/`SkillLedgerRecord`/`ReviewUsageRecord`（Task 2）↔ 访问器命名（Task 5/6/12）；`runOperations` 的返回形状（Task 7）↔ 工具返回值（Task 14）↔ 面板展示（Task 17）；`ReviewCoordinator` 的方法名（Task 12）↔ 监听器调用（Task 14）↔ `ctx.buddySkills` 的转发（Task 13）三处一致；`GENERATED_MARKER`（Task 10）↔ 验收（Task 18 的 preset 断言）。
