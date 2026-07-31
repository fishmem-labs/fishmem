<p align="center">
  <h1 align="center">🐟 fishmem</h1>
  <p align="center"><b>One private memory. Every agent.</b></p>
  <p align="center">Time-aware, relationship-aware, mem0-compatible — and fast.</p>
</p>

<p align="center">
  <a href="https://fishmem.com">Cloud Platform</a>
  ·
  <a href="#-quickstart">Quickstart</a>
  ·
  <a href="#-running-the-project-self-host">Self-host</a>
  ·
  <a href="#-benchmarks">Benchmarks</a>
  ·
  <a href="./docs/ROADMAP.md">Roadmap</a>
  ·
  <a href="./docs/ARCHITECTURE.md">Architecture</a>
  ·
  <a href="./docs/PRODUCT.md">Product Strategy</a>
  ·
  <a href="./CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
  <a href="https://github.com/fishmem-labs/fishmem/actions/workflows/ci.yml"><img src="https://github.com/fishmem-labs/fishmem/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License"></a>
  <img src="https://img.shields.io/badge/TypeScript-strict-3178c6.svg" alt="TypeScript">
  <img src="https://img.shields.io/badge/node-%E2%89%A518-339933.svg" alt="Node">
  <img src="https://img.shields.io/badge/runtime-Node%20%7C%20Cloudflare%20Workers-f38020.svg" alt="Runtimes">
</p>

> 📊 **Benchmarks (vs mem0's official TypeScript OSS SDK `mem0ai` v3.0.6, one
> shared LOCOMO harness, identical models + isolated in-memory stores):** on a
> **10-conversation run (1,540 paired questions)**, fishmem's verbatim/RAG architecture
> is **+12.8pt overall** (70.1% vs 57.3%, exact McNemar **p ≈ 0**, net +196
> questions) — winning **single-hop** (+11.2pt, p=2.5e-11) and **temporal**
> (+28.7pt, p=3.4e-14), with **~5× faster search** and **fewer stored memories**
> (1,569 vs 5,047). We report paired significance, not point estimates.
> This is a historical `mem0ai` 3.0.6 result; the current harness pins 3.1.2
> and requires a clean paired rerun before replacing this baseline. It measured
> the former verbatim/RAG experiment, not the current production-default
> `infer:true` extraction path.
> [Methodology →](./benchmarks)

## What is fishmem?

fishmem gives AI agents and assistants persistent, queryable long-term memory.
It exposes a mem0-style API with explicit migration differences. The engine
underneath is built around two ideas most memory layers miss:

- **Memory has a timeline.** Facts carry *event time* separately from
  *ingestion time* (`eventDate` / `validFrom` / `validTo`). When new
  information supersedes the old, the old fact is **invalidated, not
  deleted** — "where did she live before?" keeps working.
- **Memory has structure.** Memories form a typed graph in your relational
  database (`updates`, `caused_by`, `contradicts`, …), and recall runs
  **Personalized PageRank** over it, fused with vector, keyword, and
  time-filtered candidates through weighted Reciprocal Rank Fusion.

### Key capabilities

- 🧠 **Multi-level memory**: user, agent, and run scopes with metadata
  filters — mem0-compatible (`add / search / get / getAll / update / delete /
  history / reset`).
- ⏳ **Bi-temporal facts** with supersede-not-delete semantics and full
  per-memory change history.
- 🕸️ **Hybrid recall**: vector + temporal stream + PPR graph diffusion (RRF-
  fused), lexical keyword search opt-in, with an optional LLM reranker.
- 👤 **Profile blocks**: an always-injectable synthesis of identity,
  preferences, and per-topic aggregations that top-k retrieval structurally
  misses.
- 📚 **Source-backed RAG**: exact UTF-8 originals plus asynchronous
  PDF/Office/image extraction, immutable versions, deterministic chunks with
  byte offsets, and hybrid evidence retrieval live beside—but never masquerade
  as—conversational memory.
