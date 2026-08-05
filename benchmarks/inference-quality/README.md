# Selective memory inference quality gate

This suite measures the write decision before retrieval can hide it. It runs
the production exhaustive prompt and an opt-in selective candidate through the
real `Memory.add()` extraction and persistence path with the same model.
Embedding and storage stay offline; only the live extraction calls use a
provider.

The frozen v1 cases cover durable recall, mixed durable/ephemeral input,
one-shot requests, role attribution, explicit memory opt-out, credentials,
prompt injection, and duplicate facts. The result reports required-fact recall,
no-memory accuracy, forbidden leaks, count compliance, and provider usage.

## Offline harness smoke

```bash
pnpm bench:inference -- --smoke
```

The smoke uses oracle-shaped mock responses and proves only that the runner,
production parser, store, scorer, and result schema work. It is never accepted
as quality evidence.

## Live same-model A/B

Set `OPENAI_API_KEY` in the environment; do not put credentials on the command
line. OpenAI-compatible endpoints can use `OPENAI_BASE_URL`.

```bash
pnpm bench:inference -- \
  --live \
  --model gpt-4o-mini \
  --out benchmarks/results/inference-quality-live.json

pnpm bench:inference:gate -- \
  benchmarks/results/inference-quality-live.json
```

The release gate requires the complete dataset, both prompts, zero critical
memory-control/secret leaks, at least 90% required recall and no-memory
accuracy, and a measurable reduction in unwanted facts or improvement in
no-memory accuracy without a material recall regression.

Until that live gate passes, `FACT_EXTRACTION_SYSTEM` remains the production
default and `SELECTIVE_FACT_EXTRACTION_SYSTEM` is only a candidate that callers
may evaluate explicitly through `customFactExtractionPrompt`.

Live calls may incur provider charges. A smoke result or an unpaired run must
not be used to claim that the prompt improved production quality.
The runner requires an explicit `--live` flag. The complete v1 A/B makes at
most 38 provider requests (19 cases × 2 prompts), with automatic provider
retries disabled. A failed request is recorded as a failed case instead of
silently expanding the authorized call budget.

## Gate history

The 2026-08-01 same-model run completed all 38 requests without retries. The
exhaustive baseline and selective candidate both reached 91.7% required-fact
recall. The candidate removed the baseline's critical credential leak and
improved no-memory accuracy from 66.7% to 77.8%, but still emitted two
forbidden facts and missed the 90% no-memory/count-compliance thresholds. The
gate therefore failed and the production default was not promoted.

The candidate policy was subsequently tightened around source provenance,
current-turn state, explicit identity facts, and assistant/user attribution.
Its one-call system prompt is capped at 1,350 `o200k_base` tokens so boundary
fixes cannot grow provider input without limit.
That revision remains unproven until a new complete live A/B is explicitly
authorized and passes the gate; offline smoke output is not quality evidence.
