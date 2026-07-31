# Prior art — evaluated external memory/RAG projects

What we read, what we took, what we left. Companion to
[RETRIEVAL-PLAN.md](./RETRIEVAL-PLAN.md) (the borrow backlog) and
[BENCHMARKS.md](../BENCHMARKS.md) (the same-harness mem0 comparison).

> **Comparability caveat — read first.** The headline numbers below are each
> project's **self-reported** results, and most are **retrieval recall** (R@k /
> Hit@k) on **different datasets** (LongMemEval, FinanceBench, MemBench, …).
> fishmem's headline is **end-to-end LLM-judge answer accuracy** on LOCOMO. These
> are **different metrics on different data** — R@k is structurally far higher
> than answer accuracy. **Do not equate them.** Only a **same-harness** run
> (same dataset, models, judge — as we do for mem0 OSS) is a real comparison. We
> **cite, never equate.** (Cautionary tale: Zep self-reported 84 on LOCOMO; mem0's
> own audit measured 58.)

Initial review revisions on 2026-07-10:

| repository | revision |
|---|---|
| hebb-mind | `a8914bbf89352f030a460e839581e97a776640c5` |
| mem0 | `df9d5cc4b151861304bb4f7ec1fdca6d54bbc45a` |
| MemPalace | `18a9788961afce013efc9e2da23ea2b17ab72381` |
| TencentDB Agent Memory | `4339e63650920871eb0e8888083a1779d114e3ae` |
| MEMANTO | `2044fdf1000f45c020ffbfbb630d0341f798cb67` |

Incremental refresh on 2026-07-30:

| repository | refreshed revision | relevant changes inspected |
|---|---|---|
| mem0 | `d4869d24ec01c65c26e2c9d7b8d946be5285766c` | typed fail-closed extraction errors; immutable identity scope on update; compound-filter fixes; TypeScript 3.1.2 / Python 2.0.14 |
| MemPalace | `8ab251c452c43f2b07a76a28f2433e258307f571` (`v3.6.0`) | explicit daemon write routing; palace-scoped derived state; index-divergence fencing and verified FTS5 repair; agent attribution |
| hebb-mind | `36ce983c5644adfe06c176912b58b3284753db7b` | deterministic external-memory import; import result counts; live local-model download progress |

Incremental upstream review on 2026-07-31:

| repository | verified revision | additional transfer decision |
|---|---|---|
| mem0 | `29fa41558cf33263ec961dd9c6ff4245182466ef` | Qdrant server-side BM25/filter indexes are useful acceleration, while the latest Elasticsearch `top_k` and Supabase row-cap/RLS fixes reinforce exact adapter conformance and fail-visible initialization; FishMem keeps one backend-independent predicate plus canonical residual verification |
| MemPalace | `aa89bd82272f55381206c83b6f306e79351824eb` | hostile chunk-overlap validation and cached index-capacity probes are reliability patterns; FishMem already clamps overlap, forces forward progress, and versions local index identity, so only a regression test transfers |
| hebb-mind | `36ce983c5644adfe06c176912b58b3284753db7b` | no upstream change since the 2026-07-30 review; the deterministic observable-import decision remains unchanged |

The refresh was an incremental code review, not acceptance of every new feature.
The decisions below say exactly what transfers to FishMem.

---

## [mem0](https://github.com/mem0ai/mem0) (the baseline competitor)
- **What:** the current public direction is single-pass ADD-only extraction,
  first-class assistant/agent facts, entity linking, semantic + BM25 + entity
  fusion, and temporal ranking. Its managed implementation remains
  proprietary; fishmem compares against the exact OSS TypeScript package that
  can be run under the same harness.
- **Same-harness result (the one comparison that counts):** fishmem-raw beats
  mem0 OSS **+12.8pt** on LOCOMO 10-conv (p≈0) — see BENCHMARKS.md.
- **2026-07-30 transfer:** FishMem adopts the product contract, not mem0's
  implementation topology: `infer=true` performs one extraction call and
  stores only refined records; `infer=false` stores submitted records
  verbatim. Extraction transport or parsing failures are typed, visible
  failures rather than empty success. Identity scope is immutable through
  update metadata. Provider/filter conformance tests are worth copying as
  acceptance patterns.
- **2026-07-31 transfer:** Qdrant's new server-side BM25 and filter indexes
  confirm that pushdown belongs behind the store interface. FishMem's public
  filter meaning stays in one bounded AST/evaluator and every candidate is
  rechecked after hydration; an adapter optimization cannot become an
  authorization or semantic boundary. The platform docs audit also confirms
  that documentation examples must stay executable against OpenAPI and route
  tests rather than describe aspirational behavior.
