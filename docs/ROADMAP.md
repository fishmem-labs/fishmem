# FishMem Roadmap

FishMem is building one memory contract across Desktop, self-hosted Web, and
FishMem Cloud. The roadmap is intentionally narrow: strengthen the canonical
writer, retrieval evidence, operational reliability, and distribution before
adding more memory taxonomies or provider-specific paths.

## Product invariants

- `infer=true` performs one extraction operation and stores only refined
  canonical records.
- `infer=false` stores submitted records as-is.
- Exact long text and files use the source-preserving Document + RAG corpus.
- Workspace/project namespace is structural; user, agent, and run scopes are
  fail-closed filters inside that boundary.
- Desktop is local-only: SQLite/libSQL plus a managed local embedding model,
  with no remote embedding or silent fallback.
- Desktop, Web, Cloud, TypeScript, and Python consume one contract and one
  application module.
- State, profile, graph, FTS, and vector indexes are provenance-linked,
  rebuildable projections rather than competing stores.

## v0.1 foundation

The initial public release includes:

- mem0-style add, search, list, get, update, delete, delete-all, history, and
  feedback;
- asynchronous inferred writes with durable Event receipts, operations,
  retries, idempotency, repair, and observable failures;
- logical metadata filters plus structural scope entities;
- immutable memory journal, export/import snapshots, and batch mutations;
- exact textual document ingest and asynchronous file extraction with original
  assets, deterministic chunks, and citation-ready search;
- self-hosted TanStack dashboard with memories, sources, entities, operations,
  requests, configuration, API keys, and webhooks;
- universal TypeScript and sync/async Python SDKs, including explicit Desktop
  adapters;
- macOS Desktop with local semantic search, provenance, history, correction,
  deletion, export, and Codex/Claude Code integration;
- Node/Docker and Cloudflare adapters behind the same application contracts;
- OpenAPI-derived reference docs, SDK guides, integrations, and cookbooks.

## Next release gates

### Distribution

- Verify every published package from a clean npm/PyPI install.
- Keep GitHub releases, checksums, signed Desktop artifacts, public downloads,
  and documentation versions aligned.
- Add update-channel metadata only after the updater contract is implemented
  and tested end to end.

### Retrieval evidence

- Run current FishMem and current mem0 under one frozen LOCOMO protocol.
- Add paired LongMemEval and BEAM evidence where both systems can complete the
  same harness.
- Report answer quality, latency, context tokens, provider usage, failures, and
  confidence intervals; do not turn a narrow result into a general claim.
- Keep state/profile, decay, reranking, and new graph signals opt-in until an
  ablation shows a production-relevant gain.

### Async document operations

- Exercise sustained upload/extraction/search load on Cloudflare and Docker.
- Publish queue, retry, dead-letter, retention, recovery, and query-latency
  service objectives.
- Prove deletion removes every raw asset, artifact, chunk, vector, and current
  source pointer without weakening the audit contract.

### Ecosystem

- Maintain first-party examples for OpenAI Agents, Vercel AI SDK, LangGraph,
  CrewAI, Cloudflare Agents, Codex, and Claude Code.
- Add framework-specific packages only when they remove real integration
  policy; thin wrappers should remain documentation examples.
- Expand deployment guides from clean machines and fresh accounts, not from
  maintainer state.

## Deliberate non-goals

- No second writer, hidden fallback, dual canonical store, or duplicated DTO
  hierarchy.
- No compatibility layer for behavior that conflicts with the current write or
  scope contract.
- No provider proliferation solely to match a competitor's integration count.
- No mandatory palace/closet/tier taxonomy, graph database, or LLM call during
  default search without same-harness evidence.
- No claim that FishMem beats another product without a disclosed comparable
  evaluation.

Implementation status and acceptance evidence are tracked in
[EXECUTION-PLAN.md](./EXECUTION-PLAN.md). Benchmark protocol details live in
[benchmarks/EVAL-PLAN.md](../benchmarks/EVAL-PLAN.md), and selective prior-art
decisions are recorded in [PRIOR-ART.md](./PRIOR-ART.md).
