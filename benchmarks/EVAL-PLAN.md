# fishmem Evaluation Plan

Product, API, Dashboard, core-data, and algorithm execution order is maintained
in [docs/EXECUTION-PLAN.md](../docs/EXECUTION-PLAN.md). This document owns only
the evaluation protocol and evidence requirements.

This document defines the benchmark and eval plan for proving fishmem has real
agent-memory value and can beat mem0 across more than one dimension.

The goal is not "win one benchmark." The goal is a defensible evidence
portfolio: public datasets, realistic agent scenarios, cost and latency, failure
behavior, and paired statistical comparisons under one disclosed protocol.

## Claims We Need To Prove

fishmem should only claim superiority over mem0 when the evidence supports at
least one of these concrete claims:

1. Better answer quality on long-term memory tasks.
2. Better handling of changed facts, temporal reasoning, and stale memories.
3. Better multi-session and multi-hop recall at the same `topK` and answer
   prompt.
4. Better abstention and lower hallucination when the memory store has no
   evidence.
5. Lower write-side cost or latency for comparable answer quality.
6. Better context efficiency: equal or better accuracy with fewer retrieved
   context tokens.
7. Better operational safety: recoverable degradation is observable, not silent.

If a run only proves one of these, report it as one claim. Do not turn a narrow
win into a general "fishmem beats mem0" statement.

## Current State

Existing benchmark coverage:

- `benchmarks/locomo`: paired fishmem vs mem0 runner with shared answer and judge
  LLMs, checkpointing, caching, and optional SPRT early stopping.
- `benchmarks/longmemeval`: official LongMemEval judge protocol with paired
  `--systems fishmem,mem0` execution and per-system resumable checkpoints.
- `benchmarks/beam`: official BEAM protocol with paired
  `--systems fishmem,mem0` execution and per-system resumable checkpoints.
- `benchmarks/recall`: MemBench and ConvoMem retrieval runners. They are
  currently fishmem-only and require an explicit dataset path.
- `benchmarks/eval`: shared schema, native result normalization, strict paired
  comparison, publishability gates, cross-dataset release audit, and Markdown
  scorecard generation.
- `benchmarks/tests`: filesystem/script/CI structure contracts, native result
  shape contracts for all three end-to-end runners, adapter contracts, and
  checkpoint corruption/torn-write recovery tests.

Main gap: no first-party realistic scenario suite for fishmem's target use
cases.
- MemBench and ConvoMem are not yet paired, normalized, checkpointed, or
  publishable through the shared scorecard.
- PersonaMem and MemoryArena are not yet implemented.
- Provider-level LLM/embedding calls, response token usage, and reference USD
  are instrumented through a scoped OpenAI transport meter. Unit usage is saved
  in checkpoints so resume/cache cannot undercount. The publication gate rejects
  unscoped, unmetered, unpriced, or differently-priced paired runs.
- Native runners now record exact `o200k_base` context tokens, exact system
  versions, and structured warning/retry/timeout diagnostics consistently.
- No frozen public baseline report for README or release notes.
- The state/profile candidate is implemented but remains opt-in until
  `bench:gate` accepts the required paired holdouts.

## Eval Architecture

Treat eval as a deep module with this external interface:

```ts
interface EvalRun {
  dataset: string;
  split: "smoke" | "dev" | "holdout" | "full";
  system: "fishmem" | "mem0" | "rag" | "long-context";
  config: Record<string, unknown>;
  items: EvalItemResult[];
  summary: EvalSummary;
}

interface EvalItemResult {
  id: string;
  category: string;
  question: string;
  expected?: string;
  answer: string;
  correct: boolean | number;
  judge?: Record<string, unknown>;
  searchMs: number;
  answerMs: number;
  ingestMs?: number;
  contextChars: number;
  contextTokens?: number;
  memoriesUsed: number;
  warnings?: Array<{ code: string; count: number }>;
}

interface EvalSummary {
  quality: Record<string, number>;
  cost: Record<string, number>;
  latency: Record<string, number>;
  context: Record<string, number>;
  reliability: Record<string, number>;
}
```

Individual benchmark scripts can keep their native shapes, but every serious
run must be convertible into this schema before comparison or publication.

## Dataset Portfolio

### 1. LOCOMO

Purpose: long-term conversational memory, temporal questions, multi-hop recall,
single-hop recall.

Use:

- Dev: conversation 1 only.
- Holdout: conversations 2-10.
- Headline: all non-adversarial categories, plus an explicit adversarial run.

Claims it can support:

- temporal recall
- multi-hop recall
- factual answer quality
- context efficiency
- ingest cost and memory count

Must report:

