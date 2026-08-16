# Mem0 提取策略定制与 FishMem 受治理信念：关系、差距与取舍

日期：2026-08-16  
FishMem 基线：`962294e58a8c4664f88da9d640eead7cdd7aa639`

## 结论

**有关系，但不是同一个功能。**

- Mem0 截图里的功能是 **写入前的提取策略控制面**：决定从对话中记什么、不记什么、记多细，以及给新记忆打什么业务分类。
- FishMem 今天新增的 governed belief reconciliation 是 **写入后的证据治理投影**：规范记忆已经生成后，再判断反复出现或相互冲突的推断偏好是否达到 `supported`，否则保持 `contested`，并保留来源与审计链。
- 两者是上下游关系：提取策略决定 belief 能看到哪些规范事实；belief reconciliation 决定这些推断事实是否值得采信。**应共享项目作用域、版本、审批和审计基础设施，但不能共享一套开关或阈值。**

FishMem 应该借鉴 Mem0 的产品化入口，并补齐实际执行链；不应照搬一个自由文本 prompt 表单，也不应把“50 条记忆”当成质量充分条件。

```text
原始对话
  ↓
[提取策略：include / exclude / detail / examples]   ← Mem0 截图功能
  ↓
单次 canonical extraction
  ↓
规范记忆 ──→ 业务 categories
  ↓
[evidence competition / applicability / audit]      ← FishMem 今日功能
  ↓
supported / contested / superseded belief view
```

## 证据边界

### 1. 截图可以确认的产品事实

以下只来自用户提供的五张截图，不视为 Mem0 公开技术协议：

- Memory Extraction 有两条入口：
  - 从既有数据起草：读取“用户实际说了什么”，与已提取结果比较，提出改进 instructions；页面要求项目已有 `50+ memories`。
  - 回答问卷：由答案生成 instructions。
- 问卷字段至少包括：`Keep memories about`、`Never store`、`High level / Balanced / Detailed`、每条 instruction 的示例，以及自由补充。
- 横幅声称还会建议 categories，并明确写着“anything changes 前由用户 approve”。
- 另一个 Dream 页面把后台整理表达为 Synthesis、Supersede、Merge；它与 Memory Extraction 设置页是两个产品入口。

截图没有公开：抽样协议、使用的模型、提示词、离线指标、是否重处理旧记忆、50 的统计依据、失败回滚方式或对应 API。因此这些部分不能从 UI 文案反推出实现。

### 2. Mem0 官方资料可以确认的事实

