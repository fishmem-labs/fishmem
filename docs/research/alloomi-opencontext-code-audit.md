# Alloomi / OpenContext 代码审计与 FishMem 借鉴建议

> 审计日期：2026-08-16
> 固定版本：OpenContext `f2c81e998108eb48f66e802b4490595dacf7822d`；OpenLoomi `63c5478e5911ca730cb411947e6d56d0e15331a0`
> 范围：公开源码、公开 CI 与 FishMem 当前代码。Alloomi 的商业 post-training / expert anchoring / model rollback 实现未公开，因此不把产品介绍当成代码事实。

## 结论

Alloomi 公开代码里真正值得 FishMem 借鉴的，不是 BM25、RRF、图检索或“无限记忆”，而是一个更窄但真实的机制：**让推断出来的长期偏好先竞争，再晋升或替代，并让整个过程有作用域、证据、审计、灰度和回滚边界。**

建议：**借设计，不搬代码；做成 FishMem 现有 state / typed-graph seam 下的一个可重建 `BeliefReconciler` 投影，先 shadow，禁止直接改 canonical records。**

不建议把 OpenContext 整体并入 FishMem。FishMem 在 canonical writer、幂等 journal、关系型 projection、时态检索、RRF/PPR、namespace 隔离和测试上已经更深；照搬会形成第二套 store、第二套 lifecycle 和第二套语义。

## 真正的硬核部分

### 1. Owner scope 与 applicability 分离

OpenContext 把数据所有权 `OwnerScope` 与语义适用范围 `MemoryApplicabilityContext` 分开；后者支持 global、task、conversation、channel、project、custom 和有效时间窗。这比把“谁能看”和“在哪个场景成立”混成一个 scope 更干净。