- **Leave:** provider proliferation, old compatibility aliases, and integration
  packages are distribution work, not reasons to widen MemoryCore. n8n and
  Zapier are useful later only after the canonical API is stable.
- **Verdict:** the public API and product-quality comparator. Its platform
  self-reports ~92.5 LOCOMO (undisclosed full stack) — cited, not equated.

## [MemPalace](https://github.com/MemPalace/mempalace)
- **What:** hybrid agent-memory + file RAG. Three tiers — **drawers** (verbatim
  chunks), **closets** (regex tag/entity index → drawer pointers), **KG**
  (temporal triples). **Zero-LLM ingest.**
- **Retrieval:** vector (Chroma/HNSW) **+ BM25** hybrid (0.6·vec + 0.4·bm25),
  **closet boost** (ranking signal, never a gate), temporal boost, **±1 neighbour
  expansion** + grep. Local embeddings (MiniLM / embeddinggemma). Python.
- **Self-reported:** LongMemEval **R@5 96.6%** (zero-API), → ~100% with Haiku
  rerank; LoCoMo R@10 88.9%; ConvoMem 92.9%; MemBench R@5 80.3%. *(retrieval
  recall — see caveat.)*
- **Took:** validated verbatim storage and neighbour expansion for the
  **document/file RAG path**, not for canonical Chat/Agent memory records.
  Hybrid BM25 was tested and was a wash on the historical raw-memory harness
  (RETRIEVAL-PLAN 1.1). The durable principle is **"index as ranking signal,
  never a gate."**
- **2026-07-30 transfer:** its explicit `direct | prefer | require` write-routing
  decision demonstrates that a required single-writer route must fail closed,
  never silently fall back to a second writer. Palace-scoped derived data
  reinforces FishMem's scope isolation. Pre-open index divergence checks,
  lexical degraded mode, and repair that succeeds only after a clean integrity
  check are useful Desktop reliability patterns. Preserved `added_by`
  attribution maps to FishMem provenance.
- **2026-07-31 transfer:** MemPalace's overlap hang fix is accepted as a failure
  mode, not as a new chunker. FishMem's existing chunker clamps overlap to half
  the window and also forces `start` to advance; a hostile-overlap regression
  test now freezes that property. Its cached HNSW capacity probe maps to the
  existing versioned index-identity/readiness seam, so no second capacity or
  index state machine is added.
- **Left:** the regex preference/quote/name **micro-boost zoo** — benchmark-overfit
  + brittle (its own notes admit the last 0.6% was tuned on specific misses).
  Also leave drawers/closets/wings/rooms as a product ontology: importing those
  nouns would duplicate FishMem's memory, source, chunk, and projection model.
- **Verdict:** strongest adjacent source for local document RAG and repair
  behavior. It is not the canonical Chat/Agent write model.

## PageIndex (github.com/VectifyAI/PageIndex)
- **What:** **vectorless, reasoning-based** RAG for **long structured documents**
  (financial/legal/technical). Builds a Table-of-Contents **tree**; an LLM
  **reasons over the tree** to locate sections. No embeddings, no chunking.
- **Self-reported:** **98.7%** on FinanceBench (via Mafin 2.5). *(document QA —
  different domain entirely.)*
- **Took:** the **"similarity ≠ relevance"** critique — motivated testing lexical
  (BM25) as a complement to vector (RETRIEVAL-PLAN 1.1).
- **Left:** **per-query LLM tree traversal** — wrong for conversational memory
  (expensive, document-shaped, no temporal/per-user state).
- **Verdict:** **different category** (document RAG, not agent memory) →
  complementary, not a competitor. An agent could use both.

## [hebb-mind](https://github.com/afx-team/hebb-mind)
- **What:** agent memory; despite the name, **NOT dynamically Hebbian** — edges
  are **tag co-occurrence counters** set at consolidation (`weight += 1`), never
  reinforced at recall.
- **Design:** **tag graph** (nodes = LLM tags; edges = co-occurrence; **1-hop**
  walk, single relation) + 3-path RRF (vector + keyword + graph) + LLM
  consolidation with **conflict resolution** + dynamic TTL forgetting + **local
  cross-encoder rerank** (bge-reranker, no API tokens). Python.
- **Self-reported:** LoCoMo R@10 **95.75%**, LongMemEval R@10 **99.4%** / QA
  **79%**, MemBench Hit@5 **94.6%**. *(mostly retrieval recall — see caveat.)*
- **Took (backlog):** **co-occurrence graph signal** — orthogonal to vector, the
  thing a graph *should* add — run under fishmem's **PPR** (RETRIEVAL-PLAN 2.7);
  **local cross-encoder rerank** as a no-token middle tier (2.8).