- `custom_instructions` 是项目级自然语言 include/exclude 规则，作用在“从 conversation 创建 memories”的提取阶段；官方同时提供单独的 `agent_custom_instructions`，说明 user 与 agent 的提取规则可能不同。[Mem0 Custom Instructions](https://docs.mem0.ai/platform/features/custom-instructions)
- Mem0 官方建议使用真实样本测试 instructions；OSS 文档还明确建议正反 few-shot、严格 `facts` JSON、版本化 prompt 并保留快速回滚能力。[Mem0 OSS Custom Instructions](https://docs.mem0.ai/open-source/features/custom-instructions)
- custom categories 是自动分配给记忆的业务标签，定义可以来自项目或单次 add；分类器依据 category 的名称/描述判断，新记忆响应中有独立 `categories` 字段。[Mem0 Custom Categories](https://docs.mem0.ai/platform/features/custom-categories)
- V3 add 接受 messages、scope、`infer`、metadata 与 `custom_instructions`，并异步返回 event id；`infer:false` 跳过 extraction。[Mem0 Add Memories API](https://docs.mem0.ai/api-reference/memory/add-memories)
- Mem0 当前公开 V3 文档描述的是 single-pass、ADD-only extraction；“Dream”的 Synthesis/Supersede/Merge 不应被当成 add API 的同义词。[Mem0 V3 migration guide](https://docs.mem0.ai/migration/platform-v2-to-v3)；Dream 的公开描述见 [Mem0 OpenClaw integration](https://docs.mem0.ai/integrations/openclaw)

### 3. 本报告的推断

- “从既有数据起草”最合理的产品价值是找出漏记、误记、分类不清等系统性模式，而不是让模型自由改写生产 prompt。
- 50 条 canonical memory 可能来自很少的 add 请求，也可能只覆盖一个用户或一个话题；因此它只能是 CTA 的粗粒度门槛，不能证明样本多样性或新策略更好。
- 任何读取原始用户话术的建议器都会扩大数据使用范围。FishMem 若实现，必须把授权、采样范围、脱敏、保留期限和审计记录设计成显式协议。

## FishMem 当前映射

| Mem0 能力 | FishMem 当前状态 | 判断 |
| --- | --- | --- |
| 项目级 instructions | `project_settings.instructions` 已落库并有 GET/PATCH 与 Dashboard 文本框 | **只有控制面外壳，未接执行链** |
| Include / exclude | 内置 selective candidate prompt 有 veto、provenance、durability 等规则；项目设置只有自由文本 | **部分内核存在，但项目配置不生效** |
| User / agent 分离规则 | 记忆作用域支持 user/agent/run，但项目 settings 只有一份 instructions | **缺失** |
| Detail level | 无结构化字段 | **缺失** |
| 正反 examples | core 可整段替换 extraction prompt，但没有项目级结构化 examples | **缺失** |
| Category catalog | `project_settings.categories: string[]` 与 PATCH 已存在 | **存储存在，自动分类缺失** |
| Categories UI | 当前 Settings 页面只加载、编辑和保存 instructions | **缺失** |
| 从历史数据生成建议 | 无 sample analyzer、proposal、review 或 approval API | **缺失** |
| Draft / active / history / rollback | PATCH 直接覆盖当前值 | **缺失** |
| Preview / paired eval | benchmark 基础设施存在，但无项目策略 preview/gate | **缺失** |
| Supersede 推断偏好 | `BeliefReconciler` 有 supported/contested/superseded、独立 evidence/context、applicability 与 audit | **今日已实现，但仅 shadow projection** |
| Merge / maintenance | core 有 scope-fenced near-duplicate consolidation 和可选 MDL merge | **有内核，不等同于截图产品或默认常驻服务** |

### 关键代码事实

1. [`project_settings`](../../apps/web/db/schema.ts#L224-L253) 确实保存 `instructions` 和 `categories`；[`/api/project-settings`](../../apps/web/lib/server/app-api.ts#L977-L1046) 允许读取和直接覆盖两者。
2. Dashboard 的 [`Settings → Instructions`](../../apps/web/components/dashboard/settings-page.tsx#L266-L294) 只渲染 instructions；组件只维护 `instructions` state，也只提交 `{ instructions }`。categories 目前没有用户可见编辑器。
3. 全仓调用点审计显示 `projectSettings` 只在设置 API 中读取；公共 memory add / worker / engine 创建路径没有读取它。因此页面上的“Guidance the engine follows”在当前 commit 中不是事实上的执行保证。
4. Core 只提供一个实例级 [`customFactExtractionPrompt`](../../packages/fishmem/src/config.ts#L245-L256)，并在 [`extractFacts`](../../packages/fishmem/src/memory.ts#L3854-L3872) 中优先用它替换系统 prompt。这不是 workspace 动态配置，也没有 revision、审批或回滚。
5. 当前公共 [`AddMemoryCommandSchema`](../../packages/contracts/src/index.ts#L395-L418) 不接受 `custom_instructions`、policy revision 或 categories catalog；它只允许调用方通过普通 metadata 自行附带数据。
6. 内置 extractor 输出固定的 `memory type`、subject、attribute、cardinality 等结构，但没有 category 分类字段；业务 category 不应和内部 [`MemoryType`](../../packages/fishmem/src/types.ts#L20-L39) 混为一谈。
7. 今日新增的 [`BeliefReconciler`](../../packages/fishmem/src/core/belief-reconciler.ts#L1-L70) 明确不改写 canonical records；默认要求 3 个独立 evidence、3 个 context、0.6 支持度和 1 个权重点领先。公开 [`GET /v1/beliefs`](../../apps/docs/content/docs/api-reference/beliefs.zh.mdx#L1-L103) 只是 default/conflict/audit 视图，普通 recall 尚未由 winner 接管。

## 应该 follow 的能力

### P0：先把现有“假连接”变成真实连接

1. 把项目 settings 升级为版本化 `ExtractionPolicy`，并真正注入该 workspace 的 `infer:true` 单次提取。
2. categories 从 `string[]` 升级为稳定 key + label + description，提取后自动赋值；保留内部 `memory_type`，不要用业务标签替代类型语义。
3. 加入 include、exclude、detail、正例、反例和 user/agent overlay。exclude 与硬安全规则优先。
4. 每次 add 冻结 `policy_revision`、compiler version 与 policy hash；重试、回放和审计必须使用同一版本，不能在策略修改后漂移。
5. 保存前必须 preview；激活只影响未来的 `infer:true` 写入。旧数据的 re-extract/backfill 是另一个显式、可计费、可回滚任务。

### P1：产品化为 Dashboard 内的 Memory Policy

应该借鉴截图的低门槛引导：

- Choose a path：`From my data` / `Answer questions` / `Start blank`。
- Instructions：keep、never store、detail、examples、user/agent scope。
- Categories：稳定 key、展示名、描述、重叠/空分类检查。
- Review：展示当前策略与草案 diff，以及同一批样本的 before/after extraction 和 category diff。
- Activate：明确“只影响未来写入”，记录审批人、时间和 revision。
- History：查看旧 revision、指标与一键 rollback。

该页面必须继续放在 FishMem 的 Dashboard layout 内，复用现有 sidebar/header/page shell；不要为它再做一套孤立全屏设置壳，也不要复刻 Mem0 的紫色视觉或 Dream 命名。

### P2：实现“从已有数据生成草案”，但质量门槛要高于 50

建议器只输出结构化 proposal，不直接输出可执行 system prompt：

1. 由项目管理员主动发起并确认数据使用范围。
2. 从成功的 `infer:true` 操作抽取 source → extracted records 对，按时间、user/agent、conversation、空提取、memory type 分层抽样；不以 canonical memory 总数替代独立 source 数。
3. 先做 secrets/PII 扫描与最小化，再让模型归纳：疑似漏记、噪声、过粗/过细、错误归因、category 空缺/重叠。
4. 每条建议必须附 evidence count、脱敏示例和预期影响；用户逐条接受或拒绝。
5. 在冻结 holdout 上运行 current vs draft paired extraction，至少检查 schema validity、该记而未记、不该记而误记、秘密/提示注入泄漏、category coverage，以及下游 belief unresolved/conflict 的变化。
6. 只有硬安全项零回归且目标指标通过，才允许 activate；否则保留草案。

“50+”可以作为显示 CTA 的默认起点，但 eligibility 应同时看独立 add/context 数、样本覆盖和可用 source-output pair 数，并允许管理员手动从问卷开始。

## 不应耦合或照搬的部分

1. **不要让项目文本覆盖完整 system prompt。** 固定的 JSON schema、角色归因、来源数据隔离、secret veto 和 belief `value` 输出必须由 `ExtractionPolicyCompiler` 管理；项目规则只能进入受限插槽。
2. **不要允许普通 add 任意注入未版本化 instructions。** 如需 per-call 行为，优先接受已批准的 `policy_revision_id` 或受 schema 限制的 overlay；硬 deny 永远不能被覆盖。
3. **不要把 categories 当 belief policy。** `billing_issue`、`vip_customer` 等业务标签不能改变 `minimumEvidence`，也不能自动决定某条记录能否进入 preference reconciliation。
4. **不要让 extraction policy 激活自动 rebuild beliefs。** 新策略影响未来 canonical writes；belief projection 继续从当时冻结的 canonical hint 重建。历史重处理需单独审批。
5. **不要把 Dream、Graph、Extraction 合并成一个开关。** 提取、证据治理、近重复合并、衰减/retention 是不同失败域，必须分别启停和回滚。
6. **不要默认扫描全部原始用户文本。** 数据驱动草案需要显式授权、严格 namespace fence、采样上限、脱敏、短期 proposal 资产与可删除审计记录。
7. **不要复制“50 条就一定可调优”的产品暗示。** 数据量门槛只是可用性提示，不能替代 paired evaluation。

## 建议配置模型

```ts
type ProjectMemoryPolicyV1 = {
  schemaVersion: 1;
  revision: number;
  status: "draft" | "active" | "archived";
  source: "manual" | "questionnaire" | "historical_sample";

  extraction: {
    include: Array<{ id: string; text: string; enabled: boolean }>;
    exclude: Array<{ id: string; text: string; enabled: boolean }>;
    detail: "high_level" | "balanced" | "detailed";
    userInstructions?: string;
    agentInstructions?: string;
    examples: Array<{
      input: Array<{ role: "user" | "assistant"; content: string }>;
      expectedFacts: string[]; // [] 是必要的反例
    }>;
  };

  categories: Array<{
    key: string;          // 永久稳定，用于 API/filter
    label: string;        // 可改展示名
    description: string;  // 给分类器消歧
    enabled: boolean;
  }>;

  compilerVersion: string;
  createdBy: string;
  createdAt: string;
  activatedAt?: string;
};
```

编译优先级应固定为：不可覆盖的安全/来源/输出规则 → active project policy → user/agent overlay → 已批准的 per-call selector → belief 扩展输出 schema。任何 exclude 冲突都按更保守规则处理。

## 建议 API 与 UI 顺序

### 控制面 API

- `GET /api/project-memory-policy`：active revision、draft、eligibility、最近评测。
- `POST /api/project-memory-policy/drafts`：`manual | questionnaire | historical_sample`。
- `PATCH /api/project-memory-policy/drafts/:id`：编辑结构化规则，不直接上线。
- `POST /api/project-memory-policy/drafts/:id/preview`：无写入 paired preview。
- `POST /api/project-memory-policy/drafts/:id/activate`：带 expected active revision 和 idempotency key。
- `GET /api/project-memory-policy/revisions`：历史与审计。
- `POST /api/project-memory-policy/revisions/:id/rollback`：生成一个新的 active revision，不篡改历史。

现有 `/api/project-settings` 可在过渡期映射到 draft 的 `userInstructions/categories`，但不能继续以一次 PATCH 直接绕过 review/activation。

### 数据面 API

- `/v1/memories` 默认使用 workspace active revision，并把 revision/hash 冻结进 durable task 和 idempotent add plan。
- 可选 `policy_revision_id` 只能选择该项目已批准 revision；不先开放任意 per-call free-text。
- `infer:false` 明确不运行 extraction policy，也不自动分类；文档和 UI 必须说清楚这是原文存储路径。

### Dashboard 流程

`DashboardShell → Settings / Memory Policy → Choose path → Edit rules/categories → Preview diff → Review → Activate → Revision history/rollback`

## 分阶段优先级

| 阶段 | 交付 | 准入条件 |
| --- | --- | --- |
| P0 | 项目 policy 真正进入 extraction；structured categories；revision/hash；安全 compiler | 单元/集成测试证明 workspace 隔离、重试同版本、hard deny 不可覆盖 |
| P1 | Dashboard 内完整编辑、preview、approve、history、rollback；中英文文档 | 真实浏览器验证在 dashboard layout；API/UI/effective runtime 三者一致 |
| P2 | Questionnaire 与 data-derived proposal；脱敏、采样、evidence-backed suggestions | frozen holdout paired eval；无秘密/注入回归；不自动上线 |
| P3 | 明确的历史 re-extract/backfill、成本预估、可取消任务；belief health 只作观测指标 | canary、操作审计、失败恢复和 rollback 演练 |

## 最终判断

**应该借鉴，而且优先级高。** 这不是再造今日的 belief reconciliation，而是补齐它上游缺失的项目级 extraction policy 产品面和执行面。

最先做的不是“50+ 自动建议”，而是修复当前 instructions/categories **看起来可配置、实际上不参与 hosted extraction** 的断层。等 policy 已版本化、可 preview、可回滚后，再加入历史数据建议器；否则自动生成的只是另一段无法验证、无法复现、也无法安全回滚的 prompt。
