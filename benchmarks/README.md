# Benchmarks

See [EVAL-PLAN.md](./EVAL-PLAN.md) for the full evidence plan: public
benchmarks, realistic FishBench scenarios, mem0 comparison protocol, cost and
latency metrics, and release-readiness rules.

## Current frozen portfolio

The [2026-08-24 full scorecard](./reports/evidence-2026-08-24.md) passed the
quality release gate with two statistically supported wins and one reported
loss against mem0 OSS `3.1.2`:

| Benchmark | Paired items | FishMem | mem0 | Paired delta (95% CI) |
| --- | ---: | ---: | ---: | ---: |
| LongMemEval `oracle` | 500 | 88.2% | 83.8% | +4.4 pt (+1.0 to +7.8) |
| BEAM `100k` | 400 | 46.7% | 41.0% | +5.7 pt (+1.8 to +9.5) |
| LOCOMO, categories 1–5 | 1,986 | 67.5% | 71.1% | -3.7 pt (-5.8 to -1.5) |

This is LongMemEval `oracle`, not LongMemEval-S. Two baseline process ledgers
contain recovered attempts, so the quality result is publishable but aggregate
cost and wall-clock comparisons are not. FishMem's larger retrieved context on
LongMemEval and BEAM is also disclosed in the scorecard.

Strict paired scorecards across LOCOMO, LongMemEval, and BEAM are generated
from native result JSON files:

```bash
pnpm bench:report -- \
  benchmarks/results/locomo-holdout.json \
  benchmarks/results/longmemeval-oracle-paired.json \
  benchmarks/results/beam-100k-paired.json \
  --out benchmarks/reports/evidence.md
```

The report refuses results with an unspecified/smoke split, failed ingest,
judge errors, mismatched fairness configuration, different item sets, a
missing fishmem/mem0 counterpart, or missing evidence metadata. Publishable
runs must disclose the exact system version, fixed context tokenizer, provider
call counts, estimated USD cost, and structured degradation diagnostics.
Generated scorecards also include the SHA-256 of every native result artifact,
the exact write/answer/embed/judge configuration, per-category paired results,
and a separate LOCOMO categories 1–4 standard aggregate when category 5 is
present.

Use `--draft` for an explicitly non-publishable stage report. Draft reports
still require paired item IDs and identical fairness configuration, and list
the publication blocker instead of hiding failed provider calls:

```bash
pnpm bench:report -- benchmarks/results/canary.json --draft \
  --out benchmarks/reports/canary.md
```

## Answer provider policy

The three end-to-end runners can change the **answer generator** without
changing either memory system or the benchmark judge:

- `openai-chat` is the compatibility default.
- `openai-responses` is the reproducible path for evidence runs. It uses the
  OpenAI Responses API, records response usage, and can be published when the
  normal evidence gate passes.
