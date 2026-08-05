<p align="center">
  <img src="./apps/web/public/logo.svg" width="88" alt="FishMem logo" />
</p>

<h1 align="center">FishMem</h1>

<p align="center"><strong>Memory your agents can trust.</strong></p>

<p align="center">
  Open-source memory infrastructure for chat and agent applications.
</p>

<p align="center">
  <a href="./README_CN.md">简体中文</a>
  · <a href="https://docs.fishmem.com">Documentation</a>
  · <a href="https://fishmem.com">Cloud</a>
  · <a href="https://downloads.fishmem.com/desktop/mac/latest/FishMem.dmg">Desktop</a>
  · <a href="https://docs.fishmem.com/open-source/self-hosted-dashboard">Self-host</a>
</p>

<p align="center">
  <a href="https://github.com/fishmem-labs/fishmem/actions/workflows/ci.yml"><img src="https://github.com/fishmem-labs/fishmem/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://www.npmjs.com/package/fishmem"><img src="https://img.shields.io/npm/v/fishmem?label=engine" alt="npm engine version" /></a>
  <a href="https://www.npmjs.com/package/@fishmem/sdk"><img src="https://img.shields.io/npm/v/%40fishmem%2Fsdk?label=TypeScript%20SDK" alt="TypeScript SDK version" /></a>
  <a href="https://pypi.org/project/fishmem/"><img src="https://img.shields.io/pypi/v/fishmem?label=Python%20SDK" alt="Python SDK version" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="Apache 2.0 license" /></a>
</p>

FishMem gives AI applications durable memory without turning stored context
into a black box. It refines conversations into records, keeps long-form
sources intact for RAG, and provides a dashboard to search and manage what was
saved.

Embed the engine, self-host the API and dashboard, use FishMem Cloud, or keep
coding-agent memory on your Mac with FishMem Desktop.

## Why FishMem

- **Writes you can follow.** Idempotency keys, asynchronous events, operation
  status, history, and structured errors make write outcomes observable.
- **You decide what becomes memory.** Use `infer: true` for LLM-refined records
  or `infer: false` to store content you have already prepared exactly as sent.
- **Facts can change.** Updates retain history and temporal context instead of
  flattening every correction into another conflicting sentence.
- **Sources stay sources.** Long text and files use a separate document path
  that retains the original and builds a rebuildable RAG index.
- **One product, several ways to run.** The embedded engine, self-hosted API,
  Cloud, first-party SDKs, and Desktop share the same memory contracts.
- **Migration is explicit.** FishMem uses familiar `user_id`, `agent_id`, and
  `run_id` scopes, with a [documented path](https://docs.fishmem.com/cloud/migrate-from-mem0)
  for moving from mem0.

## Quickstart

Install the TypeScript SDK for FishMem Cloud or a self-hosted FishMem service:

```bash
npm install @fishmem/sdk
```

```ts
import { FishMem } from "@fishmem/sdk";

const fishmem = new FishMem({
  apiKey: process.env.FISHMEM_API_KEY!,
  // baseUrl: "https://memory.example.com", // self-hosted
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

Python applications use the same API with synchronous and asynchronous
clients:

```bash
pip install fishmem
```

See the [SDK quickstart](https://docs.fishmem.com/sdk/quickstart),
[Python guide](https://docs.fishmem.com/sdk/python), and
[REST API reference](https://docs.fishmem.com/api-reference).

## A clear memory contract

| Input | Mode | What FishMem stores |
| --- | --- | --- |
| Conversation | `infer: true` | Refined records only |
| Prepared record | `infer: false` | Submitted content verbatim |
| Long text or file | `documents` | Retained source and searchable RAG index |

FishMem does not store both raw conversation and refined records for the same
write. If inference fails, it does not silently fall back to raw storage.

## Choose how to run

| Path | Best for | Start here |
| --- | --- | --- |
| Embedded engine | Memory inside a TypeScript service | `npm install fishmem` |
| Self-hosted | Your own REST API and web dashboard | [Deployment guide](https://docs.fishmem.com/open-source/self-hosted-dashboard) |
| FishMem Cloud | Managed API, dashboard, and operations | [fishmem.com](https://fishmem.com) |
| FishMem Desktop | Private local memory for Codex and Claude Code | [Download for macOS](https://downloads.fishmem.com/desktop/mac/latest/FishMem.dmg) |

Desktop uses a local SQLite database and local multilingual embeddings. It does
not call a hosted LLM or remote embedding provider.

## What is included

- Memory add, search, list, get, update, delete, and history APIs.
- Source-backed document ingestion and retrieval.
- Batch operations, feedback, events, export, and import.
- First-party TypeScript and Python SDKs.
- A self-hosted dashboard for projects, API keys, memories, sources, and
  operations.

Explore the [documentation](https://docs.fishmem.com),
[examples](./examples), and [architecture](./docs/ARCHITECTURE.md).

## Development

FishMem requires Node.js 20 or newer and pnpm.

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm lint
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for local setup, integration tests,
and contribution guidelines.

## Project status

FishMem is at `0.1.0` and under active development. Review the
[release notes](https://docs.fishmem.com/release-notes) before upgrading.
Benchmark code and reproducibility notes live in [`benchmarks/`](./benchmarks);
the README does not present historical experiments as current product claims.

## Community

- [GitHub Issues](https://github.com/fishmem-labs/fishmem/issues) for bugs and
  feature requests
- [Security policy](./SECURITY.md) for responsible disclosure
- [Roadmap](./docs/ROADMAP.md) for current priorities

## License

Apache 2.0 — see [LICENSE](./LICENSE).
