# Selective memory inference quality gate

This suite measures the write decision before retrieval can hide it. It runs
the frozen exhaustive legacy baseline and the production selective prompt
through the real `Memory.add()` extraction and persistence path with the same
model.
Embedding and storage stay offline; only the live extraction calls use a
provider.

The frozen v3 cases cover durable recall, mixed durable/ephemeral input,
one-shot requests, role attribution, explicit memory opt-out, credentials,
prompt injection, and duplicate facts. The result reports required-fact recall,
no-memory accuracy, forbidden leaks, count compliance, and provider usage.
Version 3 enforces the two-layer contract: an unaccepted assistant suggestion
is not promoted into a canonical fact. Exact assistant/user history belongs to
the separately opt-in Episode archive and its hidden retrieval projection;
that end-to-end recall path is evaluated by the public memory benchmarks, not
by this fact-extraction-only gate.

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

`FACT_EXTRACTION_SYSTEM` now aliases the gate-approved
`SELECTIVE_FACT_EXTRACTION_SYSTEM`. `EXHAUSTIVE_FACT_EXTRACTION_SYSTEM` is kept
only as the reproducible baseline; callers can still supply an explicit
`customFactExtractionPrompt` for governed experiments.

Live calls may incur provider charges. A smoke result or an unpaired run must
not be used to claim that the prompt improved production quality.
The runner requires an explicit `--live` flag. The complete v3 A/B makes at
most 38 provider requests (19 cases × 2 prompts), with automatic provider
retries disabled. A failed request is recorded as a failed case instead of
silently expanding the authorized call budget.

## Gate history

The 2026-08-01 v1 same-model run completed all 38 requests without retries. The
exhaustive baseline and selective candidate both reached 91.7% required-fact
recall. The candidate removed the baseline's critical credential leak and
improved no-memory accuracy from 66.7% to 77.8%, but still emitted two
forbidden facts and missed the 90% no-memory/count-compliance thresholds. The
gate therefore failed and the production default was not promoted.

The v3 policy was subsequently tightened around source provenance,
current-turn state, explicit identity facts, and assistant/user attribution.
Its one-call system prompt is capped at 1,450 `o200k_base` tokens so boundary
fixes cannot grow provider input without limit.

The complete 2026-08-24 live v3 A/B used `gpt-5.6-luna` for both writers and
passed all release conditions. The exhaustive baseline scored 16/19 cases,
100% required-fact recall, 7/9 no-memory cases, one forbidden fact, and four
unwanted facts. The selective writer scored 19/19, 100% required-fact recall,
9/9 no-memory cases, zero forbidden facts, zero unwanted facts, and zero
critical leaks. The immutable artifact is
`benchmarks/results/inference-quality-live-luna-v3-2026-08-24.json` (SHA-256
`7a631a00101e3fb40cb1346a7cf0785385534be5f1e042a71413ba776d5e17b4`).
Offline smoke output remains non-quality evidence.