- `codex-cli` uses the community
  [AI SDK Codex CLI provider](https://ai-sdk.dev/providers/community-providers/codex-cli)
  with the local ChatGPT subscription. A stateless `app-server` run is eligible
  for publication only when the result freezes the exact model, Codex CLI and
  provider versions, isolated no-tools/read-only settings, and benchmark
  instruction SHA-256. `exec` and incomplete manifests remain non-publishable.

Codex runs still require the configured OpenAI-compatible endpoint key: memory
writes, embeddings, and the official benchmark judge remain on their disclosed
API models. Only answer generation moves to Codex. Keep the same answer
provider, model, reasoning effort, transport, and runtime for both systems.
The scorecard requires exactly one Codex answer call per item and labels USD as
metered API cost; ChatGPT-subscription calls are retained in token/call evidence
but excluded from USD.

```bash
# Reproducible API run suitable for publication after all other gates pass
pnpm bench:locomo -- --systems fishmem,mem0 --conversations 1 \
  --max-questions 20 --split dev \
  --llm gpt-5.6-luna --write-reasoning none \
  --answer-provider openai-responses \
  --answer-model gpt-5.6-luna --answer-reasoning none

# Subscription-backed reproducible run (Codex CLI >= 0.144.0)
codex --version
pnpm bench:locomo -- --systems fishmem,mem0 --conversations 1 \
  --max-questions 5 --split dev \
  --llm gpt-5.6-luna --write-reasoning none \
  --answer-provider codex-cli \
  --answer-model gpt-5.6-sol --answer-reasoning none \
  --codex-transport app-server
```

`app-server` keeps one Codex process alive for the run and is preferred over
spawning `codex exec` for every answer. Codex still has substantial fixed
input-token and latency overhead, which the result records separately from
memory ingest/search. The official Codex CLI install/update command is documented in
[OpenAI's Codex CLI guide](https://learn.chatgpt.com/docs/codex/cli).

Head-to-head evaluation of **fishmem** against **mem0 (OSS, `mem0ai/oss`)** on the
[LOCOMO](https://github.com/snap-research/locomo) long-term conversational memory
benchmark — the same dataset and methodology used in the
[mem0 paper](https://arxiv.org/abs/2504.19413) and mem0's own `evaluation/` suite.

## What is measured

Both systems receive **identical inputs**: the same chunked conversation
messages, the same `userId` scoping, and the same models
(`gpt-4o-mini` + `text-embedding-3-small` by default). Answer generation and
judging use one shared LLM pipeline, so the only variable is the memory layer
itself — fact extraction, update decisions, and retrieval.

| Metric | Meaning |
|---|---|
| judge accuracy | LLM-as-a-Judge (CORRECT/WRONG vs gold answer), overall and per question category |
| mean F1 / BLEU-1 | token-overlap of generated vs gold answers |
| search p50/p95 | retrieval latency per question |
| answer p50 | answer-generation latency (shared LLM, sanity check) |
| ingest total / chunk p50 | cost of writing the conversation into memory |
| memories created | how many memories each system distilled |
| mean context tokens | exact `o200k_base` tokens passed to the answer model |
| provider usage | LLM calls, embedding calls, and estimated USD |
| degradation diagnostics | warning codes, retries, and timeouts |

Provider usage comes from the actual OpenAI-compatible response payload, not
request-length estimation. Each result freezes the reference price table used
for USD calculation. `bench:gate` rejects missing response usage, unknown model
prices, unscoped calls, and price-table mismatches between paired systems.
Failed HTTP attempts are counted separately from billable successful calls and
contribute to the reliability degradation count.

Long-running native runners atomically refresh `<out>.progress.json` and
`<out>.progress.md` after every durable unit. These show completion, current
quality, provider usage, failed calls, cost, and the paired delta over IDs that
both systems have completed. Full unit payloads remain in
`<out>*.partial.jsonl`; `--resume` reuses them after an interruption, and the
sidecars are removed only after the final result JSON is durable. LOCOMO also
persists each completed answer and its provider usage in
`<out>.questions.partial.jsonl`, so an answer or judge failure does not discard
earlier questions from the same long conversation. When `--question-retries`
is non-zero, every failed workload attempt is atomically recorded in
`<out>.question-attempts.json` and included in reliability diagnostics; failed
attempt usage is never presented as a successful question's billable usage.
`bench:resume` records every process attempt in `<out>.attempts.json` and uses
exponential backoff with bounded jitter (5 seconds up to 60 seconds by
default), so an upstream outage does not become a tight restart loop.
`bench:report` hashes and summarizes that ledger. `bench:gate` reports a
separate `operationalMetricsPublishable` decision: durable completed units can
still support a quality comparison after a restart, but a run with failed or
interrupted process attempts cannot support total-cost or wall-clock claims.

Question categories (per LOCOMO): 1 multi-hop, 2 temporal, 3 open-domain,
4 single-hop. Category 5 (adversarial) is excluded by default, matching the
mem0 paper's headline setup.

## Setup

```bash
# 1. dataset (~2.7 MB, not committed)
curl -L -o benchmarks/locomo/data/locomo10.json \
  https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json

# 2. API key
export OPENAI_API_KEY=sk-...   # or put it in .env
```

`mem0ai` is pinned exactly to `3.1.2`; the result cache also includes the
adapter source hash, so dependency or adapter changes cannot reuse stale
baselines. `better-sqlite3` is explicitly authorized in
`pnpm-workspace.yaml`, and the real mem0 adapter contract test fails if its
native binding is unavailable. There is no manual-build fallback.

Ingest is sequential LLM calls and takes tens of minutes for a full
conversation — run the benchmark detached (`nohup ... > bench.log 2>&1 &`)
rather than inside anything with a timeout.

## Run

```bash
# offline pipeline check, no API key needed (mock providers, fishmem only)
pnpm bench:locomo -- --smoke

# quick comparison: 1 conversation (~30–50 LLM-eligible questions)
pnpm bench:locomo -- --systems fishmem,mem0 --conversations 1 --split dev

# paired LongMemEval run, one output file with both native system results
pnpm bench:longmemeval -- --systems fishmem,mem0 --variant oracle --instances 50 --split dev

# balanced phase run: 5 questions from each LongMemEval type
pnpm bench:longmemeval -- --systems fishmem,mem0 --variant oracle --per-type 5 --split dev

# paired BEAM run (100K is the cheapest real tier)
pnpm bench:beam -- --systems fishmem,mem0 --variant 100k --instances 2 --split dev

# small-budget sample: cap questions per conversation
pnpm bench:locomo -- --conversations 1 --max-questions 20 --split dev

# publishable full portfolio slice: all 10 conversations and all 1,986 questions
pnpm bench:locomo -- --conversations 10 --categories 1,2,3,4,5 --split full
```

Results print as a markdown table and are written in full (per-question
answers, judge labels, latencies) to `benchmarks/results/*.json`.

### Flags

| Flag | Default | Notes |
|---|---|---|
| `--systems` | `fishmem,mem0` | comma-separated |
| `--split` | required | `dev`, `holdout`, or `full`; smoke sets `smoke` |
| `--conversations` | `1` | of 10 LOCOMO conversations |
| `--max-questions` | all | cap per conversation, for budget control |
| `--categories` | `1,2,3,4` | include `5` to add adversarial questions |
| `--top-k` | `10` | memories retrieved per question |
| `--chunk-size` | `4` | conversation turns per `add()` call |
| `--max-sessions` | all | cap ingested sessions per conversation (quick validation runs) |
| `--llm` / `--embedder` / `--judge` | `gpt-4o-mini` / `text-embedding-3-small` / `gpt-4o-mini` | memory-write, embedding, and judge models |
| `--write-reasoning` | off | explicit reasoning effort for supported write/extraction models; evidence runs must disclose it |
| `--answer-provider` | `openai-chat` | `openai-chat`, `openai-responses`, or version-pinned `codex-cli` |
| `--answer-model` | = `--llm` | answer generator only; set an available Codex model explicitly for `codex-cli` |
| `--answer-reasoning` | off | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; Chat Completions rejects it and Codex rejects `max` |
| `--codex-path` | `CODEX_PATH` or `codex` | exact CLI binary recorded in the answer manifest |
| `--codex-transport` | `exec` | `app-server` is preferred for more than one answer |
| `--provider-timeout-ms` / `--provider-retries` | `120000` / `2` | individual provider request policy |
| `--operation-timeout-ms` / `--operation-retries` | `300000` / `0` | complete adapter `add`/`search` policy |
| `--question-retries` | `0` | complete LOCOMO search/answer/judge retries; failures remain audited |
| `--out` | `benchmarks/results/locomo-<ts>.json` | |

## Cost guide (rough, gpt-4o-mini + text-embedding-3-small)

Ingesting one LOCOMO conversation ≈ 100–150 `add()` LLM calls; answering ≈ 2
LLM calls per question (answer + judge). One conversation end-to-end for both
systems is typically well under $1; the full 10-conversation run for both
systems is on the order of a few dollars. Use `--max-questions` to sample.

Strict evidence runs use no whole-operation retries. A small, identical
provider retry budget may recover transient HTTP failures; every failed attempt
remains metered and the publication gate limits the recovered provider failure
rate. Failed units resume from checkpoints with a fresh adapter. A provider
request deadline is never reused as the deadline for a complete multi-request
memory operation.

## Fairness protocol

**Fixed for both systems (protocol symmetry):** identical chunked input
messages with the session timestamp prepended to every chunk; identical
`userId` scoping; identical models and reasoning budgets (extraction, embedding, answering,
judging); identical `topK`; one shared answer prompt and one shared blind
judge; latencies and ingest costs measured and reported identically.

**Free per system (capability symmetry):** what each system stores, how it
retrieves, and how its retrieved memories are rendered into context — each
adapter renders every temporal field its system actually stores (fishmem:
`eventDate` + validity intervals + a synthesized profile block; mem0:
`createdAt`/`updatedAt`). Each system runs its full native pipeline — mem0
includes its automatic entity store; fishmem its hybrid RRF retrieval. Context
sizes (`meanContextChars` and exact `o200k_base` tokens), provider usage,
estimated cost, and structured degradation diagnostics are report evidence so
capability differences stay visible rather than hidden.

**Dev/hold-out discipline:** conversation 1 was used for iterative
development of fishmem (4 tuning rounds) and is therefore a **dev set** — treat
its numbers as optimistic. Conversations 2–10 were never inspected during
development; runs on them (frozen config, no further tuning) are the
generalization numbers that count.

- mem0's published LOCOMO numbers come from its Python implementation with
  different prompts; this harness compares the two **TypeScript** stacks under
  one identical protocol rather than reproducing the paper's exact numbers.