源码：[graph-contracts.ts L1-L76](https://github.com/melandlabs/opencontext/blob/f2c81e998108eb48f66e802b4490595dacf7822d/packages/ai/memory-consolidation/src/graph-contracts.ts#L1-L76)

它还明确规定：跨不同适用场景的同一偏好不能因为更新就直接变成 global；需要至少三个独立 context，且同一 source 在多个 context 的回声只算一次。

源码：[graph-evolution.ts L523-L628](https://github.com/melandlabs/opencontext/blob/f2c81e998108eb48f66e802b4490595dacf7822d/packages/ai/memory-consolidation/src/graph-evolution.ts#L523-L628)

价值：这是“临时指令污染全局偏好”的直接防线。

### 2. Competition before supersession

新证据先形成 support / compete / related 边；冲突 cluster 保持 contested，不立即覆盖。只有 winner 同时满足最少证据、最低支持度、并领先 runner-up 足够幅度时，lifecycle 才允许稳定和 supersede。

源码：

- [relation-graph.ts L246-L385](https://github.com/melandlabs/opencontext/blob/f2c81e998108eb48f66e802b4490595dacf7822d/packages/ai/memory-consolidation/src/relation-graph.ts#L246-L385)
- [graph-lifecycle.ts L164-L368](https://github.com/melandlabs/opencontext/blob/f2c81e998108eb48f66e802b4490595dacf7822d/packages/ai/memory-consolidation/src/graph-lifecycle.ts#L164-L368)

这正好补 FishMem 的一个真实缺口：当前 state sidecar 对 single-valued slot 的不同新值会立即关闭旧值；这是显式状态变化的正确默认，却不适合“模型从工作经验推断出的偏好”。

FishMem 证据：[sidecar.ts L92-L123](../../packages/fishmem/src/core/sidecar.ts)

因此应拆成两种策略：

- 用户明确状态事件或显式 correction：仍立即 supersede。
- 自动推断、跨任务归纳的偏好/工作规则：先 contested，再以独立证据晋升。

### 3. Default / conflict / audit 三种检索视图

默认检索隐藏 deprecated raw 并优先代表性 summary；conflict 模式补出竞争方案；audit 模式返回 source nodes、edges、operations 和 reason codes。实现还计算输入 baseline 与输出结果的差异，解释每个 withheld / added node，避免过滤路径静默丢证据。

源码：[graph-retrieval.ts L480-L624](https://github.com/melandlabs/opencontext/blob/f2c81e998108eb48f66e802b4490595dacf7822d/packages/ai/memory-consolidation/src/graph-retrieval.ts#L480-L624)

OpenLoomi 不是只定义接口；它把这层接到 native agent 的默认上下文，同时保留 baseline fallback 和 provenance：

[controlled-default-context.ts L95-L204](https://github.com/melandlabs/openloomi/blob/63c5478e5911ca730cb411947e6d56d0e15331a0/apps/web/lib/memory/controlled-default-context.ts#L95-L204)、[L259-L360](https://github.com/melandlabs/openloomi/blob/63c5478e5911ca730cb411947e6d56d0e15331a0/apps/web/lib/memory/controlled-default-context.ts#L259-L360)

### 4. 保守上线，而不是“自动进化”口号

Graph evolution 默认关闭；上线要求 enable、用户 allowlist，并提供 kill switch。不可信 raw API 的 relation/applicability metadata 会被清洗，不能由客户端伪造图语义。

源码：[memory-graph-write-policy.ts L44-L83](https://github.com/melandlabs/openloomi/blob/63c5478e5911ca730cb411947e6d56d0e15331a0/apps/web/lib/memory/memory-graph-write-policy.ts#L44-L83)、[L86-L123](https://github.com/melandlabs/openloomi/blob/63c5478e5911ca730cb411947e6d56d0e15331a0/apps/web/lib/memory/memory-graph-write-policy.ts#L86-L123)

Correction / rollback runtime 有 command fingerprint、expected version、CAS、staged publication、source restore、partial-failure 和 retry 处理，而不是单纯把旧文本写回来。

源码：[memory-graph-governance.ts L286-L380](https://github.com/melandlabs/opencontext/blob/f2c81e998108eb48f66e802b4490595dacf7822d/packages/indexeddb/src/memory-graph-governance.ts#L286-L380)、[graph-correction.ts L605-L731](https://github.com/melandlabs/opencontext/blob/f2c81e998108eb48f66e802b4490595dacf7822d/packages/ai/memory-consolidation/src/graph-correction.ts#L605-L731)

Rollout gate 还明确拒绝只靠 dry-run 就判定 ready：必须观察到真实 runtime operation，并检查 publication convergence。

源码：[governance.ts L718-L805](https://github.com/melandlabs/opencontext/blob/f2c81e998108eb48f66e802b4490595dacf7822d/packages/ai/memory-consolidation/src/governance.ts#L718-L805)

## 代码没有证明什么

### 1. Alloomi 的 self-evolving model 并未开源

公开仓库能看到 context runtime、agent harness、benchmark harness 和一些旧的 LoRA 试验脚本；看不到介绍里那条完整生产链：任务轨迹筛选、专家示范锚定、Qwen 后训练、模型级评测准入、权重回滚。

公开 OpenLoomi 的 CL-Bench adapter 本质上是把线性消息历史拼成 prompt，再调用 `/api/native/agent`；它不是 post-training 实现：

[openloomi/system.py L1-L27](https://github.com/melandlabs/openloomi/blob/63c5478e5911ca730cb411947e6d56d0e15331a0/benchmark/continual-learning-bench/src/systems/openloomi/system.py#L1-L27)、[L281-L345](https://github.com/melandlabs/openloomi/blob/63c5478e5911ca730cb411947e6d56d0e15331a0/benchmark/continual-learning-bench/src/systems/openloomi/system.py#L281-L345)

`SWE-bench-CL/scripts/finetune_and_evaluate*.py` 使用 TinyLlama / CodeLlama 与通用 QLoRA/replay 风格代码，不能当成报告中 Qwen3.6 + teacher anchoring 系统的源码。

因此：**可以判断公开 context layer；不能从公开代码判断商业 self-evolving model 是否值得 FishMem 复制。**

### 2. 语义发现目前很窄

Graph lifecycle 的状态机很完整，但默认 relation judge 主要依赖上游已经提供的 `relationGroup` / `relationValue`；同 group 同 value = support，不同 value = compete，否则只是 related/uncertain。

源码：[pipeline.ts L526-L578](https://github.com/melandlabs/opencontext/blob/f2c81e998108eb48f66e802b4490595dacf7822d/packages/ai/memory-consolidation/src/pipeline.ts#L526-L578)

OpenLoomi 当前 chat 写入路径实际只用规则识别 language 与 response-style，并以正则判断 global/task/conversation：

[chat-memory-write.ts L33-L43](https://github.com/melandlabs/openloomi/blob/63c5478e5911ca730cb411947e6d56d0e15331a0/apps/web/lib/memory/chat-memory-write.ts#L33-L43)、[L81-L231](https://github.com/melandlabs/openloomi/blob/63c5478e5911ca730cb411947e6d56d0e15331a0/apps/web/lib/memory/chat-memory-write.ts#L81-L231)、[L530-L569](https://github.com/melandlabs/openloomi/blob/63c5478e5911ca730cb411947e6d56d0e15331a0/apps/web/lib/memory/chat-memory-write.ts#L530-L569)

所以“通用工作经验图”目前更多是一个扩展性良好的 contract，而不是已经能从任意职业轨迹中稳定抽取关系的通用模型。

### 3. Storage adapter 不适合 FishMem

IndexedDB adapter 把整个 graph snapshot 和 applied operations 塞进一条保留的 raw message，每次通过 CAS 重写 ledger。

源码：[memory-graph-evolution.ts L20-L64](https://github.com/melandlabs/opencontext/blob/f2c81e998108eb48f66e802b4490595dacf7822d/packages/indexeddb/src/memory-graph-evolution.ts#L20-L64)、[L327-L472](https://github.com/melandlabs/opencontext/blob/f2c81e998108eb48f66e802b4490595dacf7822d/packages/indexeddb/src/memory-graph-evolution.ts#L327-L472)

它解决了当前 adapter 的原子性和 replay，但有整图重写、payload 增长和第二权威状态的风险。FishMem 已有 canonical journal、关系型 graph/state projection 和 rebuild 约束；复制这层会倒退。

### 4. 阈值是策略常量，不是已证明的普适定律

默认值如 3 条证据、support 0.6、30 天 decay、强度领先 1，都应视为可测试 policy，而不是可以直接抄进 FishMem 的参数。

源码：[graph-lifecycle.ts L70-L74](https://github.com/melandlabs/opencontext/blob/f2c81e998108eb48f66e802b4490595dacf7822d/packages/ai/memory-consolidation/src/graph-lifecycle.ts#L70-L74)

## 与 FishMem 的逐项映射

| OpenContext 机制 | FishMem 现状 | 决定 |
| --- | --- | --- |
| OwnerScope + ApplicabilityContext 分离 | namespace/user/agent/run scope + 双时间，但没有独立的语义 applicability contract | **改写借鉴** |
| support / compete cluster | 已有 `contradicts`、`same_slot`、`supersededBy`，但没有完整 contested lifecycle | **重点借鉴** |
| evidence threshold 后 supersede | state sidecar 的 single slot 立即 supersede | **仅用于自动归纳偏好；不可替换显式状态更新** |
| default/conflict/audit retrieval | 有 search trace、history、validity completion；缺显式 conflict view | **改写借鉴** |
| correction / rollback commands | 已有 update/invalidate/delete/purge、journal、snapshot restore | **借交互与测试语义，不搬 persistence** |
| allowlist + kill switch + shadow gate | 有生产 acceptance gate，但新演化策略尚无专用 rollout policy | **直接借鉴模式** |
| BM25 + RRF + as-of | FishMem 已实现且有 paired ablation | **不借** |
| graph traversal / decay | FishMem 已有 typed graph、PPR、temporal kernel、maintenance | **不借实现；只测新的 relation signal** |
| raw-message graph ledger | FishMem canonical journal + relational projections 更深 | **明确拒绝** |
| chat regex preference extractor | 只覆盖语言/回复风格 | **不借** |
| 商业 post-training flywheel | 无公开实现 | **暂不决策，不进入 FishMem kernel** |

FishMem 当前架构依据：

- 单 canonical writer、显式 correction：[ARCHITECTURE.md L11-L58](../ARCHITECTURE.md)
- canonical journal 与可重建 projection：[ARCHITECTURE.md L100-L150](../ARCHITECTURE.md)
- retrieval 已含 vector、FTS、temporal、graph、validity/supersession、diversity：[ARCHITECTURE.md L275-L296](../ARCHITECTURE.md)
- 当前 graph/FTS 的负向与 wash ablation：[RETRIEVAL-PLAN.md L14-L21](../RETRIEVAL-PLAN.md)、[L93-L134](../RETRIEVAL-PLAN.md)

## 推荐的 FishMem 设计

新增一个深模块而非新 store：

```text
canonical records + frozen extraction plan
                 |
                 v
          BeliefReconciler
       /         |          \
 supported   contested   superseded
       \         |          /
    evidence ids + applicability + reason codes
                 |
     default / conflict / audit retrieval view
```

边界：

1. `BeliefReconciler` 只生成 projection，不能改 canonical content。
2. 显式用户 correction 和有日期的状态事件继续走现有 update/invalidate/supersession。
3. 只有自动推断的 preference / learned rule 进入 competition lifecycle。
4. applicability 是语义适用范围，不得替代 authenticated namespace fence。
5. relation judge 复用一次写入中冻结的 extraction plan；默认不新增第二次 LLM 调用。
6. persistence 用现有关系型 state/association tables 或新 projection tables；不使用 JSON ledger。
7. 首版只提供 shadow diff、conflict/audit API，不改变默认 recall。

## 是否现在做

**建议做一个小型实验 tranche，不建议直接进生产默认。**

理由：FishMem 在 BEAM 的已知弱项恰好包括 contradiction resolution、summarization 和 event ordering；competition-before-supersession 与 audit retrieval 是对准弱点的新信号，不是重复造 BM25/PPR。但现有证据还没有证明它能提升 FishMem 自己的同 harness 结果。

建议准入顺序：

1. 先冻结 40–80 个针对临时指令、长期偏好、冲突事实、跨项目污染、显式 correction 的 adversarial scenarios。
2. 实现纯 projection `BeliefReconciler`，只输出 shadow diff。
3. 对 LongMemEval knowledge-update/preference、BEAM contradiction resolution、LoCoMo temporal/multi-hop 做同 ingest、同 question 的 paired A/B。
4. 硬门槛：跨 namespace/applicability 泄漏为 0；canonical history 无变化；所有结果有 source ids；失败可删 projection 完整恢复。
5. 统计门槛：paired McNemar / paired bootstrap；整体不得显著回归，目标 slice 必须有稳定净提升；同时记录写入成本、检索延迟和上下文 token。
6. 通过后只对 allowlist 开 conflict/audit；再决定是否让 learned preference 影响 default retrieval。

如果第一轮只是把 `relationGroup/value` 手工标好后状态机测试通过，而真实抽取 A/B 没提升，就停止，不把 contract 完整度误当成产品收益。

## FishMem 落地状态

本轮已经按上述边界完成一个可运行 tranche，但仍保持 **shadow-only、默认关闭**：

- 新增深模块 [`BeliefReconciler`](../../packages/fishmem/src/core/belief-reconciler.ts)：owner scope 与 applicability 分离；按独立 evidence key/context 计数；提供 supported/contested/superseded 生命周期和 default/conflict/audit 三种视图；当前场景存在未决证据时禁止 global fallback。
- 新增 SQLite、Postgres、D1 关系型 adapter（[`belief-reconciler-drizzle.ts`](../../packages/fishmem/src/core/belief-reconciler-drizzle.ts)），只存证据行，不存整图 JSON ledger。并发写入使用 upsert，冲突 independence key 在读取时 fail-closed 隔离。
- 复用一次 canonical extraction 中冻结的 semantic claim value、适用场景与来源 ID；canonical record 保存 JSON-safe projection hint，重建不再调用 LLM。update、invalidate、delete、forget、namespace purge、snapshot restore 都传播到投影。
- 为保持 paired A/B 可比，现有 state 生命周期未改变，推断偏好在 shadow 阶段仍可能进入 legacy state；新 winner 不会反向治理 state，普通 search/recall 也未接入。新增 [`GET /v1/beliefs`](../../apps/web/src/routes/v1/beliefs.ts)、TypeScript/Python SDK、OpenAPI contract 和中英文文档，仅供 shadow diff 与审计。
- Web runtime 同时要求 `FISHMEM_BELIEF_RECONCILIATION_ENABLED=1` 和非空 namespace allowlist；缺少 allowlist 时 fail-closed，不改变提取 prompt，也不写 projection hint。`FISHMEM_BELIEF_RECONCILIATION_DISABLED=1` 可动态熔断。公开 add 以及 REST snapshot export/import 都会清洗实现内部治理字段，客户端不能伪造独立支持。
- 额外处理了两个实现级竞态：重叠 applicability 时间窗会进入同一竞争簇；deferred projection 与 update/delete 同时发生时会在写后重新核对 canonical record，禁止旧证据复活。

工程实现已完成；**产品收益尚未证明**。本轮没有用该投影改写默认召回，也没有把 Alloomi 未开源的 expert anchoring、post-training 或模型 checkpoint rollback 当作已实现能力。进入生产默认仍需完成前述 paired benchmark 与统计准入。

## 验证记录

本次上游审计与本地实现验证：

- OpenContext `@melandlabs/memory-consolidation`：typecheck 通过，build 通过。
- OpenContext `@melandlabs/indexeddb`：在先构建依赖包后 typecheck 通过。
- OpenContext 两个 package-local test files：7 tests 通过；核心行为测试主要位于 OpenLoomi `apps/web/tests/unit`，而不是独立 package script。
- OpenLoomi 当前主 CI：Node 22/24 均为 2,464 tests passed、17 skipped；真实 provider、桌面 E2E、Rust 和 benchmark 不属于该绿灯的完整生产证明。[workflow](https://github.com/melandlabs/openloomi/blob/63c5478e5911ca730cb411947e6d56d0e15331a0/.github/workflows/test.yml#L1-L65)
- FishMem core：21 files、233 tests 全部通过；17 个 belief lifecycle/integration 测试覆盖 evidence 去重、并发冲突隔离、重叠时间窗、applicability firewall、关闭状态零额外读取、SQLite/D1 持久 adapter、重启恢复、deferred mutation 竞态、canonical mutation 清理、rollout prompt 隔离与零 LLM rebuild。
- FishMem 全仓 `pnpm typecheck`、`pnpm test`（395 tests）、Biome lint 与 Web ESLint 通过；Web、Desktop、TypeScript SDK、Python SDK、双语文档生产构建通过。
- 全新 libSQL 数据库真实执行 16 个迁移，确认 `projection_hints`、`fishmem_belief_evidence` 与 3 个索引存在。
- 未执行 LongMemEval/BEAM/LoCoMo paired benchmark；未连接真实 Postgres 或远程 Cloudflare D1，因此两项仍是生产准入项，不能由本地 schema/typecheck 代替。

## License

OpenContext / OpenLoomi 核心为 Apache-2.0，可研究、改写或在保留许可与修改声明的前提下复制；但 OpenLoomi 仓内存在不同许可证的 benchmark 和受限 skills，不能整仓 vendoring。即使 license 允许，本报告仍建议按 FishMem 现有接口重写，而不是复制实现。
