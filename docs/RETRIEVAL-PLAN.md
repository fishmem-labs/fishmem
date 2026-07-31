# Retrieval improvement plan (tier-1 / tier-2)

> Per-project evaluations (what each is, self-reported numbers + the
> comparability caveat, what we took/left): [PRIOR-ART.md](./PRIOR-ART.md).

Engineering borrowed from **MemPalace** (verbatim + BM25/vector hybrid, temporal
boost, neighbor expansion, dedup) and **PageIndex** (the *similarity ≠ relevance*
critique → lexical/structure must complement vector). Targets fishmem-raw's
measured profile on LOCOMO 10-conv: single-hop is already a win (+11.2pt) but
multi-hop (50.7%) and open-domain (49.0%) lag, and the "similarity ≠ relevance"
failure mode still costs single-hop misses.

**Discipline (project iron law).** Every item below is a **hypothesis**. Validate
with a **same-store paired McNemar** (ingest once, swap retrieval via
`--search-variants` + `setSearchOverrides`); ~9% per-question verdict noise means
sub-5pt effects are trustworthy **only paired**. Nothing ships on a point estimate.

**Avoid re-work — what already exists.** BM25 (`vector/memory.ts` `bm25Rank`,
Okapi k1=1.5/b=0.75, CJK-aware tokenizer), the FTS lane (`search.ts` `hybridSearch`),
and RRF fusion (`rrf.ts`) are all **already implemented**. FTS is OFF
(`rrfWeights.fts = 0`) because it was net-negative **on the extraction store**
(−7.5pt). It has **never** been tested on the **raw base** — that is tier-1.1.

---

## Tier 1 — high value, low cost, ~zero added read tokens

### 1.1 Lexical (BM25) on the raw base — boost-only  [RESULT: WASH — not shipping]
- **What:** activate the existing BM25/FTS signal over raw chunks, fused with
  vector. If plain RRF-fts dilutes (acts like a gate), add a **post-fusion
  boost-only** variant: raise the rank of vector∩lexical hits, *never* filter a
  vector hit out.
- **Why:** fixes *similarity ≠ relevance* — exact tokens (proper nouns, numbers,
  IDs, rare terms) the embedding under-weights. PageIndex's whole thesis +
  MemPalace's hybrid both target this.
- **Cost:** ≈0 — BM25 is local CPU over the candidate set; no LLM/embedding calls;
  **no extra read tokens**. Code already exists; the only possible new code is the
  boost-only post-fusion pass.
- **Result (2-conv paired, 2026-06-19, `locomo-tier1-fts-ablation.json`):**
  **WASH.** raw 71.7% / raw+fts0.5 71.7% / raw+fts1.0 72.1%; overall paired net
  **+0 / +1** (p=0.85 / 1.0); single-hop net −1 / +2 (ns); all categories ns. The
  discordance is **balanced** (b≈c, e.g. 14/14) → lexical *reshuffles* which
  questions are right without a net gain — a genuine null, not low power.
  Notably it does **not** hurt on raw (vs −7.5pt on extraction), but "doesn't
  hurt" ≠ "helps". **Decision: do not ship plain RRF-fts on raw.** A post-fusion
  *boost-only* variant (never gate) could in principle tilt the b/c balance, but
  the 14/14 split caps its upside at a few questions — low expected value.

### 1.2 Temporal recency / date-match boost
- **What:** when the query carries a date reference, boost chunks whose `eventDate`
  is near it. The engine already has a temporal lane (`rrfWeights.temporal`,
  `temporalKernel`); raw chunks currently lack a structured `eventDate`, so this
  pairs with surfacing the conversation date into the chunk's metadata.
- **Why:** breaks ties among date-close sessions; targets the temporal category.
- **Cost:** low, arithmetic, no tokens. **Risk:** only apply when a temporal
  signal is present, else it mis-boosts non-temporal queries.

### 1.3 Chunking discipline + line/source locators
- **What:** break chunks on turn/paragraph boundaries, small overlap, min size;
  carry `source` + line offsets in metadata.
