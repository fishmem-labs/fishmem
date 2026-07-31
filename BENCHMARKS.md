# fishmem — Benchmark Report

Honest, same-harness measurements of fishmem against mem0. Every number here
is reproducible with the harness in [`benchmarks/`](./benchmarks); per-question
outputs are saved as JSON.

> **The one-line verdict (10-conv confirmation, 2026-06-19):** storing **verbatim
> raw chunks** beats mem0's OSS SDK by **+12.8pt overall** on LOCOMO (70.1% vs
> 57.3%, 1,540 paired questions, exact McNemar **p ≈ 0**, net +196) — verbatim
> **wins single-hop** (+11.2pt, p=2.5e-11, reversing the extraction deficit) and
> **temporal** (+28.7pt, p=3.4e-14). The 2-conv lead over fishmem's own extraction
> pipeline (+13pt, p=0.0003) is what demoted extraction. The prior "+7.8pt /
> single-hop tied / replicated 3×" claim is **retracted** (non-isolated mem0
> store, since fixed). This drives the architecture inversion in
> [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) (raw base + thin derived
> structure). Caveat: 2/1,571 chunks dropped to transient proxy errors (conv-48,
> against fishmem) — harness flagged "not clean"; a clean re-run can only widen a
> p≈0 gap.

## Fairness protocol

- **Same harness** for every system: identical input chunking, the same
  answerer model (`gpt-4o-mini`) + embedder (`text-embedding-3-small`), the
  same top-k, one shared answer prompt, one blind LLM judge.
- **Isolated stores both sides:** a fresh in-memory store per run. (mem0ai's
  `provider:"memory"` is on-disk SQLite that *accumulated across runs* until we
  set `dbPath:":memory:"` — pre-2026-06-18 mem0 numbers were contaminated and are
  retracted.) The harness also retries `add()` for both systems and reports
  `failedAdds`, so a flaky endpoint can't silently drop one side's memories.
- We only render what each system *produces*. fishmem renders its extracted
  `eventDate`; mem0's ingestion timestamps are **not** injected (they are not
  event time). The hosted platform's event time is passed via its own
  `timestamp` API, as intended (see the fairness bug below).
- **Paired significance**, not point estimates: exact McNemar + paired
  bootstrap over the *same* questions for both systems (`benchmarks/compare.ts`).
- Comparator: mem0's official TypeScript OSS SDK `mem0ai` v3.0.6 (post-rewrite
  v3) and, separately and heavily caveated, the mem0 hosted platform.
- LOCOMO conversations are split dev (conv-26) / held-out (conv-30, conv-41);
  the shipping config is frozen before the held-out measurement.

## LOCOMO — the primary, complete, fair comparison

**Headline — 10-conversation run (1,540 paired questions), fishmem-raw vs mem0
OSS, same conditions, per-category exact McNemar:**

| LLM-judge accuracy | fishmem-raw | mem0 OSS | Δ | paired p |
|---|---|---|---|---|
| **Overall** | **70.1%** | 57.3% | **+12.8pt** | **≈0** (χ²=87, net +196) ✓ |
| **Single-hop** (n=841) | **81.2%** | 70.0% | **+11.2pt** | **2.5e-11** ✓ |
| **Temporal** (n=321) | **64.2%** | 35.5% | **+28.7pt** | **3.4e-14** ✓ |
| Multi-hop (n=282) | 50.7% | 46.1% | +4.6pt | 0.19 (ns) |
| Open-domain (n=96) | 49.0% | 52.1% | −3.1pt | 0.58 (ns) |
| Stored memories | **1,569** | 5,047 | — | fewer, richer |
| Ctx tok/query | 1,667 | 327 | — | the read-side cost |
| Ingest total | **12,480s** | 24,223s | — | ~2× cheaper (no extraction LLM) |

Verbatim's advantage **holds at scale and is now powered**: +12.8pt overall
(p ≈ 0, net +196 of 1,540). It **wins single-hop** (+11.2pt) — reversing the
extraction-mode deficit — and **temporal** (+28.7pt); multi-hop (+4.6) and
open-domain (−3.1) are not significant. The lone cost is recall-query tokens
(1,667 vs 327) — untuned (joined 4-turn chunks, top-k 10), tunable via finer
chunks + dedup + lower top-k + intent-gated context (see
[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)). *Caveat: fishmem dropped 2/1,571
chunks to transient proxy errors (conv-48), asymmetric against itself; the harness
flagged "not clean." A clean re-run can only widen a p≈0 / +196-question gap.*

