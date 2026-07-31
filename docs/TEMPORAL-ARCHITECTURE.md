# Making `memoryType` work for temporal (design)

> Historical experiment note. This document describes the June raw-memory
> retrieval experiment and its WASH result. It is not the current canonical
> ingest architecture; see [ARCHITECTURE.md](./ARCHITECTURE.md).

A design for the temporal subsystem, drawn from how mem0 / MemPalace / hebb-mind
handle time, and grounded in what we measured on fishmem. **Status: design +
falsifiable first test. Nothing here ships without a same-store paired ablation
(the project iron law).**

## The problem we're solving
fishmem's temporal questions are a relative weak spot (LongMemEval
temporal-reasoning ≈ 57–60% raw; LOCOMO temporal strong at 64–78% but via verbatim
text). The "8 `memoryType` + bi-temporal" machinery — fishmem's headline
differentiator — has **failed to help temporal** in two measured ways:

1. **`extract` mode** (structured dates *replace* the raw chunk): **hurts** —
   LOCOMO temporal 68.3% extract vs **77.8% raw**. Structuring loses the verbatim
   phrasing and mis-renders ("`[2023-06-09]` married 5 years" → answered "since
   June 9").
2. **sidecar state-slot injection** (structured state added to the answer
   context): **wash** — LongMemEval temporal **60.0% raw vs 57.5%** hybrid+inject
   (paired, n=40, net −1, p=1.0). Plus the slots **exclude events** and are
   point-query, so they don't feed free-form temporal QA.

**Root cause:** both put dates into the *answer text* (as content), where they
mislead or add nothing. Neither uses time the way it actually pays off.

## What actually works for temporal (cross-system lesson)
| system | temporal mechanism | result |
|---|---|---|
| **mem0** | atomic facts, no temporal ranking | weak (LOCOMO temporal 36.5%) — negative lesson |
| **MemPalace** | per-chunk `content_date` + **retrieval boost by date-proximity** to the question's reference date; KG `(subj,pred,obj,valid_from,valid_to)` for as-of | strong temporal |
| **hebb-mind** | parse the query's date → **boost memories near it**; dynamic TTL | strong temporal |

**The lesson: time helps as a RETRIEVAL-RANKING signal (boost chunks near the
query's time), additive to verbatim text — NOT as fact-replacement or
point-query state.** And fishmem **already has this lane** (`rrfWeights.temporal`
= 0.8, `temporalKernel`, `extractDateRange`) — but it is **dormant in raw**,
because raw chunks carry **no structured `eventDate`** (the date lives only in the
chunk text). The temporal lane has nothing to rank.

## Architecture
```
L1  raw base (unchanged): verbatim chunks — the answer LLM still reads the
    original dated text directly (the configuration that wins recall). Never replaced.

L2  cheap temporal tagging (NO full-LLM extraction):
      · eventDate per chunk = the session/conversation date (free, from metadata),
        optionally refined by a date-regex normalizer ("last June" -> 2022).
      · memoryType per chunk (cheap classifier / heuristic) — the ROUTER (below).

L3  temporal-aware retrieval, ROUTED by query:
      · date-referencing or "when/before/after/first/last" query
          -> activate the temporal lane: boost chunks whose eventDate is near the
             query's reference date (fishmem's temporalKernel, now fed by L2).
      · "order/sequence" query
          -> inject a COMPACT ORDERED EVENT TIMELINE: the retrieved event-type
             chunks sorted by eventDate (additive block, never replaces raw).
             [this is the deferred "append-style timeline slice" — used for
              ordering, not point-query]
      · "current value / now" query
          -> state sidecar getState (it already does this well).
      · else -> plain raw (no temporal machinery -> no risk to non-temporal).
```

### `memoryType` as the temporal ROUTER (this is how it "works")
- **event / decision / todo / goal** = point-in-time occurrences → `eventDate` is
  the occurrence time → feed the **event timeline + proximity boost**.
- **fact / preference / identity** = mutable state → feed the **state sidecar**
  (current value + `validFrom`/`validTo` for "when did it change").
- **observation** → raw recall.

→ `memoryType` decides whether a memory is an *event* (timeline/boost) or a *state*
(slot), which decides how its time is used. Today it's dormant; here it becomes
the **switch that routes temporal handling** — the concrete answer to "make
memoryType effective for temporal."

## Why this can win where the prior attempts failed
| failed approach | this design |
|---|---|
| dates into answer text (mislead) | dates into **retrieval ranking** (MemPalace/hebb-proven) |
| replace raw (lose verbatim) | **additive** to raw, never replace |
| inject on every query (hurts non-temporal) | **routed** — temporal queries only |
| point-query state (can't feed QA) | event **timeline injected** + proximity **boost** |
| sidecar excludes events | events are first-class (timeline) |

It also **activates fishmem's already-built, raw-dormant temporal lane** — a lever
**distinct from** (and untested vs) the sidecar-injection that washed.

## Falsifiable first test (cheapest, no LLM)
1. Give raw chunks `eventDate` = session date (free, metadata) on ingest.
2. Same-store paired ablation via `--search-variants`: `rrfWeights.temporal` **0
   vs 0.8** over the identical raw+eventDate store.
3. Measure on temporal questions (LOCOMO category-2 and/or LongMemEval
   temporal-reasoning), paired McNemar.

**Pass** → date-proximity boost is real → add the event-timeline injection +
memoryType routing. **Fail/wash** → the proximity-boost lever also doesn't beat
raw's verbatim dates (raw is simply enough) → close the temporal investigation.

## First-test result (2026-06-20): WASH
Ran it — eventDate on raw chunks + `rrfWeights.temporal` 0 vs 0.8, same store,
LOCOMO temporal category, 156 paired questions:

| | temporal acc |
|---|---|
| raw (temporal 0) | 71.8% |
| raw + proximity boost (temporal 0.8) | 71.8% |

Paired McNemar: b=1, c=1, **net 0, p=0.48** — only **2 of 156** questions changed
at all. The boost is **inert**: LOCOMO temporal questions are mostly *relative*
("how long", "after X") with no absolute date, so `extractDateRange(query)` finds
nothing and the temporal lane almost never fires (the applicability limit above,
confirmed). The eventDate-on-raw adapter change was reverted.

**Verdict:** the date-proximity boost — the cheapest, mempalace/hebb-proven lever —
**also does not beat raw's verbatim dates** on this benchmark. Combined with the
extract (hurts) and sidecar-injection (wash) results, this is the **5th
consecutive null** structure/temporal lever. raw + vector is at its ceiling here;
the temporal weakness is answer-side synthesis, not retrieval/structure. The
event-timeline + memoryType-routing extensions remain *unbuilt* — pursue only if a
**date-anchored** workload (queries with explicit dates) actually appears.

## Honest caveats
- **Applicability limit:** the proximity boost needs the *query* to carry a
  date/temporal reference. Many temporal-reasoning questions are *relative*
  ("after my trip") with no absolute date → `extractDateRange` finds nothing →
  no boost. So expected help is bounded to date-anchored questions.
- raw temporal is already decent (verbatim dates) → limited headroom.
- This is a hypothesis; only paired McNemar on the frozen harness decides.
