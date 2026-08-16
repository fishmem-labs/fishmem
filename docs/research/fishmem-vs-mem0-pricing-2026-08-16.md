# FishMem Cloud 与 Mem0 托管定价同口径审计

> 审计日期：2026-08-16
> 范围：Mem0 官方定价、官方文档与条款；FishMem 当前生产定价页；FishMem / FishMem Cloud 当前源码。
> 口径：只比较托管服务。两边的开源版本都可免费自托管，但基础设施、模型与运维成本由部署者承担，这不是托管套餐的“零成本替代”。依据：[Mem0 Platform vs Open Source](https://docs.mem0.ai/platform/platform-vs-oss)、[FishMem 当前定价 FAQ](https://fishmem.com/pricing)。
> 证据标签：**官方事实** = 厂商当前公开页面；**代码事实** = 当前仓库中可执行的计费/权限逻辑；**计算/推断** = 基于前两者的算术或商业判断。

## 结论

1. **FishMem 当前不是 Mem0 的半价。** Mem0 Starter 与 Pro 分别为 `$19/月`、`$249/月`；FishMem 同名档位也是 `$19/月`、`$249/月`。[Mem0 官方定价](https://mem0.ai/pricing)、[FishMem 当前定价](https://fishmem.com/pricing)
2. **当前 credits 是按 Mem0 的公开配额一比一反推出来的。** Mem0 每个有数字上限的公开自助档都是 `add : retrieval = 10 : 1`。按 FishMem 的 `推理 add = 2 credits`、`search = 1 credit` 换算（[Mem0 配额](https://mem0.ai/pricing)、[FishMem credit 规则](https://github.com/fishmem-labs/fishmem-cloud/blob/651bf8a57cf89accea5e52b4f70590fb87d7ff64/web/lib/server/hosted-usage-ledger.ts#L29-L65)）：
   - Hobby：`10,000 × 2 + 1,000 = 21,000 credits`
   - Starter：`50,000 × 2 + 5,000 = 105,000 credits`
   - Pro：`500,000 × 2 + 50,000 = 1,050,000 credits`

   三个数与 FishMem 套餐完全相同。这是**强推断**：当前定价设计的基准是“同价、同一标准流量组合”，不是 50% 折扣。
3. **FishMem 的真实价格优势取决于流量结构。** credits 是共享池（[计划目录](https://github.com/fishmem-labs/fishmem-cloud/blob/651bf8a57cf89accea5e52b4f70590fb87d7ff64/web/lib/billing-plans.ts#L24-L75)），因此 search-heavy 或 `infer:false` 的流量可比 Mem0 的分桶配额更灵活；但在 Mem0 套餐隐含的 10:1 流量组合上，容量和月价相同，节省为 0%。
4. **FishMem Pro 的公开可确认权益没有与 Mem0 Pro 对齐。** Mem0 Pro 公开包含无限项目、Private Slack、Advanced analytics、Graph memory 与 Dream；FishMem 自助套餐在代码中全部限制为 1 个项目，计划目录只承诺邮件支持和 request/usage dashboard。即使 FishMem 底层另有图与审计能力，也不能据此把当前套餐描述成已实现权益平价。[Mem0 官方计划对比](https://mem0.ai/pricing)、[FishMem 计划目录](https://github.com/fishmem-labs/fishmem-cloud/blob/651bf8a57cf89accea5e52b4f70590fb87d7ff64/web/lib/billing-plans.ts#L24-L75)、[FishMem 项目数硬限制](https://github.com/fishmem-labs/fishmem-cloud/blob/651bf8a57cf89accea5e52b4f70590fb87d7ff64/web/lib/server/app-api.ts#L306-L329)
5. **现在不能从仓库事实证明“砍到一半仍有利润”。** 代码没有提供生产流量的 token 分布、模型实际采购价、重试率、存储/向量/Workers 成本、Stripe 成本或套餐利用率。更重要的是，单次推理 add 无论负载大小固定收 2 credits，而公开 contract 最多允许 500 条 message、250,000 UTF-8 bytes；在没有 COGS 分位数和输入加权前，直接半价存在尾部亏损风险。[固定 credit 规则](https://github.com/fishmem-labs/fishmem-cloud/blob/651bf8a57cf89accea5e52b4f70590fb87d7ff64/web/lib/server/hosted-usage-ledger.ts#L29-L65)、[add 负载上限](https://github.com/fishmem-labs/fishmem/blob/e37457a24659a287e6c804498e5e165acca5ed86/packages/contracts/src/index.ts#L9-L10)、[add schema](https://github.com/fishmem-labs/fishmem/blob/e37457a24659a287e6c804498e5e165acca5ed86/packages/contracts/src/index.ts#L351-L374)

## Mem0：截至 2026-08-16 可由官方确认的定价

Mem0 当前公开的是 **request 配额**，不是“存了多少条 memory”的容量费。其 FAQ 定义：add request 是 Mem0 处理并存储新记忆的请求；retrieval request 是 agent 查询相关记忆的请求；两类配额分别计数。[Mem0 官方定价与 FAQ](https://mem0.ai/pricing)

| 计划 | 公开月价 | Add requests / 月 | Retrieval requests / 月 | End users | Projects | 公开权益 |
| --- | ---: | ---: | ---: | --- | ---: | --- |
| Hobby | Free | 10,000 | 1,000 | Unlimited | 1 | Community support |
| Starter | $19 | 50,000 | 5,000 | Unlimited | 1 | Community support |
| Pro | $249 | 500,000 | 50,000 | Unlimited | Unlimited | Multiproject、Private Slack、Advanced analytics、Graph memory、Dream |
| Enterprise | Custom | Unlimited | Unlimited | Unlimited | Unlimited | Pro 权益，加 SLA、on-prem、audit logs、custom integrations、SSO |

来源：[Mem0 官方定价页](https://mem0.ai/pricing)。页面当前没有 Growth 档。

### Mem0 的 request 到底是什么

- **官方事实：** `POST /v3/memories/add/` 一次可提交一个 messages 数组；默认 `infer:true` 做一次 LLM extraction，`infer:false` 可按原文存储。因此“一个 add request”不等于“只产生一条 memory”，也不等于固定 token 数。[Add Memories API](https://docs.mem0.ai/api-reference/memory/add-memories)、[Add Memory 概念文档](https://docs.mem0.ai/core-concepts/memory-operations/add)
- **官方事实：** `POST /v3/memories/search/` 接受一次自然语言 query 并返回相关 memories，最接近定价页所说的 retrieval request。[Search Memories API](https://docs.mem0.ai/api-reference/memory/search-memories)
- **无法确认：** Mem0 公共页面没有写明一个包含多条 message 的 add 是否永远只扣 1 个 add request，也没有公开单次请求的最大 token/byte、额外的每分钟限流或 `infer:false` 是否有不同计费权重。因此，本报告只按页面明确写出的“request”比较，不把它误写成 memory 条数或 token 配额。

### 超额、年付和到量行为

- **官方事实：** 定价页说可为固定套餐不合适的团队提供 usage-based pricing，但没有公开每 add / retrieval 的超额单价。[Mem0 官方定价](https://mem0.ai/pricing)
- **官方事实：** Mem0 条款允许超出套餐上限的 usage-based overage 按平台公布价格或 Order Form 收费；自助订阅可按结账时选择的月付或年付周期续订。[Mem0 Terms §4.1、§10.1](https://mem0.ai/terms)
- **无法确认：** 公共定价页没有展示 overage rate、年付折扣、达到配额后是暂停还是自动超额、get/list/history 是否计入 retrieval，以及具体的短周期 rate limit。没有这些数据，不能计算 Mem0 的真实超额边际价。

## FishMem：当前生产页面与代码事实

### 套餐

| 计划 | 当前月价 | Included credits / 月 | 自助项目数 | 支持 |
| --- | ---: | ---: | ---: | --- |
| Hobby | Free | 21,000 | 1 | Community / docs |
| Starter | $19 | 105,000 | 1 | Standard / community support（页面与内部 label 的措辞略有不同） |
| Growth | $79 | 420,000 | 1 | Priority email |
| Pro | $249 | 1,050,000 | 1 | Higher-priority / email support |
| Enterprise | Custom | Custom | 书面约定 | 书面约定 |

来源：**官方生产页面** [fishmem.com/pricing](https://fishmem.com/pricing)；**代码事实** [billing-plans.ts](https://github.com/fishmem-labs/fishmem-cloud/blob/651bf8a57cf89accea5e52b4f70590fb87d7ff64/web/lib/billing-plans.ts#L24-L75)。`SELF_SERVE_PROJECT_LIMIT = 1` 不只是展示文案，创建第二个项目会返回 `409 PROJECT_LIMIT_REACHED`：[billing-plans.ts](https://github.com/fishmem-labs/fishmem-cloud/blob/651bf8a57cf89accea5e52b4f70590fb87d7ff64/web/lib/billing-plans.ts#L3-L8)、[app-api.ts](https://github.com/fishmem-labs/fishmem-cloud/blob/651bf8a57cf89accea5e52b4f70590fb87d7ff64/web/lib/server/app-api.ts#L319-L329)。

### Credits 计量

| 操作 | Credits | 代码/文档事实 |
| --- | ---: | --- |
| `memories.add`，`infer:true` | 2 / request | 固定值，不随 message 条数或 token 数变化 |
| `memories.add`，`infer:false` | 1 / request | 固定值 |
| `memories.search` | 1 / request | 固定值 |
| `memories.get / list` | 0 | 免费 |
| `documents.extract` | 50 / 每个已开始的 5,000,000-byte block | 按块计费 |
| `documents.ingest` | 1 / projected chunk | 按 chunk 计费 |
| `documents.search` | 1 / request | 固定值 |

来源：[FishMem 当前定价页](https://fishmem.com/pricing)、[Hosted credit 函数](https://github.com/fishmem-labs/fishmem-cloud/blob/651bf8a57cf89accea5e52b4f70590fb87d7ff64/web/lib/server/hosted-usage-ledger.ts#L29-L65)、[Usage and credits 文档](https://github.com/fishmem-labs/fishmem/blob/e37457a24659a287e6c804498e5e165acca5ed86/apps/docs/content/docs/cloud/usage-and-credits.mdx#L10-L38)。

**代码事实：** FishMem 没有公开 self-serve overage rate；余额不足时新增写入和搜索暂停，读取仍可用。月度套餐 credits 是容量桶，不应从 request log 自行推算美元。[定价 FAQ](https://fishmem.com/pricing)、[Billing 文档](https://github.com/fishmem-labs/fishmem/blob/e37457a24659a287e6c804498e5e165acca5ed86/apps/docs/content/docs/cloud/billing.mdx#L24-L29)

## 同口径比较

### 标准化公式

只比较两边共同公开的核心操作，并把 Mem0 的 retrieval 当作一次 memory search：

```text
FishMem credits = 2 × inferred_add_requests + 1 × search_requests
```

Mem0 每个有数字上限的公开自助档都给了 10:1 的 add/retrieval 配额。因此用 `A` 表示 add、`R = A / 10` 表示 retrieval 时：

```text
FishMem credits = 2A + R = 2.1A
```

### Mem0 套餐配额映射到 FishMem

| 基准 | Mem0 月度请求配额 | FishMem 所需 credits | FishMem 当前 credits | 月价对比 | 结论 |
| --- | ---: | ---: | ---: | ---: | --- |
| Hobby | 10k add + 1k retrieval | 21k | 21k | Free vs Free | 完全相同 |
| Starter | 50k add + 5k retrieval | 105k | 105k | $19 vs $19 | 完全相同 |
| Growth | Mem0 无此档 | 若沿用 10:1，420k = 200k add + 20k search | 420k | 无直接对照 | 不能声称相对 Mem0 折扣 |
| Pro | 500k add + 50k retrieval | 1.05m | 1.05m | $249 vs $249 | 操作容量与价格相同；FishMem 项目权益更弱 |

这是当前最公平的套餐级比较。它不假设两边的检索质量、LLM token 消耗、payload 上限、延迟或生成的 memory 数相同。

### 不同工作负载下，FishMem Starter 的表面容量

| 工作负载 | FishMem Starter（105k credits） | Mem0 Starter 公开配额 | 容量比 | 可下的结论 |
| --- | ---: | ---: | ---: | --- |
| 只做 inferred add | 52,500 | 50,000 add | 1.05× | FishMem 约多 5%，不是半价 |
| 10:1 inferred add/search | 50,000 + 5,000 | 50,000 + 5,000 | 1.00× | 同价同容量 |
| 只做 search | 105,000 | 5,000 retrieval | 21× | FishMem 的共享池对 search-heavy 流量明显更有利 |
| 只做 verbatim add | 105,000 | 50,000 add | 2.10× | FishMem raw 写入表面容量更高；Mem0 未公布 `infer:false` 的独立价格权重 |

Pro 的比例完全相同：52.5 万 inferred add 对 50 万、105 万 search 对 5 万 retrieval、10:1 混合负载完全相同。

注意：FishMem 的免费 `get/list` 是按 ID 或列表读取，不等同于语义 search。Mem0 公开页没有说明 get/list/history 是否占 retrieval quota，因此不能把“FishMem reads free”直接宣传成“Mem0 每次读都收费”。

## 单位价格与当前价格梯度

| FishMem 计划 | 月价 | Credits | 每 100k credits | 每次 inferred add 的名义价 | 每次 search 的名义价 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Starter | $19 | 105k | $18.10 | $0.000362 | $0.000181 |
| Growth | $79 | 420k | $18.81 | $0.000376 | $0.000188 |
| Pro | $249 | 1.05m | $23.71 | $0.000474 | $0.000237 |

以上名义价假设当月 credits 全部用完，且该 credit 只用于表中对应操作；它不是 FishMem 的超额报价或实际 COGS。

**计算/推断：** FishMem 当前不是 volume discount：Growth 每 credit 比 Starter 贵约 4%，Pro 比 Starter 贵约 31%。Mem0 自身也有同样的 Starter → Pro 价格曲线，因为 Pro 的容量是 Starter 的 10 倍、价格却是 13.1 倍；但 Mem0 用无限项目和高级功能解释了部分溢价，FishMem 当前所有自助档仍是 1 个项目。

因此，FishMem 当前 Pro 同时存在两个商业问题：

1. 与 Mem0 Pro 同价、同一标准流量容量，却少了公开可确认的多项目和支持/分析权益。
2. 相比自己的 Starter，购买更大容量反而支付更高单位价。

## “只有 Mem0 一半价格”需要先定义哪一种一半

| 目标定义 | Starter 门槛 | Pro 门槛 | 能否据此宣称半价 |
| --- | ---: | ---: | --- |
| 同等标准容量，月费为 Mem0 的 50% | FishMem 105k credits ≤ **$9.50/月** | FishMem 1.05m credits ≤ **$124.50/月** | 可以对指定 10:1 inferred-add/search 组合说“月费一半”；仍需标注项目/功能差异 |
| 月费维持相同，有效单位价为 Mem0 的 50% | `$19` 至少 **210k credits** | `$249` 至少 **2.10m credits** | 应说“同价 2× 标准容量”或“该组合有效单位价低 50%”，不应说 sticker price 一半 |
| 只把现有 Growth 从 $79 砍到 $39.50 | 不是 Mem0 公开档位 | 不是 Mem0 公开档位 | 只能说 FishMem Growth 自身降价 50%，不能说是 Mem0 的一半 |

**当前答案：不能。** 现在 Starter / Pro 的 sticker price 和标准化容量都与 Mem0 一样；对外宣传“Mem0 一半价格”会失真。

## 当前默认模型的满额 COGS 情景

下面不是生产毛利报表，而是用当前可验证默认值做的压力测试：生产 `engine_config` 没有 provider override，部署变量也没有 `OPENAI_BASE_URL` / 模型覆盖，因此代码会使用 `gpt-4o-mini` 与 `text-embedding-3-small`；一次 inferred add 做一次抽取调用，再按抽取出的事实做 embedding。[默认 LLM](https://github.com/fishmem-labs/fishmem/blob/e37457a24659a287e6c804498e5e165acca5ed86/packages/fishmem/src/llms/openai.ts#L28-L35)、[默认 embedding](https://github.com/fishmem-labs/fishmem/blob/e37457a24659a287e6c804498e5e165acca5ed86/packages/fishmem/src/embeddings/openai.ts#L37-L44)、[单次抽取路径](https://github.com/fishmem-labs/fishmem/blob/e37457a24659a287e6c804498e5e165acca5ed86/packages/fishmem/src/memory.ts#L1022-L1046)

按 OpenAI 当前公开价，`gpt-4o-mini` 为 `$0.15 / 1M input tokens`、`$0.60 / 1M output tokens`，`text-embedding-3-small` 为 `$0.02 / 1M tokens`。[OpenAI gpt-4o-mini](https://developers.openai.com/api/docs/models/gpt-4o-mini)、[OpenAI text-embedding-3-small](https://developers.openai.com/api/docs/models/text-embedding-3-small)

用当前 prompt 和 `gpt-tokenizer` 构造三个情景；它们是成本敏感性样本，不是实际用户流量分布：

| inferred add 情景 | LLM input | LLM output | 事实 embedding tokens | AI 成本 / add | 50k adds | 500k adds |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 短：1 个事实 | 1,008 | 42 | 6 | `$0.00017652` | `$8.83` | `$88.26` |
| 中：5 个事实 | 1,340 | 190 | 40 | `$0.00031580` | `$15.79` | `$157.90` |
| 长：5 个事实 | 2,700 | 190 | 40 | `$0.00051980` | `$25.99` | `$259.90` |

这里还没计 search embedding、Workers/D1/Vectorize、日志、失败重试、支持和退款；常见短查询下 search embedding 相对抽取调用很小，但不是零。当前抽取 system prompt 自身约 986 tokens，所以对短请求而言，固定 prompt 是主要输入成本。

为了看“半价”是否有空间，再用 Stripe 美国标准卡公开费率 `2.9% + $0.30`，加 Stripe Billing pay-as-you-go `0.7%` 做示例；实际地域、卡种、税务和 Stripe 合同可能不同。[Stripe Payments pricing](https://stripe.com/pricing)、[Stripe Billing pricing](https://stripe.com/billing/pricing)

| 套餐情景 | 扣示例 Stripe 费后收入 | 短 AI 成本后的余额 | 中 AI 成本后的余额 | 长 AI 成本后的余额 |
| --- | ---: | ---: | ---: | ---: |
| Starter 当前 `$19`、满 50k adds | `$18.02` | `$9.19` | `$2.23` | `-$7.97` |
| Starter 半价 `$9.50`、满 50k adds | `$8.86` | `$0.03` | `-$6.93` | `-$17.13` |
| Pro 当前 `$249`、满 500k adds | `$239.74` | `$151.48` | `$81.84` | `-$20.16` |
| Pro 半价 `$124.50`、满 500k adds | `$119.72` | `$31.46` | `-$38.18` | `-$140.18` |

这张表说明：**以当前模型、prompt 和固定 2-credit 计量，Starter 直接半价几乎没有安全边际；Pro 在短请求下可行，但在中长请求满额时仍会亏。** 实际平均利用率低于 100% 会改善结果，重试、大 payload 和更多抽取事实会恶化结果。生产表目前没有足够的 inferred-add 样本来替代这个情景模型。

## 是否能安全做到一半：当前无法确认的成本项

要回答“能不能盈利地做到一半”，至少还缺以下生产数据：

1. inferred add 的 input/output token p50、p90、p95、p99，以及按 payload byte/message 数的成本曲线；
2. 实际 LLM、embedding、reranker 的供应商、模型版本、合同价与 fallback 比例；
3. 一次 add 最终生成的 memory 数、embedding 次数、冲突检查/图更新次数；
4. search 的 Vectorize/D1/Workers CPU、读取、带宽与缓存命中成本；
5. 文档提取的 Docling worker、R2 存储、失败重试和退款成本；
6. Stripe fee、退款/拒付、支持与日志保留成本；
7. 各档套餐的实际 credit 利用率和流量 mix；未使用额度会改善毛利，满额与尾部大请求会恶化毛利；
8. 当前固定 `2 credits / inferred add` 对 1 条短消息和 500 条、250KB 请求完全同价的尾部风险。

在这些数据缺失时，只能给出**价格数学门槛**，不能给出**毛利可行性结论**。

## 建议

1. **现在不要宣称“Mem0 半价”。** 可准确表达为：“共享 credits；读取/list 免费；search-heavy 与 verbatim workload 可获得更高有效容量。”每项都要带工作负载口径。
2. **先修价格梯度。** 即使暂不半价，Growth / Pro 的每 credit 单价也不应高于 Starter，除非页面明确展示足够强的额外权益；当前 Pro 的 1-project 限制尤其削弱同价竞争力。
3. **先做真实 COGS 仪表盘再降价。** 按 operation、模型、payload bucket、成功/失败/重试、存储和 Stripe 分摊，输出每 1,000 credits 的 p50/p95 COGS 与满额毛利。
4. **为 inferred add 加成本护栏。** 至少评估按输入 token/byte 分段 credits，或收紧固定 2-credit lane 的 payload 上限，避免半价后由大请求放大亏损。
5. **若数据证明可行，再选一种清晰策略：**
   - 真半价：Starter ≤ $9.50、Pro ≤ $124.50，容量不变；或
   - 同价双倍：Starter ≥ 210k、Pro ≥ 2.10m credits，并只对明确的 10:1 inferred-add/search 组合宣传 50% 更低有效单位价。

## 证据边界

- 本报告没有登录 Mem0 控制台、购买套餐或触发收费；只使用 Mem0 第一方公开页面。
- 本报告没有用 fixture、搜索结果摘要或旧博客代替当前定价页。
- `$` 的币种在两边公共卡片上未展开写明；报告保留页面原始符号，不自行声称税费或地域定价。
- Mem0 的 usage-based rate、annual discount、短周期 rate limit、get/list 计量、payload 上限均未公开确认。
- FishMem 的生产真实 COGS、利用率和毛利不在源码中，不能从 credits 数量反推。

## 第一方来源

### Mem0

- [Pricing](https://mem0.ai/pricing)
- [Add Memories API](https://docs.mem0.ai/api-reference/memory/add-memories)
- [Add Memory concepts](https://docs.mem0.ai/core-concepts/memory-operations/add)
- [Search Memories API](https://docs.mem0.ai/api-reference/memory/search-memories)
- [Platform vs Open Source](https://docs.mem0.ai/platform/platform-vs-oss)
- [Platform Access and Usage Agreement](https://mem0.ai/terms)

### FishMem

- [Production pricing](https://fishmem.com/pricing)
- [Plan catalog at FishMem Cloud `651bf8a`](https://github.com/fishmem-labs/fishmem-cloud/blob/651bf8a57cf89accea5e52b4f70590fb87d7ff64/web/lib/billing-plans.ts#L24-L75)
- [Hosted credits at FishMem Cloud `651bf8a`](https://github.com/fishmem-labs/fishmem-cloud/blob/651bf8a57cf89accea5e52b4f70590fb87d7ff64/web/lib/server/hosted-usage-ledger.ts#L29-L65)
- [One-project enforcement at FishMem Cloud `651bf8a`](https://github.com/fishmem-labs/fishmem-cloud/blob/651bf8a57cf89accea5e52b4f70590fb87d7ff64/web/lib/server/app-api.ts#L306-L329)
- [Usage and credits at FishMem `e37457a`](https://github.com/fishmem-labs/fishmem/blob/e37457a24659a287e6c804498e5e165acca5ed86/apps/docs/content/docs/cloud/usage-and-credits.mdx#L10-L38)
- [Add request bounds at FishMem `e37457a`](https://github.com/fishmem-labs/fishmem/blob/e37457a24659a287e6c804498e5e165acca5ed86/packages/contracts/src/index.ts#L9-L10)
- [Add request schema at FishMem `e37457a`](https://github.com/fishmem-labs/fishmem/blob/e37457a24659a287e6c804498e5e165acca5ed86/packages/contracts/src/index.ts#L351-L374)