- **Why:** retrieval units = semantic units; also enables 2.4. Mostly an enabler.
- **Cost:** low, but re-chunk = re-ingest + re-measure (perturbs comparisons), so
  bundle it deliberately, not casually.

---

## Tier 2 — medium value; some carry a real token/latency cost (opt-in)

### 2.4 Neighbor expansion (±1 sibling + grep)
- **What:** for a high-confidence hit, fetch ±1 sibling chunks from the same
  source, grep for the best keyword span, return fuller context.
- **Why:** multi-hop / "right source, wrong chunk". **Cost:** bigger answer
  context → more read tokens (conflicts with token parity) → **opt-in +
  length-capped**. **Risk:** distractor dilution — the exact thing that hurt
  extraction; ablate carefully.

### 2.5 Post-ingestion dedup (cosine-greedy)
- **What:** drop near-duplicate raw chunks (cosine < ~0.15, keep the longest);
  async/background.
- **Why:** smaller index, fewer duplicate distractors in top-k. Mostly a cost win
  (≈0–1pt accuracy).
- **Risk:** aggressive dedup deletes distinct-but-similar memories (**data loss**)
  → conservative threshold + keep provenance/history. Only if duplication is a
  *measured* problem (don't add a subsystem on spec).

### 2.6 Optional LLM rerank tier (opt-in)
- **What:** LLM reranks the top candidates after cheap retrieval (the engine
  already has `search.rerank`).
- **Why:** the biggest single accuracy lever (MemPalace 96.6 → ~100 R@5).
  **Cost:** an LLM call per query → real tokens + latency → **must stay
  default-off**. This is the **Cloud premium tier**, not an OSS default.

### 2.7 Concept/entity co-occurrence graph on the raw base + PPR
- **Current state (honest).** fishmem's graph is rich *on paper* — typed edges
  (`updates` 1.5 / `caused_by` 1.3 / `contradicts` 0.5), multi-hop **PPR**, an
  entity graph — but those edges come from **extraction**, so in the winning
  **raw** config they are **dormant**. What's left in raw is `autoLink`
  (`memory.ts`): each chunk linked to its ~3 nearest embedding neighbours
  (`related_to`, weight = cosine). That edge encodes the **same metric as vector
  search** → the raw-mode graph is **largely redundant with vector** (PPR adds a
  little 2-hop reach, no new signal). RRF graph weight is only 0.5.
- **The borrow (hebb-mind's tag graph).** hebb-mind links nodes by
  **co-occurrence** (concepts appearing together) — a signal **orthogonal to
  vector**, which is what a graph *should* add — but over a crude 1-hop walk.
  fishmem is the mirror image: a strong traversal (PPR) over a weak (redundant)
  signal. **Synthesis = fishmem's PPR over a co-occurrence graph:** in raw mode,
  do **cheap local entity/noun-phrase extraction** (not full LLM extraction) →
  link chunks that share an entity → co-occurrence weight → run the existing PPR
  over *that*. Reuses the entity-graph tables (`fishmem_memory_entities`); the new
  part is producing entities in raw mode without the extraction LLM.
- **Why:** targets multi-hop (~51%) — cross-chunk relational structure that
  vector + the similarity-kNN graph cannot reach.
- **Cost/risk:** medium. Needs a cheap raw-mode entity/tag extractor; PPR exists.
  Risk: noisy entities → noisy edges; rich-get-richer on common entities → needs
  entity-IDF down-weighting (à la hebb-mind's tag-frequency scaling).
- **Validation order:**
  1. ✅ **DONE (2-conv paired, `locomo-tier2-graph-ablation.json`):** raw (graph
     0.5) vs raw-nograph (graph 0). The similarity-graph is **redundant** —
     graph-ON **never** fixed a question OFF got wrong (**b=0 in every category**),
     net **−2** overall (p=0.48, ns); raw-nograph 71.7% ≥ raw 70.8%. → the current
     raw graph adds nothing; **graph-off-on-raw is a justified subtraction**. The
     bar for step 2 is now the **graph-off 71.7%**.
  2. **Only if** there's headroom / to add orthogonal signal: build the
     co-occurrence-entity graph in raw + PPR, ablate vs the step-1 baseline
     (paired McNemar, watch multi-hop).
- **Status:** step 1 done (similarity-kNN graph redundant → subtract). **Step 2
  done (2-conv paired, `locomo-tier2-cooccur-ablation.json`): WASH.** A no-LLM
  proper-noun entity graph (`heuristicEntities`) over raw, entity-PPR fused at
  graph 0.5 vs the graph-off baseline: overall **net +0** (b=2/c=2, p=0.62),
  identical accuracy (72.1%), multi-hop net +0 (reshuffled 4 q), at **2.6×
  ingest** (entity-name embeddings). Proper-noun-only extraction is thin (misses
  lowercase concepts); a richer signal needs LLM tags = no longer "cheap raw".
  **Kept as an opt-in capability** (`heuristicEntities` + `search.entityGraph`,
  both default OFF): wash on LOCOMO, but co-occurrence may help entity-dense
  workloads (hebb-mind/mempalace). Not a default.

### 2.8 Local cross-encoder reranker (no-token quality lever)
- **The gap.** fishmem's only reranker is **LLM rerank** (`search.rerank`) — an
  API call per query, expensive, off by default (rightly — conflicts with token
  parity). hebb-mind instead uses a **local cross-encoder** (`bge-reranker-base`,
  default on, disableable) that reranks the top-N with **no API tokens**.
- **The borrow.** A local cross-encoder is the **missing middle** between "no
  rerank" (cheap, current OSS default) and "LLM rerank" (expensive, Cloud): it can
  lift ranking with **zero token cost** — a fit for the cost-conscious OSS default
  *if it earns it*. Pairs with **per-channel `min_score` floors** (hebb-mind floors
  reranked hits lower, `min_score × 0.625`, since a cross-encoder is conservative
  on short text and a uniform threshold hard-filters correct hits) — adopt that
  *only if* a reranker ships.
- **Cost/risk:** a cross-encoder is a **heavier dependency** (onnxruntime /
  transformers.js + a few-hundred-MB model) — conflicts with fishmem's
  "edge-ready, zero mandatory native deps" promise → must be **opt-in,
  lazy-loaded, never required**. Latency: local inference per query (no API, but
  not free). **Unproven headroom on raw:** vector ranking is already strong
  (single-hop 81%); rerank may have little to reorder.
- **Recommendation:** lower priority than 2.7. Tier it — **local cross-encoder
  (opt-in OSS)** as the cheap lever + **LLM rerank (Cloud premium)** as the
  expensive one. Gate on (a) accepting the dep as opt-in and (b) an ablation
  showing rerank headroom on the raw base.

---

## Principles (do / avoid)
- **DO:** boost-only signals (never gate vector hits); one-time write-side cost,
  cheap reads; validate paired; keep read tokens flat unless explicitly opt-in.
- **AVOID:** PageIndex-style per-query LLM tree traversal (wrong for chat memory,
  expensive); MemPalace's regex preference/quote/name micro-boost zoo
  (benchmark-overfit, brittle — the kind of thing we just removed); a parallel
  closet/KG subsystem (entities + sidecar already cover that ground).

## Sequence
**Done — three cheap-local retrieval levers tested on the raw base, all
null/negative:** 1.1 lexical = WASH; 2.7 step 1 similarity-graph = redundant
(b=0); 2.7 step 2 co-occurrence/entity graph = WASH (net 0, +2.6× ingest, kept
opt-in). **Conclusion: raw + vector is at its LOCOMO ceiling for cheap-local
signals; multi-hop (~51%) is not fixable this way.** Remaining levers all carry a
real cost: 1.2 temporal (low headroom), 2.4 neighbour expansion (read tokens),
2.8 local reranker (dependency) → defer to opt-in / Cloud. **Never bundle** items
in one run — it muddies attribution under the 9% noise floor.