**Why verbatim, not extraction — the 2-conv three-way that demoted extraction**
(233 paired questions, same conditions, exact McNemar):

| system | overall | single-hop | temporal | ctx tok/q | ingest |
|---|---|---|---|---|---|
| **fishmem-raw** (verbatim/RAG) | **71.7%** | **75.4%** | **77.8%** | 1744 | 449s |
| fishmem (extraction, prior default) | 58.4% | 54.4% | 68.3% | 717 | 4242s |
| mem0 OSS | 53.6% | 64.0% | 36.5% | 328 | 2596s |

Verbatim beat extraction **+13.3pt overall (p=0.0003)** and **fixed single-hop**
(extraction *lost* it to mem0, 54.4% vs 64.0%) — which is why extraction is
demoted from primary store to a thin derived overlay. Ingest was **9.5× cheaper**
(no extraction LLM). The 10-conv headline above confirms the verbatim → mem0 lead
at powered scale.

**Why single-hop was lost — trace, not guess.** The answer was usually *in the
store* but out-ranked by duplicate fragments, not retrieved, or mis-rendered (a
date-anchor bug on stative facts, now fixed) — **not** extraction
over-abstraction. Trimming injected context to mem0 token parity did **not** fix
it (−3.9pt, p=0.078, within ingest noise). So the gap is retrieval +
fragmentation, which a raw base + greedy-NN dedup addresses directly. This is why
the architecture inverts extraction from *primary store* to *thin derived
overlay*.