- overall judge accuracy
- category 1/2/3/4/5 accuracy
- F1/BLEU-1 as secondary metrics
- search p50/p95
- ingest total and chunks dropped
- mean context tokens/chars
- paired McNemar/bootstrap vs mem0

### 2. LongMemEval

Purpose: multi-session QA, knowledge updates, temporal reasoning, preferences,
and abstention under an official judge.

Use:

- Cheap validation: `oracle`.
- Real retrieval stress: `s` full haystack.
- Required type slices:
  - `knowledge-update`
  - `temporal-reasoning`
  - `multi-session`
  - `_abs` abstention questions

Claims it can support:

- changed fact handling
- abstention
- preference memory
- multi-session recall
- large haystack robustness

Must report:

- official accuracy
- accuracy by question type
- abstention vs non-abstention
- stale-answer error rate where detectable
- search p50/p95
- ingest total, sessions, chunks, memories

### 3. BEAM

Purpose: broad memory ability coverage at 100K to 10M token scales.

Use:

- Smoke: fabricated protocol check.
- Public holdout budget run: `100k`.
- Scale claims: `1m` and `10m` only when cost is approved.

Required category slices:

- `contradiction_resolution`
- `knowledge_update`
- `event_ordering`
- `multi_session_reasoning`
- `preference_following`
- `abstention`
- `temporal_reasoning`

Claims it can support:

- broad memory capability
- scale behavior
- event ordering
- update and contradiction handling
- rubric-level coverage

Must report:

- official overall macro
- official per-category scores
- event-ordering tau and final score
- judge errors
- search p50/p95
- ingest total and memory count

### 4. FishBench Realistic Scenarios

Public benchmarks are useful but not enough. fishmem needs a first-party,
versioned scenario suite matching real agent workloads.

Create `benchmarks/fishbench/` with JSON fixtures shaped like:

```json
{
  "id": "coding-agent-001",
  "domain": "coding-agent",
  "sessions": [
    {
      "date": "2026-01-10",
      "messages": [
        { "role": "user", "content": "We use pnpm, not npm." }
      ]
    }
  ],
  "questions": [
    {
      "id": "coding-agent-001-q1",
      "category": "preference-following",
      "question": "Which package manager should the agent use?",
      "gold": "pnpm",
      "mustMention": ["pnpm"],
      "mustNotMention": ["npm"]
    }
  ]
}
```

Required domains:

- coding agent: repo conventions, past decisions, dependency policies
- support agent: account facts, ticket history, sensitive no-leak checks
- personal assistant: preferences, schedule, evolving facts
- sales/CRM: people, companies, follow-ups, stale contact info
- project manager: decisions, milestones, changed deadlines
- research assistant: source-grounded notes and abstention
- companion/chat: long-running preferences and relationship facts

Required adversarial cases:

- changed facts where the old value is tempting
- same name, different person
- cross-tenant leakage
- "do not remember" and deletion follow-up
- prompt injection inside remembered content
- assistant statement mistaken as user fact
- relative dates requiring a concrete date
- empty evidence requiring abstention

Claims it can support:

- real product value
- safety and isolation
- instruction/preference following
- operational fit for agent frameworks

## Baselines

Every serious run should include:

1. `fishmem`
2. `mem0` under the same harness
3. `embedding-rag` simple vector baseline, where feasible
4. `long-context` upper/cost baseline, where feasible

Reason: beating mem0 is useful, but a buyer/user also needs to know whether a
simple baseline or long context is enough.

## Fairness Protocol

Fixed for all systems:

- same raw sessions
- same chunking
- same timestamps injected into chunks
- same user/session scoping
- same answer model
- same judge model
- same answer prompt
- same judge prompt
- same topK or same context-token budget
- same retry policy
- same failure accounting

Allowed to differ:

- what each memory system stores
- how each system retrieves
- how each system renders its own stored metadata, if fully disclosed

Not allowed:

- hand-tuned prompts per system
- undisclosed profile/context injection
- dropping failed ingest chunks without a failed-add count
- comparing fishmem holdout runs against mem0 published claims from another
  harness
- tuning on holdout conversations and then reporting them as holdout

## Scorecard

Publish a scorecard, not one scalar:

| Dimension | Primary metrics |
|---|---|
| Answer quality | accuracy, rubric score, F1 where applicable |
| Temporal/update | temporal accuracy, knowledge-update accuracy, stale-answer rate |
| Abstention | abstention accuracy, false answer rate |
| Multi-hop | multi-hop/multi-session accuracy |
| Context efficiency | mean/p95 context tokens, accuracy per 1K context tokens |
| Cost | ingest LLM calls, embedding calls, estimated USD, memories created |
| Latency | ingest p50/p95, search p50/p95, answer p50/p95 |
| Reliability | failed adds, judge errors, warning counts |