- 🌗 **Memory lifecycle**: importance scoring, decay, consolidation, pruning,
  optional working/graph tiers.
- 🗄️ **Your database**: Postgres, SQLite (libSQL/Turso), or Cloudflare D1 via
  one Drizzle adapter; vectors in pgvector, SQLite, Qdrant, or Cloudflare
  Vectorize. No graph database to operate.
- 🪶 **Edge-ready**: zero mandatory native dependencies, lazy driver imports,
  runs on Node and Cloudflare Workers.
- 💰 **Cost-transparent**: `infer:true` is one extraction call;
  `infer:false` is zero LLM calls; search spends no LLM tokens unless reranking
  is explicitly enabled.

### Product surfaces

- **FishMem Desktop** is a privacy-first local memory layer for people using
  Codex and Claude Code. Its value appears inside those agents; the app is the
  control surface for connection, health, provenance, correction, privacy,
  export, and deletion.
- **`apps/web`** is the open-source, self-hostable memory service for
  applications, with a public API, TypeScript and Python SDKs, and operator UI.
- **FishMem Cloud** is the managed commercial edition maintained in the private
  `fishmem-cloud` repository,
  adding hosted operations, billing, teams, governance, and enterprise
  deployment.

The product boundaries and success measures are defined in
[Product Strategy](./docs/PRODUCT.md).

## 📊 Benchmarks

