<p align="center">
  <img src="./apps/web/public/logo.svg" width="88" alt="FishMem 标志" />
</p>

<h1 align="center">FishMem</h1>

<p align="center"><strong>让 Agent 拥有可信的长期记忆。</strong></p>

<p align="center">
  面向 Chat 与 Agent 应用的开源记忆基础设施。
</p>

<p align="center">
  <a href="./README.md">English</a>
  · <a href="https://docs.fishmem.com">文档</a>
  · <a href="https://fishmem.com">Cloud</a>
  · <a href="https://downloads.fishmem.com/desktop/mac/latest/FishMem.dmg">Desktop</a>
  · <a href="https://docs.fishmem.com/open-source/self-hosted-dashboard">自部署</a>
</p>

<p align="center">
  <a href="https://github.com/fishmem-labs/fishmem/actions/workflows/ci.yml"><img src="https://github.com/fishmem-labs/fishmem/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://www.npmjs.com/package/fishmem"><img src="https://img.shields.io/npm/v/fishmem?label=engine" alt="npm engine 版本" /></a>
  <a href="https://www.npmjs.com/package/@fishmem/sdk"><img src="https://img.shields.io/npm/v/%40fishmem%2Fsdk?label=TypeScript%20SDK" alt="TypeScript SDK 版本" /></a>
  <a href="https://pypi.org/project/fishmem/"><img src="https://img.shields.io/pypi/v/fishmem?label=Python%20SDK" alt="Python SDK 版本" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="Apache 2.0 许可证" /></a>
</p>

FishMem 让 AI 应用拥有持久记忆，同时避免把数据变成无法检查的黑盒。
它将对话提炼为记录，为长文本和文件保留原文，并通过 Dashboard 搜索和管理
已经保存的记忆。

你可以把引擎嵌入应用、自部署 API 与 Dashboard、使用 FishMem Cloud，或在
Mac 上通过 FishMem Desktop 为 Codex 和 Claude Code 提供本地记忆。

## 为什么选择 FishMem

- **每次写入都可追踪。** 幂等键、异步事件、操作状态、历史记录和结构化错误，
  让写入结果清晰可见。
- **由你决定什么成为记忆。** `infer: true` 保存 LLM 精炼后的记录；
  `infer: false` 原样保存你已经整理好的内容。
- **事实变化也有历史。** 更新不会把新旧信息堆成互相冲突的句子，而是保留
  历史和时间语境。
- **文件仍然是文件。** 长文本和文件进入独立的文档路径，保留原文，并生成
  可重建的 RAG 索引。
- **一个产品，多种部署方式。** 嵌入式引擎、自部署 API、Cloud、官方 SDK 和
  Desktop 共享同一套记忆契约。