Recommended headline format:

```text
fishmem vs mem0, same harness, same models:
- LOCOMO holdout: +X.X pt overall, +Y.Y pt temporal, p=...
- LongMemEval oracle: +X.X pt knowledge-update, +Y.Y pt abstention
- BEAM 100K: +X.X macro, +Y.Y contradiction_resolution
- Cost: Z% fewer write-side LLM calls / W% lower ingest time
- Context: Z% fewer context tokens at equal-or-better accuracy
```

## Statistical Rules

For binary correctness:

- paired McNemar exact test
- paired bootstrap 95 percent CI on accuracy difference
- report discordant pair counts

For BEAM rubric scores:

- paired bootstrap CI on score difference
- per-category and macro comparisons

For cost/latency:

- p50/p95 and mean
- no significance claims unless repeated runs exist

Release-readiness thresholds:

- no nonzero `failedAdds`
- no nonzero `judgeErrors` in headline rows
- holdout split disclosed
- resumed timing separates checkpoint-stable successful operation time from
  current-invocation wall time; cross-resume wall clock is never inferred
- mem0 baseline generated by the same harness
- exact system version and fixed context tokenizer disclosed
- provider LLM calls, embedding calls, and estimated USD recorded
- warning counts, retries, timeouts, and total degradation count recorded
- result JSON committed or archived with exact config

## Implementation Roadmap

### Phase 1: Unified Reports (complete)

Implemented under `benchmarks/eval/`:

- `schema.ts`: normalized `EvalRun` and `EvalSummary` types.
- `normalize.ts`: converters for LOCOMO, LongMemEval, and BEAM result JSON.
- `compare.ts`: paired comparison and strict evidence publication gates.
- `report.ts`: markdown scorecard generator.

All native runners now emit exact system versions, exact `o200k_base` context
tokens, response-derived provider usage and frozen price snapshots, and
structured adapter diagnostics. The release gate rejects incomplete metering.
They also emit atomic live progress JSON/Markdown with paired common-unit
deltas and preserve completed units in resumable checkpoints until final output
is durable.

Usage:

```bash
pnpm bench:report -- \
  benchmarks/results/locomo-holdout.json \
  benchmarks/results/longmemeval-oracle-paired.json \
  benchmarks/results/beam-100k-paired.json
```

For incremental/canary inspection, add `--draft`. This preserves paired
fairness checks but labels the report non-publishable and displays provider or
evidence failures. It does not relax `bench:gate`.

Release audit (nonzero exit until the complete evidence portfolio is present):

```bash
pnpm bench:gate -- benchmarks/results/<paired-result-files...>
```

### Phase 2: Multi-System Runner Parity

LongMemEval and BEAM now match LOCOMO's runner standard:

- support `--systems fishmem,mem0`
- isolated resumable checkpoints per system
- same-run paired result output
- consistent `failedAdds`, context tokens, warning counts

Cross-run content-addressed caching remains to be added to LongMemEval and
BEAM; checkpoints currently prevent repeated work only when resuming the same
output path.

Then bring MemBench and ConvoMem into the same module rather than preserving
their current one-off shape:

- dataset loaders with explicit acquisition/version metadata
- fishmem and mem0 through the shared adapter seam
- per-item retrieval evidence and stable IDs
- checkpoint/cache support
- normalized retrieval metrics in the scorecard

### Phase 3: FishBench

Create first-party realistic scenarios:

- `benchmarks/fishbench/data/*.json`
- deterministic checks for exact-answer questions
- LLM judge only for open-ended recommendation/summarization cases
- mem0 and fishmem adapters share the same `MemoryAdapter` seam

Start with 100 questions:

- 20 coding-agent
- 15 support-agent
- 15 personal-assistant
- 15 project-manager
- 15 sales/CRM
- 10 research-assistant
- 10 adversarial/safety

### Phase 4: Baselines Beyond mem0

Add:

- `embedding-rag` adapter
- `long-context` adapter for small/medium runs

This prevents weak claims. If long context wins but costs 20x more, report that
tradeoff directly.

### Phase 5: Public Evidence Pack

For every release or README claim:

- save raw JSON under `benchmarks/results/`
- generate `benchmarks/reports/YYYY-MM-DD.md`
- include command lines, model versions, dataset split, cost estimate, and git
  commit
- update README only from that report

## Immediate Next Work

1. Run a cheap apples-to-apples suite:
   - LOCOMO conversations 2-3, categories 1-5
   - LongMemEval oracle, 50 instances
   - BEAM 100K, 2 conversations
2. Generate the strict scorecard and identify where fishmem already beats mem0 and where it
   does not.
3. Only then tune retrieval or context rendering, using held-out splits.