- **Already have / do better:** multi-hop **PPR** ≫ its 1-hop walk; richer typed
  edges + bi-temporal **sidecar**; conflict resolution (fishmem's update
  pipeline); temporal boost.
- **The one genuinely-new, un-taken idea:** **true dynamic Hebbian** —
  co-recalled memories strengthen their edge. fishmem's edges are static. Could
  help multi-hop over time, but risks rich-get-richer feedback and is
  **unmeasurable on LOCOMO** (no co-recall history). Noted, not planned.
- **2026-07-30 transfer:** its external importer separates deterministic
  discovery from the public write facade, derives a stable key from source
  identity plus cleaned-content hash, scans all pages before deduplication, and
  returns `discovered / imported / skipped_existing`. FishMem should use the
  same observable migration shape, but route it through its durable import
  operation and preserve source identity/version explicitly. Hebb's approach
  creates a new row when a source changes; FishMem must choose replacement or
  version semantics deliberately rather than inherit that behavior. Its live
  model-download progress reinforces the Desktop readiness UX already present.
- **Leave:** fixed neuroscience-named partitions and tag co-occurrence as
  canonical taxonomy. They can be evaluated as derived retrieval signals
  without changing the store.
- **Verdict:** useful migration, local-model UX, and experimental retrieval
  patterns; not a topology to merge wholesale.

## [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)
- **What:** two progressive-disclosure hierarchies. Long-term memory is L0 raw
  conversation → L1 atom → L2 scenario → L3 persona; long-running task context
  is raw tool output → JSONL step summary → Mermaid task map. Every upper layer
  has identifiers back to lower-level evidence.
- **Engineering shape:** `TdaiCore` is separated from host adapters; SQLite or
  Tencent vector storage sits behind a store interface; serial queues,
  checkpoints, context offload, and readable Markdown artifacts make recovery
  and inspection first-class.
- **Take:** provenance-preserving progressive disclosure and rebuildable views
  reinforce FishMem's source-to-derived evidence chain. The useful increment is
  not a mandatory four-level ontology; it is stable drill-down from profile or
  state to the exact source memory, plus explicit context-budget accounting.
- **Leave:** Mermaid as the canonical machine representation and unconditional
  L0→L3 generation. Both add format coupling and write cost without same-harness
  evidence for fishmem workloads.

## [MEMANTO](https://github.com/moorcheh-ai/memanto)
- **What:** an active memory agent with `remember`, `recall`, and `answer`, typed
  memory, temporal/version metadata, zero-extraction ingest, and an
  agent-scoped namespace accessed through time-bounded sessions.
- **Engineering shape:** CLI, MCP, framework adapters, cloud/on-prem switching,
  and session lifecycle are deeper than the visible retrieval implementation,
  which is delegated to the proprietary Moorcheh engine.
- **Take:** make scope and session lifecycle explicit, test isolation through
  the public interface, and evaluate the complete agent workflow rather than
  retrieval alone. `answer` is useful as a benchmark orchestration primitive,
  not necessarily as another fishmem core method.
- **Leave:** claims about information-theoretic exact retrieval cannot be
  independently transferred from this repository, and embedding Moorcheh would
  replace fishmem's engine rather than improve it.

---

## Summary

| project | category | headline (self-reported, NOT comparable) | net-new for fishmem |
|---|---|---|---|
| mem0 | extraction + multi-signal memory | platform 92.5 LOCOMO | fail-closed extraction; immutable scope; API comparator |
| MemPalace | verbatim memory + file RAG | LongMemEval R@5 96.6% | single-writer fencing; repair/degraded search; document neighbours |
| hebb-mind | tag-graph memory | LoCoMo R@10 95.75% | deterministic import results; co-occurrence/rerank experiments |
| TencentDB Agent Memory | hierarchical agent memory | no comparable public result | evidence drill-down; context offload; host adapter seam |
| MEMANTO | active/session memory | LongMemEval 89.8; LOCOMO 87.1 | scoped sessions; workflow-level evaluation |

PageIndex remains useful adjacent document-RAG prior art, but it is not one of
the five agent-memory repositories in this review.

**Product conclusion:** conversational memory and document RAG need different
loss boundaries. For Chat/Agent writes, FishMem follows the mem0-style contract:
refined records are canonical by default, while `infer=false` is an explicit
verbatim mode. Long text and files will have a non-lossy source store with
rebuildable chunks and projections. State, profile, graph, and retrieval indexes
remain derived and provenance-linked in both paths.

The plan is therefore not to merge feature sets. A borrowed capability must fit
one existing module, preserve the single writer and scope rules, and pass a
paired benchmark or failure-recovery acceptance test. The implementation order
is in [EXECUTION-PLAN.md](./EXECUTION-PLAN.md). Lexical fusion already came
back a wash on the historical raw-memory experiment.