We benchmark against mem0's official TypeScript OSS SDK (`mem0ai` v3.0.6,
June 2026 — the post-rewrite v3 generation with entity linking and BM25
hybrid retrieval) on [LOCOMO](https://github.com/snap-research/locomo) under
one strictly identical protocol: same input chunking, same models
(`gpt-4o-mini` + `text-embedding-3-small`), same top-k, **both engines on
isolated in-memory stores** (fresh per run, no cross-run state), one shared
answer prompt, one blind LLM judge. We report **paired** per-question
significance (exact McNemar), not point estimates.

The table below is the last complete historical paired run. The reproducibility
harness now pins `mem0ai` 3.1.2 and records its exact adapter hash; until a clean
3.1.2 rerun passes `bench:gate`, the table is evidence for 3.0.6 rather than a
claim against the current pinned baseline.

> **Scope:** the table compares the two **open-source TypeScript stacks**.
> We also ran the mem0 hosted platform through this harness (see *Scope & the
> hosted platform* below) — but it is under-represented by a neutral
> small-model harness, so its self-published numbers (e.g. LoCoMo 92.5) come
> from a different, undisclosed setup and are not equated with this table.

**10-conversation run — 1,540 paired questions** (fishmem in verbatim/RAG architecture),
exact McNemar:

| LLM-judge accuracy | fishmem | mem0 OSS | Δ | paired significance |
|---|---|---|---|---|
| **Overall** | **70.1%** | 57.3% | **+12.8pt** | **p ≈ 0** (χ²=87, net +196 q) ✓ |
| **Single-hop** (n=841) | **81.2%** | 70.0% | **+11.2pt** | **p = 2.5e-11** ✓ |
| **Temporal** (n=321) | **64.2%** | 35.5% | **+28.7pt** | **p = 3.4e-14** ✓ |
| Multi-hop (n=282) | 50.7% | 46.1% | +4.6pt | p = 0.19 (ns) |
| Open-domain (n=96) | 49.0% | 52.1% | −3.1pt | p = 0.58 (ns) |
| Search p50 | **~0.98s** | ~4.9s | | ~5× faster (same proxy) |
| Stored memories | **1,569** | 5,047 | | verbatim: fewer, richer |

Honesty notes, because benchmark theater helps nobody:

- **What's solid.** The verbatim advantage **holds at 10-conversation scale and
  is now statistically powered**: +12.8pt overall (exact McNemar p ≈ 0, net +196
  of 1,540 questions). fishmem **wins single-hop** (+11.2pt, p = 2.5e-11) —
  reversing the earlier extraction-primary deficit — and **temporal** (+28.7pt,
  p = 3.4e-14), with ~5× faster search, while storing **fewer** memories (1,569
  vs 5,047) at ~2× cheaper ingest (no write-time extraction LLM).
- **What isn't a win.** Multi-hop (+4.6pt) and open-domain (−3.1pt) are **not
  significant** (p = 0.19, 0.58); open-domain (n = 96) slightly favors mem0. We
  don't claim them.
- **This was a verbatim/RAG experiment.** The measured adapter stored chunks
  verbatim rather than using the current production-default `infer:true`
  extraction path. The result remains historical evidence for document-style
  RAG, not a claim that the shipped conversational memory path has the same
  score. A current-version paired rerun is required.
- **Run-cleanliness caveat.** fishmem dropped **2 of 1,571** chunks to transient
  proxy connection errors (conv-48, after 5 retries) and the harness flagged the
  run "not clean." The loss is **asymmetric against fishmem** (mem0 dropped 0),
  so a clean re-run can only *widen* the gap; at 0.13% of chunks it cannot move a
  p ≈ 0 / +196-question result. A clean re-run lands with the next retrieval
  iteration.
- **Supersedes earlier tables.** (1) A 2-conversation extraction-primary table here
  (58.4% overall, "mem0 leads single-hop") — superseded by verbatim above. (2) An
  even earlier "+7.8pt overall, single-hop tied" table — its mem0 baseline was
  not isolated (`provider:"memory"` was on-disk SQLite accumulating across runs;
  fixed via `dbPath: ":memory:"`).
- **The one real cost: read context.** Verbatim recall feeds bigger answer
  context (1,667 vs mem0's 327 tok/query) — whole chunks vs atomic facts. Small
  in absolute terms (~$0.0003/query on gpt-4o-mini), it buys the accuracy above
  and is tunable (intent-gated context, finer chunks, lower top-k). The trade
  **inverts** mem0's: fishmem is cheap at write, richer at read.
- LOCOMO has ~9% per-question verdict noise; the **paired** McNemar test controls
  for it by scoring both systems on the same questions.

**Scope & the hosted platform.** This compares the open-source TypeScript
stacks. We *also* ran mem0's **hosted platform** through the identical harness
(passing event timestamps via its API, as intended): it scored 34.3% overall
on the held-out split — but so did mem0's own OSS beat the platform here by
+21pt, which tells you the **neutral small-model harness under-represents the
platform** (it is tuned for its own full stack: larger models, managed
reranking, proprietary retrieval). We therefore treat that number as a
harness-fit artifact, **cite** mem0's self-published platform results (LoCoMo
92.5, etc., evaluation setup undisclosed) rather than equate them, and do not
claim a platform win. Only within-harness comparisons count.

**LongMemEval & BEAM (fishmem-only — no mem0 same-harness number available).**
Under the official LongMemEval judge, fishmem scores **68.0%** on the oracle
variant (500 instances; the structured-prompt rebuild lifted preference
questions 13→53% and multi-session 55→62%). On **BEAM 100k** (official
rubric-nugget judge) fishmem scores **32.4%** — strong on abstention (0.70)
but weak on the synthesis abilities (summarization 0.04, contradiction 0.08,
event-ordering 0.17); fishmem is a factual-recall layer, not a summarizer, and
we report the weaknesses plainly. **mem0 same-harness numbers are not
obtainable on our setup**: mem0 OSS's HTTP client does not retry dropped
connections, so on our API proxy it wedges partway through these long runs
(LOCOMO is short enough to finish). So these are **fishmem-only absolute
numbers** — only LOCOMO is a complete fair head-to-head; we **cite** mem0's
self-reported LongMemEval 94.4 / BEAM 64.1 (full hosted stack, undisclosed
setup) and explicitly **do not equate** them. The full-haystack
LongMemEval_S (gpt-4o, ~30h) was started and deferred at 120/500 — fishmem-only
with no mem0 comparison possible, the time/cost did not justify it.

### The memory-benchmark landscape

The field evaluates on many datasets — and reports **two very different metrics**
that are easy to conflate:

- **Retrieval recall** (Recall@k, Hit@k, NDCG) — *did the right chunk make the
  top-k?* What most memory repos headline. Structurally high.
- **End-to-end answer accuracy** (LLM-judge, F1) — *did the system actually answer
  correctly?* The harder, user-facing number — **what fishmem reports.**

These are **not comparable** (recall ≫ answer-accuracy), and cross-repo numbers
use different datasets, models, and configs — almost all **self-reported**. The
only apples-to-apples comparison here is **LOCOMO vs mem0 OSS** (one shared
harness, above). Everything below is context, **not a leaderboard**:

| Benchmark | What it tests | fishmem | Others (self-reported, ≠ our metric) |
|---|---|---|---|
| **LOCOMO** | organic conversational memory (single/multi-hop, temporal, open) | **70.1% answer-acc** (10-conv, vs mem0 OSS 57.3%, same harness ✓) | retrieval R@10: hebb-mind 95.8, MemPalace 88.9 |
| **LongMemEval** | long-horizon session memory, 6 question types (500q) | **68.0% answer-acc** (oracle; fishmem-only) | retrieval: MemPalace R@5 96.6 (98.4 held-out), hebb-mind R@10 83.8; mem0 platform 94.4 |
| **BEAM** | synthesis abilities — summarize, contradiction, ordering (100k) | **32.4%** rubric-nugget (fishmem-only; weak — we're a recall layer, not a summarizer) | mem0 platform 64.1 |
| **MemBench** (ACL'25) | turn-level retrieval precision, 11 categories (~12k) | *exploratory fishmem-only sample; not normalized/publishable* | Hit@5: hebb-mind 94.6, MemPalace 80.3 |
| **ConvoMem** (Salesforce) | typed evidence recall, 6 categories (600q) | *exploratory fishmem-only sample; not normalized/publishable* | recall: MemPalace 92.9, hebb-mind 66.3 |
| **PersonaMem** | persona/preference evolution, 4-way MCQ (589q) | *not yet run* | MCQ acc: hebb-mind 69.4 |
| **MemoryArena** | agentic multi-subtask state carryover | *not yet run* | agentic success-rate (baselines: Mem0 ~0.14 SR) |
| **FinanceBench** | financial-**document** QA (not conversational memory) | *n/a — different domain* | PageIndex 98.7 |

**Read this honestly:** where a peer cell is **retrieval recall** and fishmem's is
**answer accuracy**, the peer number looks higher largely because recall is the
easier metric — not a measured loss for fishmem, which deliberately reports the
harder end-to-end number. MemBench and ConvoMem have only exploratory
fishmem-only samples; PersonaMem and MemoryArena are not implemented. None is
yet a paired, publishable scorecard. mem0-platform /
PageIndex figures are cited from their publications (undisclosed full stacks), not
equated. See [docs/PRIOR-ART.md](./docs/PRIOR-ART.md) for the per-project detail
(mem0 / MemPalace / hebb-mind / TencentDB Agent Memory / MEMANTO — what we
took, left, and why).

Reproduce it yourself: [`benchmarks/`](./benchmarks) ships the harness,
fairness protocol, prompts, and per-question JSON outputs.

## 🚀 Quickstart

### Option 1 — Hosted platform

The fastest path is [fishmem.com](https://fishmem.com): sign up, create an
API key, and call the mem0-compatible REST API — nothing to operate.

```bash
curl -X POST https://fishmem.com/v1/memories \
  -H "Authorization: Bearer $FISHMEM_API_KEY" \
  -H "Idempotency-Key: add-alex-diet-v1" \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "I am vegetarian and allergic to peanuts."}], "user_id": "alex"}'
```

### Option 2 — Library (self-hosted)

```bash
npm install fishmem
```

```ts
import { Memory } from "fishmem";

// Zero-config: in-memory stores + OpenAI if OPENAI_API_KEY is set
// (offline mock providers otherwise — the test suite runs fully offline).
const memory = await Memory.create();
const projectMemory = memory.forNamespace("my-project");

// Add a conversation. infer defaults to true: exactly one LLM call extracts
// refined canonical records and the raw transcript is not stored beside them.
await projectMemory.add(
  [
    { role: "user", content: "Hi, I'm Alex. I'm vegetarian and allergic to peanuts." },
    { role: "assistant", content: "Noted! I'll keep that in mind." },
  ],
  { userId: "alex", idempotencyKey: "add-alex-diet-v1" },
);

// Already distilled content uses the zero-LLM verbatim path.
await projectMemory.add("Alex is vegetarian.", {
  userId: "alex",
  infer: false,
  idempotencyKey: "add-alex-diet-raw-v1",
});

// Hybrid recall: vector + keyword + temporal + graph diffusion, RRF-fused.
const { results } = await projectMemory.search("what can Alex eat?", { userId: "alex" });
for (const r of results) {
  console.log(r.score.toFixed(3), r.memory.content);
}
```

### Production configurations

```ts
// Postgres + pgvector
const memory = await Memory.create({
  llm:        { provider: "openai",   config: { model: "gpt-4o-mini" } },
  embedder:   { provider: "openai",   config: { model: "text-embedding-3-small" } },
  vectorStore:{ provider: "pgvector", config: { connectionString: process.env.DATABASE_URL } },
  graphStore: { provider: "postgres", config: { connectionString: process.env.DATABASE_URL } },
});

// Cloudflare Workers (edge)
const memory = await Memory.create({
  vectorStore: { provider: "vectorize", config: { index: env.VECTORIZE } },
  graphStore:  { provider: "d1",        config: { binding: env.DB } },
});
```

See [`examples/`](./examples) for runnable Postgres, SQLite, and Cloudflare
Worker setups.

## ⚙️ How it works

`add()` has one canonical writer and two explicit inputs:

- `infer:true` (default) makes one LLM extraction call and stores only refined
  records;
- `infer:false` makes zero LLM calls and stores the submitted content
  byte-for-byte (trim is only used to reject empty input).

FishMem never stores both forms for one add and never falls back to raw content
after an extraction failure. Long text and files belong on a source-preserving
document/RAG path, not in the conversational fact extractor. State and profile
are rebuildable materialized views over canonical records.

The HTTP API and both SDKs expose that path as `documents`. Already-textual
UTF-8 content up to 1,000,000 bytes uses synchronous ingest. Supported PDF,
Office, EPUB, email, image, and text files up to 25,000,000 bytes and 300 pages
use an asynchronous source-asset lifecycle: exact-byte upload, Docling
extraction, immutable Markdown/JSON artifacts, then the same canonical
document writer. Raw files never enter the conversational memory path.

Cloudflare keeps raw files and artifacts in R2 and runs Docling in a Container
woken by Queues. Node/Docker uses a durable asset directory, poll worker, and
the same pinned Docling image. Desktop stays local and UTF-8-only; it never
uses remote extraction or embeddings.

```
messages ──▶ infer? ──▶ refined records ─┐
content  ──▶ raw?   ──▶ verbatim record ├─▶ journal + recall index
                                        └─▶ state/profile projections
```

`search()` runs the hybrid recall engine:

```
query ──┬─▶ vector similarity      ├─▶ keyword / FTS
        ├─▶ temporal stream        └─▶ PPR graph diffusion
                          │
   weighted RRF (k = 60) → optional LLM rerank → diversity pass
                          │
        invalidation-chain completion → ranked results
```

Every stage is configurable, and a documented parity configuration reproduces
the original engine the core was ported from. Memory types carry default
importance (`identity` 1.0 → `observation` 0.3); relation types weight graph
edges (`updates` ×1.5 … `contradicts` ×0.5); maintenance runs
demote → decay → consolidate → prune. Design history and the research behind
each technique: [docs/ROADMAP.md](./docs/ROADMAP.md).

<details>
<summary><b>Providers</b></summary>

| Component | Built-in providers |
|---|---|
| LLM | OpenAI, Anthropic, offline mock |
| Embedder | OpenAI (1536d), offline mock (384d) |
| Vector store | in-memory, SQLite/libSQL, pgvector, Qdrant, Cloudflare Vectorize |
| Graph store | in-memory, SQLite/Turso, Postgres, Cloudflare D1 (one Drizzle adapter) |

Pass `{ provider, config }` specs or constructed instances; the derivation
extraction prompt is replaceable (`customFactExtractionPrompt`). `GraphStore`,
`VectorStore`, `Embedder`, and `LLM` are small interfaces — implement your own
backend. Pass `onWarning` to capture recoverable diagnostics such as
zero-config mock-provider fallback, derivation failures, or derived-index
refresh failures; throw from the callback when you want those warnings to fail
fast in tests or production.
</details>

<details>
<summary><b>Cost control</b></summary>

| Feature | LLM cost | Control |
|---|---|---|
| Inferred add | 1 extraction call | `infer:true` (default) |
| Verbatim add | none | `infer:false` |
| State projection | no second extraction call | consumes the inferred add plan |
| Profile blocks | 1 call per `refreshProfile()` | explicit call only |
| LLM rerank | 1 call per search | `search: { rerank: true }` (off by default) |
| Everything else (PPR, RRF, temporal, diversity) | none | on by default |
</details>

## 🐳 Running the project (self-host)

The repo is a monorepo: the engine (`packages/fishmem`), shared application
logic (`packages/application`), shared dashboard UI (`packages/dashboard`), the
TanStack Start control plane (`apps/web`), Electron companion
(`apps/desktop`), and docs (`apps/docs`). You need **Node ≥ 18** (22 recommended)
and **pnpm**. First, from the repo root:

```bash
pnpm install
pnpm --filter fishmem build        # build the engine once — the apps import its dist
```

### Dashboard (`apps/web`)

The control plane: the mem0-compatible memory API, API keys, a memory browser,
a playground, usage views, webhooks, and auth. It runs on **Node with embedded
SQLite by default** — no external services:

```bash
cp apps/web/.env.example apps/web/.env
#  • set OPENAI_API_KEY      (the memory engine uses it for embeddings and optional derivation)
#  • set BETTER_AUTH_SECRET  (generate one: openssl rand -base64 32)
#  .env.example already presets FISHMEM_RUNTIME=node and FISHMEM_DB=libsql.

# create the app tables (better-auth + workspaces + API keys) in the SQLite file:
FISHMEM_DB=libsql pnpm --filter @fishmem/web db:push

# start it:
FISHMEM_RUNTIME=node FISHMEM_DB=libsql pnpm --filter @fishmem/web dev   # → http://localhost:3000
```

**Log in:** open http://localhost:3000 and enter your email. With no email
provider configured, the magic-link is **printed to the server terminal** —
click that link to sign in. (Or configure Google/GitHub OAuth in `.env`.)

Production build instead of `dev`:

```bash
FISHMEM_RUNTIME=node FISHMEM_DB=libsql pnpm --filter @fishmem/web build
FISHMEM_RUNTIME=node FISHMEM_DB=libsql pnpm --filter @fishmem/web start
```

### Docs site (`apps/docs`)

```bash
pnpm --filter docs dev            # → http://localhost:3000 (Fumadocs; use another port if the dashboard is up)
```

### Desktop (`apps/desktop`)

The desktop app is a local SQLite memory store for Codex and Claude Code. It
stores keyword and native vector indexes in the same libSQL/SQLite database.
Its local multilingual embedding model requires no API key or separate vector
database service.

```bash
pnpm --filter @fishmem/desktop dev
pnpm --filter @fishmem/desktop test
pnpm --filter @fishmem/desktop run pack
```

In FishMem Desktop, open **Codex & Claude** and connect either client with one
click. The app installs the local `fishmem` CLI and the appropriate global Agent
Skill. Desktop does not install or require an MCP server.

### SDKs (`packages/sdk`, `packages/python-sdk`)

`@fishmem/sdk` is the typed HTTP client for FishMem Cloud and self-hosted
FishMem. It has no runtime dependencies and uses standard Web APIs, so the same
HTTP entry point runs in Node.js, Bun, Deno, Cloudflare Workers, and Vercel
Functions. `@fishmem/sdk/desktop` is an explicit Node-only adapter for the
local `fishmem` CLI. `fishmem-sdk` provides synchronous and asynchronous Python
HTTP clients plus the same Desktop CLI adapter.

```bash
pnpm --filter @fishmem/sdk typecheck
pnpm --filter @fishmem/sdk test
pnpm --filter @fishmem/sdk build
pnpm --filter @fishmem/python-sdk test
```

See the [SDK documentation](./apps/docs/content/docs/sdk/index.mdx) for client
configuration, memory and document methods, pagination, runtime examples,
errors, and idempotency.

### Docker (no local toolchain needed)

```bash
docker compose up -d web          # just the dashboard (embedded SQLite in a volume) → http://localhost:3000
docker compose up -d              # the whole stack: dashboard + Postgres (pgvector) + docs
```

The dashboard is **runtime-adaptive**: the OSS edition runs on Node + a
relational DB (libSQL/SQLite or Postgres, chosen by `FISHMEM_DB`) and also
deploys to Vercel or Cloudflare; the managed FishMem Cloud application imports
the same contracts and runs on Cloudflare (D1 + Vectorize). Full deployment
matrix, every env var, and the
Postgres/Qdrant/Cloudflare backends: **[DEPLOY.md](./DEPLOY.md)**.

### Test suites

```bash
pnpm --filter fishmem test          # deterministic unit + SQLite contracts
pnpm --filter fishmem test:coverage # enforced coverage thresholds
pnpm bench:test                     # benchmark harness + adapter contracts
```

The real adapter suite requires PostgreSQL with pgvector and Qdrant. It also
runs D1 against the local Miniflare runtime. Missing service configuration is
an error, not a skipped test:

```bash
FISHMEM_POSTGRES_URL=postgres://fishmem:fishmem@localhost:5432/fishmem \
FISHMEM_QDRANT_URL=http://localhost:6333 \
pnpm --filter fishmem test:integration
```

CI provisions pinned PostgreSQL/pgvector and Qdrant service images for this
suite. Cloudflare Vectorize request semantics are covered by a strict binding
contract; remote Vectorize smoke tests require Cloudflare credentials and are
tracked separately.

`memory.forNamespace(namespaceId).exportSnapshot()` returns a versioned JSON
snapshot of canonical graph state, including forgotten rows, history,
associations, entities, mentions, and episodes. Embeddings and derived sidecar
slots are marked for rebuild rather than duplicated. Snapshot import requires
an idempotency key; the HTTP service exposes export/import as asynchronous
operation resources.

## 📚 Documentation

- [Benchmark methodology & fairness protocol](./benchmarks/README.md)
- [API and SDK documentation](./apps/docs/content/docs/index.mdx), including
  [source-backed RAG](./apps/docs/content/docs/api-reference/documents.mdx)
- [Research-driven roadmap](./docs/ROADMAP.md) — what shipped, what's next,
  and the papers behind each technique (HippoRAG, Zep, Letta, Memobase, …)
- [Contributing](./CONTRIBUTING.md) · [Security policy](./SECURITY.md) ·
  [Changelog](./CHANGELOG.md)

## 🌐 Community & support

- [GitHub Issues](https://github.com/fishmem-labs/fishmem/issues) — bugs and
  feature requests (templates provided)
- Email: support@fishmem.com

## 📄 Citation

If you use fishmem or its benchmark harness in your research:

```bibtex
@software{fishmem2026,
  title  = {fishmem: a time-aware, graph-augmented memory layer for AI agents},
  author = {{fishmem contributors}},
  year   = {2026},
  url    = {https://github.com/fishmem-labs/fishmem}
}
```

## License

Apache 2.0 — see [LICENSE](./LICENSE).