> **Retraction.** The earlier table ("+7.8pt overall, single-hop tied,
> replicated 3×, 385 q") used a mem0 baseline whose `provider:"memory"` store was
> on-disk and accumulated across runs — not isolated. With `dbPath:":memory:"`
> (fresh per run) the numbers above replace it. The fishmem-internal FTS-off /
> no-router ablation still stands (it's fishmem-vs-fishmem); FTS stays opt-in
> (`rrfWeights.fts`), and the open idea is to re-test lexical as a *boost-only*
> signal (never a fusion gate). Only **paired** McNemar on identical questions is
> trustworthy for sub-5pt effects (~9% per-question flip noise).

## Temporal edge decomposition — how much is a moat?

`mem0-dated` is a steelman: it hands mem0 OSS the *same* date rendering fishmem
uses (session date → metadata → prefixed at retrieval), isolating fishmem's
structured event-date **extraction** from the **rendering** of those dates.
The +34pt held-out temporal gap splits **exactly 50/50**:

| system | temporal | attribution |
|---|---|---|
| mem0 OSS (no dates) | 28.3% | baseline |
| mem0-dated (dates rendered) | 45.3% | +17pt = **rendering** (copyable wedge) |
| fishmem | 62.3% | +17pt more = **extraction / architecture** (moat) |

- Half the win is **prompt-copyable**: any mem0 adapter that renders dates gets it.
- The other half is fishmem's **structured extraction** — normalizing relative
  refs ("last year" → 2022) and binding the correct event date per fact, where
  crude session-date stamping is wrong for past-referencing events. This
  survives even when mem0 is *handed* the dates. (Conservative-honest: we fed
  mem0 the date directly, bypassing its extraction, so the rendering portion is
  an upper bound and the architecture portion a floor.)
- **Caveat:** mem0-dated's *overall* (57.5%) edges fishmem's (51.9%) — it gains
  temporal without fishmem's single-hop penalty. A date-rendering mem0 would be
  a stronger *overall* competitor. fishmem's durable moat is the temporal-heavy
  regime, not overall LOCOMO.

## Hosted platform — measured, but under-represented (cite, don't equate)

We ran mem0's hosted platform through the identical harness (passing event
timestamps via its API, as intended): **34.3%** held-out overall.

This is **not** a fishmem win. mem0's *own* OSS SDK beats mem0's *own* platform
by **+21pt** here (p < 0.0001) — which tells you the neutral, small-model
harness **under-represents the platform**, which is tuned for its own full
stack (larger models, managed reranking, proprietary retrieval, its own answer
pipeline). We treat 34.3% as a **harness-fit artifact**, and **cite** mem0's
self-published platform numbers (LoCoMo 92.5 / LongMemEval 94.4 / BEAM 64.1,
evaluation setup undisclosed) **without equating** them with this harness.
Cross-harness numbers are not comparable in either direction (cautionary tale:
Zep self-reported 84 on LOCOMO; mem0's own audit measured 58.4).

> **Fairness bug found & fixed en route.** The platform bakes its *ingestion*
> time into the memory text and we render that text verbatim — so on 2023
> LOCOMO conversations ingested in 2026, every temporal answer became the
> wall-clock date (temporal collapsed to 3.8%; "When did Jon lose his job?" →
> "June 2026" vs gold "19 January 2023"). Passing the conversation date via the
> platform's `timestamp` API — how it is *designed* to receive event time —
> fixed it: temporal 3.8% → 32.1%. We caught this before publishing.

## LongMemEval — fishmem-only (no mem0 same-harness number available)

Under the official LongMemEval judge, **oracle variant**, fishmem = **68.0%**
(500 instances):

| question type | fishmem |
|---|---|
| single-session-user | 85.7% |
| knowledge-update | 73.1% |
| single-session-assistant | 69.6% |
| temporal-reasoning | 64.7% |
| multi-session | 61.7% |
| single-session-preference | 53.3% |

(The structured-prompt rebuild lifted preference 13.3% → 53.3% and
multi-session 54.9% → 61.7% over the prior stack.)

The full-haystack **LongMemEval_S** (gpt-4o answerer, the "headline" realistic
setting) was started and **deferred at 120/500** — it is a ~30h run with no
mem0 comparison obtainable (see Limitations), so its value did not justify the
cost. mem0's self-reported 94.4 is cited, not equated.

## BEAM — fishmem-only, and an honest weakness

BEAM 100k tier, official rubric-nugget ("Coverage") judge, fishmem = **32.4%**:

| ability | score | ability | score |
|---|---|---|---|
| abstention | **0.70** | multi-session reasoning | 0.31 |
| information extraction | 0.50 | temporal reasoning | 0.24 |
| preference following | 0.49 | event ordering | 0.17 |
| knowledge update | 0.38 | contradiction resolution | 0.08 |
| instruction following | 0.34 | summarization | 0.04 |

fishmem is a **factual-recall** layer: strong at knowing when to abstain and at
extraction, weak at the synthesis abilities BEAM emphasizes (summarization,
contradiction resolution, event ordering). We report this plainly. mem0's
self-reported BEAM 64.1 (full hosted stack) is cited, not equated.

## Known limitations & what we could not measure

- **Single-hop: extraction loses, verbatim fixes it.** The extraction pipeline
  loses single-hop to mem0 (clean re-run: 54.4% vs 64.0%, p=0.035). A store/
  retrieval trace showed the answer is usually *in the store* but out-ranked by
  duplicate fragments, not retrieved, or mis-rendered — **not** context dilution
  (trimming context to mem0 token parity did not help: −3.9pt, p=0.078). The
  verbatim/RAG base **fixes it** (75.4%, beats mem0) — so the resolution is the
  architecture inversion ([docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)), not a
  benchmark-specific hack.
- **No mem0 same-harness number for LongMemEval or BEAM.** mem0 OSS's HTTP
  client does not retry dropped connections; on our API proxy it wedges partway
  through the long runs (LongMemEval-oracle crawled to a standstill — 0
  instances in 53 min even with a retry+timeout wrapper; BEAM hung twice during
  ingest). LOCOMO is short enough to complete. To obtain these, run mem0 OSS
  against a more stable endpoint, or evaluate the platform on its own intended
  stack.
- **LOCOMO scope:** the headline is a 10-conversation run / 1,540 paired
  questions (fishmem-raw vs mem0). One caveat: fishmem dropped 2/1,571 chunks to
  transient proxy connection errors (conv-48, after 5 retries), asymmetric
  against itself, so the harness flagged the run "not clean" — a clean re-run can
  only widen a p≈0 gap and lands with the next retrieval iteration. (The retracted
  385-question / 3-conv table used the non-isolated mem0 baseline.) The paired
  test controls for ingest variance, but absolute single-ingest numbers carry
  ~several points of noise.

## Reproduce

```bash
# LOCOMO, both OSS stacks, frozen config
pnpm exec tsx benchmarks/locomo/run.ts --systems fishmem,mem0 --conversations 3

# paired significance for any two result files
pnpm exec tsx benchmarks/compare.ts <runA.json> <runB.json> <systemA> <systemB>

# LongMemEval (oracle) / BEAM (100k) — fishmem
pnpm exec tsx benchmarks/longmemeval/run.ts --variant oracle --system fishmem
pnpm exec tsx benchmarks/beam/run.ts --variant 100k --system fishmem
```

All runs accept `--resume` to continue from an incremental checkpoint (see
`benchmarks/README.md`), so an interrupted long run is never lost.