- **迁移路径清晰。** FishMem 使用熟悉的 `user_id`、`agent_id` 和 `run_id`
  范围，并提供[从 mem0 迁移的明确说明](https://docs.fishmem.com/cloud/migrate-from-mem0)。

## 评测快照

2026-08-24 冻结的全量评测对 FishMem 与 mem0 OSS `3.1.2` 使用完全相同的
输入和评分协议。两者均使用 `gpt-5.6-luna` 写入记忆、
`text-embedding-3-small` 生成 Embedding，并由无状态、只读的 Codex
`gpt-5.6-sol` 生成答案。三个必测数据集中，FishMem 在两个数据集上的配对
置信区间为正，因而通过仓库质量门禁；落后的结果也在同一张表中完整展示。

| Benchmark | 配对题数 | FishMem | mem0 | 配对差值（95% CI） |
| --- | ---: | ---: | ---: | ---: |
| LongMemEval `oracle` | 500 | 88.2% | 83.8% | +4.4 pt（+1.0 至 +7.8） |
| BEAM `100k` | 400 | 46.7% | 41.0% | +5.7 pt（+1.8 至 +9.5） |
| LOCOMO，类别 1–5 | 1,986 | 67.5% | 71.1% | -3.7 pt（-5.8 至 -1.5） |

这里的 LongMemEval 是 `oracle` 变体，不是 LongMemEval-S，不能与公开的
LongMemEval-S 人类参考成绩比较。由于复用的两个基线运行包含中断后恢复的
进程，本次不发布总成本和端到端总耗时结论。FishMem 在 LongMemEval 和 BEAM
胜项中检索的平均上下文 Token 仍约为 mem0 的 9.2 倍和 24.1 倍，上下文效率
仍需优化。完整的 artifact hash、provider endpoint、模型与运行时 manifest、
分类结果、延迟、用量和发布限制见[完整证据报告](./benchmarks/reports/evidence-2026-08-24.md)。

## 快速开始

使用 TypeScript SDK 连接 FishMem Cloud 或自部署服务：

```bash
npm install @fishmem/sdk
```

```ts
import { FishMem } from "@fishmem/sdk";

const fishmem = new FishMem({
  apiKey: process.env.FISHMEM_API_KEY!,
  // baseUrl: "https://memory.example.com", // 自部署地址
});

await fishmem.memories.addAndWait(
  {
    messages: [{ role: "user", content: "I prefer concise answers." }],
    user_id: "alex",
  },
  { idempotencyKey: "alex-answer-style-v1" },
);

const { results } = await fishmem.memories.search({
  query: "How should I answer Alex?",
  user_id: "alex",
});

console.log(results);
```

Python 提供相同 API 的同步与异步客户端：

```bash
pip install fishmem
```

查看 [SDK 快速开始](https://docs.fishmem.com/sdk/quickstart)、
[Python 指南](https://docs.fishmem.com/sdk/python)和
[REST API 参考](https://docs.fishmem.com/api-reference)。

## 清晰的记忆契约

| 输入 | 模式 | FishMem 保存的内容 |
| --- | --- | --- |
| 对话 | `infer: true` | 精炼后的 canonical records |
| 已整理记录 | `infer: false` | 原样保存提交内容 |
| 长文本或文件 | `documents` | 保留原文和可搜索的 RAG 索引 |
| 对话（嵌入式引擎，显式启用） | `episodes.archive: true` | 在 canonical records 之外保存带角色的 user/assistant 原始历史 |

Canonical memory 只有一个 writer：启用推理时，FishMem 不会再把原始输入作为
第二条 canonical record 保存。确实需要逐字对话召回的应用，可以在嵌入式引擎
中显式启用独立的非损 Episode archive。由于原始历史具有不同的隐私与留存契约，
Episode 归档和检索默认关闭；应用可在单次写入中使用 `archiveEpisode: false`
关闭归档，也可独立删除 Episode。推理失败时，canonical records 与 Episode
都不会写入，也不会静默退回原始 canonical 存储。

## 选择部署方式

| 方式 | 适用场景 | 开始使用 |
| --- | --- | --- |
| 嵌入式引擎 | 在 TypeScript 服务内直接使用记忆 | `npm install fishmem` |
| 自部署 | 拥有自己的 REST API 和 Web Dashboard | [部署指南](https://docs.fishmem.com/open-source/self-hosted-dashboard) |
| FishMem Cloud | 托管 API、Dashboard 和运维能力 | [fishmem.com](https://fishmem.com) |
| FishMem Desktop | Codex 与 Claude Code 的私有本地记忆 | [下载 macOS 版本](https://downloads.fishmem.com/desktop/mac/latest/FishMem.dmg) |

Desktop 使用本地 SQLite 数据库和本地多语言 Embedding，不会调用托管 LLM
或远程 Embedding 服务。

## 已包含的能力

- 记忆的添加、搜索、列表、详情、更新、删除和历史 API。
- 保留来源的文档摄取与检索。
- 批量操作、反馈、事件、导出和导入。
- 官方 TypeScript 与 Python SDK。
- 管理项目、API Key、记忆、来源和操作的自部署 Dashboard。

继续查看[完整文档](https://docs.fishmem.com)、[示例](./examples)和
[架构说明](./docs/ARCHITECTURE.md)。

## 开发

FishMem 需要 Node.js 20 或更高版本，以及 pnpm。

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm lint
```

本地环境、集成测试和贡献流程请查看 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 项目状态

FishMem 当前版本为 `0.2.0`，仍在快速迭代。升级前请查看
[发布说明](https://docs.fishmem.com/release-notes)。Benchmark 代码和复现说明
位于 [`benchmarks/`](./benchmarks)。

## 社区

- 通过 [GitHub Issues](https://github.com/fishmem-labs/fishmem/issues)提交
  Bug 和功能建议
- 通过[安全策略](./SECURITY.md)报告安全问题
- 在[路线图](./docs/ROADMAP.md)查看当前优先级

## 许可证

Apache 2.0 — 详见 [LICENSE](./LICENSE)。
