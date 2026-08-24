# Zep 94.7% / 90.2% benchmark 审计

日期：2026-08-24
范围：只使用 Zep 官方页面、Zep 官方仓库/论文，以及 LoCoMo、LongMemEval 原始仓库/论文。

## 结论

Zep 的成绩不能简单解释成“图数据库刷榜”。公开材料显示，它确实有一套适合长期记忆的强架构：时态事实、冲突失效、多种记忆表示、并行多路召回、交叉编码器重排，以及面向热图的内存索引。这些能力与 LoCoMo、LongMemEval 的 temporal、knowledge-update、multi-session 问题高度匹配。[Zep Research](https://www.getzep.com/research/) [Context Graph Engine](https://www.getzep.com/platform/context-graph-engine/) [Graphiti README（固定提交）](https://github.com/getzep/graphiti/blob/993e081a6d7948a0d8851c12a5fbdbeb49fed862/README.md)

但 **94.7% 和 90.2% 不是当前可与 FishMem 成绩直接比较的第三方统一榜单结果**。它们是 Zep 自报结果，采用 `gpt-5.4` medium reader、`gpt-5.4` chain-of-thought judge，以及为 benchmark 配置的五路检索；LoCoMo 还使用 5,760 tokens 的中位上下文。当前公开页面没有给出 LongMemEval split、完整 prompts、judge labels、逐题 hypotheses、dataset revision/hash、写入/抽取模型或延迟测试环境。[Zep Research](https://www.getzep.com/research/)

对 FishMem 最重要的判断是：

1. **应该借鉴架构，不应该照抄 headline。** 优先借鉴多表示并行召回、全局预算化重排、事实有效期/失效链路和冷热分层。
2. **现在不要把 Zep 94.7/90.2 与 FishMem 75.5/88.2 做成同协议柱状图。** LoCoMo 的 judge、prompt 和上下文预算不同；LongMemEval 的 split 甚至没有公开。
3. **Zep 的 94.7 很大一部分是“高召回、高预算、强模型”的联合结果。** Zep 自己的对照显示：默认 Auto Search 用 2,680 tokens 时为 86.5%，旧式固定多路 Context Block 用 5,760 tokens 时为 94.7%；这 8.2 分不能全归因于 memory core，也不能只归因于 token 数，因为检索/组装算法同时变化。[Zep Smart Context Assembly](https://blog.getzep.com/smart-context-assembly-fewer-tokens-higher-quality/)

## Zep 实际公开了什么

| 项目 | LoCoMo | LongMemEval |
|---|---:|---:|
| Zep headline accuracy | 94.7%，1,459 / 1,540 | 90.2%，451 / 500 |
| retrieval latency | p50 87 ms / p95 155 ms | p50 104 ms / p95 162 ms |
| context | median 5,760 tokens | median 4,408 tokens |
| reader | `gpt-5.4`, reasoning `medium` | 同左 |
| judge | `gpt-5.4`, chain-of-thought grading | 同左 |
| headline retrieval | 20 edges + 10 nodes + 10 episodes + 5 thread summaries + 5 observations；五路并行，cross-encoder reranking | 同左 |
| 失败题 | 0 | 0 |

以上数值和配置都来自同一份 [Zep 官方 Research 页面](https://www.getzep.com/research/)。这里的 155/162 ms 是 **p95 retrieval latency**，不是回答生成或端到端 agent latency；5,760/4,408 是 **median context**，不是均值。

Zep 还公开了一个重要的内部对照：LoCoMo Auto Search 为 86.5%，p50/p95 115/173 ms，median 2,680 tokens，`max_characters=10000`。Auto Search 是单调用、跨 scope 重排和字符预算装箱；94.7% headline 则来自旧式固定数量的多 scope 搜索后在客户端合并。[Zep Research](https://www.getzep.com/research/) [Zep Smart Context Assembly](https://blog.getzep.com/smart-context-assembly-fewer-tokens-higher-quality/)

## 协议审计

### 1. LoCoMo：同为 1,540 题，但不是原始官方计分

LoCoMo 原始 `locomo10.json` 有五类共 1,986 题；固定版本数据的类别数是 282、321、96、841、446。前四类恰好 1,540 题，因此 Zep headline 明确排除了 category 5 adversarial slice。[官方数据（固定提交）](https://github.com/snap-research/locomo/blob/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/data/locomo10.json)

原始 LoCoMo evaluator 对 category 1 使用多答案 token F1，对 category 2–4 使用 token F1，对 category 5 使用拒答规则；它并不是每题由 LLM 判定 CORRECT/WRONG 后计算的 accuracy。[官方 evaluator（固定提交）](https://github.com/snap-research/locomo/blob/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/task_eval/evaluation.py) 因此，Zep 的 94.7% 只能与 **同一 hypotheses、同一 judge prompt、同一 judge snapshot** 下的 binary LLM-judge accuracy 比，不能当成原论文 F1 leaderboard 分数。[LoCoMo 论文](https://arxiv.org/abs/2402.17753)

当前 Zep 页面还有一个尚未解释的算术/数据口径问题：页面列出的四类是 `646/670 + 311/325 + 304/323 + 175/221 = 1,436/1,539 = 93.31%`，既不等于 headline 的 `1,459/1,540 = 94.74%`，类别分母也不等于原始数据的 282/321/96/841。[Zep Research](https://www.getzep.com/research/) 这不证明 headline 错误，但说明页面至少遗漏了一题和 23 个“correct”的归属，或使用了未公开的重新分类/转换。

Zep 公开仓库可以复现较早的 LoCoMo 方法，但不是这次 headline run：当前固定提交中的配置仍为 `gpt-4o-mini` reader/judge，检索只有 nodes + edges；公开的 10-run 实验摘要最高一组均值约 80.32%，而不是 94.7%。[公开配置（固定提交）](https://github.com/getzep/zep/blob/7de18dfa14da532cb782a0a14ae329e9a28b23d9/benchmarks/locomo/benchmark_config.yaml) [公开检索/评测代码（固定提交）](https://github.com/getzep/zep/blob/7de18dfa14da532cb782a0a14ae329e9a28b23d9/benchmarks/locomo/evaluation.py) [公开实验摘要（固定提交）](https://github.com/getzep/zep/blob/7de18dfa14da532cb782a0a14ae329e9a28b23d9/benchmarks/locomo/experiments/experiment_20251207_215609/experiment_summary.json)

该公开 harness 的历史 grader prompt 明确要求对主题相同和时间表达“generous”评分；当前 94.7 run 是否沿用完全相同的 prompt，Research 页面没有说明，所以不能假定。[Zep 历史 prompt（固定提交）](https://github.com/getzep/zep/blob/7de18dfa14da532cb782a0a14ae329e9a28b23d9/benchmarks/locomo/prompts.py) Zep 也曾在官方 issue 中承认过一次旧 LoCoMo 分数计算错误并改为 75.14% ± 0.17；这与新的 94.7 run 不是同一实验，但说明当前结果更需要逐题产物来消除歧义。[Zep 官方回复](https://github.com/getzep/zep-papers/issues/5#issuecomment-2873485203)

### 2. LongMemEval：500 题相同，不代表 split 相同

LongMemEval 官方发布 `S`、`M`、`oracle` 三种 500 题版本：S 约 115k tokens / 约 40 sessions，M 约 500 sessions，oracle 只保留 evidence sessions。[官方 README（固定提交）](https://github.com/xiaowu0162/LongMemEval/blob/9e0b455f4ef0e2ab8f2e582289761153549043fc/README.md) Zep 当前页面只写“500 LongMemEval questions”，没有写 S、M 或 oracle。[Zep Research](https://www.getzep.com/research/) 它列出的六类百分比按官方类别样本数可还原为 451/500，但这无法识别使用了哪种 history split，因为三个版本共享题目结构。

Zep 的 2025 论文实验明确使用 LongMemEval-S，当时用 `gpt-4o` reader 的总分是 71.2%；当前 90.2 使用更强 reader/judge 和更新的产品架构，因此两者的 19 分差不能单独归因于 memory retrieval。[Zep 论文](https://arxiv.org/abs/2501.13956)

LongMemEval 官方 evaluator 将 `gpt-4o` 固定为 `gpt-4o-2024-08-06`，按问题类型使用 yes/no prompt、temperature 0、最多 10 tokens；Zep 当前使用 `gpt-5.4` chain-of-thought judge，属于不同评分协议。[官方 evaluator（固定提交）](https://github.com/xiaowu0162/LongMemEval/blob/9e0b455f4ef0e2ab8f2e582289761153549043fc/src/evaluation/evaluate_qa.py) 在拿到 Zep 的 split 与逐题 hypotheses 之前，90.2 不能与 FishMem `longmemeval:oracle` 88.2 排名。

## 为什么 Zep 看起来这么强

下面把“官方证据”和“推断”分开。

### 已有直接证据

1. **检索面更宽。** headline 每题最多从五种表示取 50 个条目，而不是一次向量 top-k；Auto Search 的 86.5 → 94.7 对照表明固定多 scope、高上下文方案确实换来了更高 accuracy。[Zep Research](https://www.getzep.com/research/)
2. **Reader 和 judge 都很强。** 当前两者均为 `gpt-5.4`，reader 开 medium reasoning，judge 使用 chain-of-thought grading。这测量的是“Zep context + 强 reader + 强 judge”的整条 pipeline，不是纯 retrieval recall。[Zep Research](https://www.getzep.com/research/)
3. **时间是一等数据。** Zep 的边具有有效时间、失效时间等时态信息；新事实与旧事实矛盾时可使旧事实失效。这正面帮助 temporal reasoning 和 knowledge update。[Context Graph Engine](https://www.getzep.com/platform/context-graph-engine/) [Graphiti README（固定提交）](https://github.com/getzep/graphiti/blob/993e081a6d7948a0d8851c12a5fbdbeb49fed862/README.md)
4. **同一事件有多种可检索表示。** facts、entities、raw episodes、thread summaries、observations 可分别命中精确事实、实体关系、原文证据、会话级摘要和跨会话模式。[Zep Context Types](https://help.getzep.com/context-types) [Zep Episodes](https://help.getzep.com/episodes)
5. **服务端为低延迟检索专门设计。** Zep 声明热图使用 RAM adjacency/CSR，并把 vector 与 BM25 index 放在同一执行路径；五路搜索并行，因此 155/162 ms 的量级在其架构上是合理的。[Context Graph Engine](https://www.getzep.com/platform/context-graph-engine/) [Zep Performance Guide](https://help.getzep.com/performance)

### 合理推断，但尚不能由公开材料证明

1. **大 context budget 是 94.7 的主要助力之一。** 5,760 median tokens 是 FishMem 当前 LoCoMo mean 701 tokens 的约 8.2 倍；但 Zep 的 Auto/legacy 对照同时改变了检索与装箱逻辑，不能把全部 8.2 分增益归因于 token 数。
2. **强 judge 可能抬高 absolute accuracy。** binary LLM grading 对 prompt 和模型敏感，尤其历史 Zep prompt 明确采用宽松判定；没有 frozen hypotheses 的双 judge 重评分，无法量化 judge lift。[Zep 历史 prompt（固定提交）](https://github.com/getzep/zep/blob/7de18dfa14da532cb782a0a14ae329e9a28b23d9/benchmarks/locomo/prompts.py)
3. **155/162 ms 很可能是热路径。** Zep 明确区分 hot RAM、warm NVMe、cold object storage，而 benchmark histories 刚写入且被连续查询，通常会保持热；但 Research 页面没有披露 region、client placement、connection reuse、预热次数或 cold-start 分布，因此这只是推断。[Context Graph Engine](https://www.getzep.com/platform/context-graph-engine/) [Zep Performance Guide](https://help.getzep.com/performance)
4. **当前 LongMemEval 很可能仍为 S，但不能写成事实。** 依据只有 Zep 旧论文使用 S；当前 Research 页面未命名 split。[Zep 论文](https://arxiv.org/abs/2501.13956) [Zep Research](https://www.getzep.com/research/)

## 与 FishMem 当前 full paired 结果是否可比

FishMem 的当前证据见 [2026-08-24 scorecard](../../benchmarks/reports/evidence-2026-08-24.md)。

| 维度 | FishMem | Zep | 判断 |
|---|---|---|---|
| LoCoMo slice | 1–5：67.5%；仅 1–4：75.5% | 1–4：94.7% | 应至少用 75.5，不应拿 67.5；仍非同协议 |
| LoCoMo answer/judge | `gpt-5.6-sol` reasoning none / `gpt-4o-mini` | `gpt-5.4` medium / `gpt-5.4` CoT | 不可直接比较 |
| LoCoMo retrieval/context | top-k 10；mean 701 tok | 五 scope 最多 50 条；median 5,760 tok | 预算、统计量均不同 |
| LongMemEval split | oracle，500 | 未公开，500 | 不可排名；若 Zep 是 S，任务反而更难，但目前未证实 |
| LongMemEval answer/judge | `gpt-5.6-sol` none / 官方 `gpt-4o` judge | `gpt-5.4` medium / `gpt-5.4` CoT | 不可直接比较 |
| latency | LoCoMo p95 1,145 ms；Long oracle p95 980 ms | 155 / 162 ms | 数值可描述，环境与测量边界不一致，不能宣称 6–7× 产品优势 |
| context statistic | mean | median | 不能直接作精确倍数对比 |

因此，**Zep 的公开数据可以作为研发目标，不应作为 FishMem 当前 README/landing 的同口径 competitor bar。** 可以写成 “vendor-reported, different protocol”，并链接本报告；对外主表只放 FishMem 与 Mem0 在同一 paired harness 下的结果。

## FishMem 应该借鉴什么

按收益/验证成本排序：

1. **先做公平复验，而不是先追 94.7。** LoCoMo 固定 category 1–4 和 dataset SHA，冻结同一批 answers，分别用 FishMem judge、LongMemEval 官方 judge、Zep 风格 `gpt-5.4` judge 重评，直接测 judge lift。
2. **补 LongMemEval-S full 500。** 现有 88.2 是 oracle，无法回应 Zep、Mem0 的 retrieval claim。S 才能同时测长期历史检索与答案质量。
3. **做 context-budget curve。** 在约 700、2,680、5,760 tokens 三档测 accuracy、p50/p95、answer cost，判断 FishMem 的瓶颈是 recall、rerank 还是 reader。
4. **实现多表示候选池。** 并行召回 canonical facts、raw episodes、entities、session summaries、observations，再统一去重、cross-encoder rerank、按 token budget 装箱。这里值得借鉴 Zep 的原则，而不是照搬固定 20/10/10/5/5。
5. **强化时态生命周期。** 给事实显式 `valid_at` / `invalid_at`，保留 provenance，更新时失效而非覆盖；优先针对 FishMem 在 LongMemEval knowledge-update 的 -7.7 pt 做回归测试。
6. **拆开延迟。** 分别记录 embedding、network、candidate retrieval、rerank、storage，并发布 warm/cold p50/p95。只有在相同 region、connection reuse 和并发下，才能对比 Zep 155/162 ms。
7. **发布可审计产物。** 对每次公开 claim 固定 dataset hash、split、prompts、model snapshots、token counter、逐题 hypotheses、judge labels、失败/重试 ledger、run count 与置信区间。

## 最终判断

Zep 的高分有真实技术基础，但当前 94.7/90.2 同时吃到了 **面向 benchmark 的高召回配置、5,760/4,408 token 上下文、强 reader、强 judge，以及专有热内存执行引擎**。公开证据不足以把它拆成“memory layer 本身提升了多少”。

FishMem 应该借鉴 Zep 的时态图、多表示召回和预算化组装；不应该追随其当前披露标准。更好的竞争策略是用可复现、paired、带置信区间的协议，把“同等质量下更少 token / 更低成本 / 更低 p95”做成 FishMem 的可信优势。
