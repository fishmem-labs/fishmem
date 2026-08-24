# LongMemEval benchmark harness

Runs [LongMemEval](https://github.com/xiaowu0162/LongMemEval) (Wu et al., ICLR 2025)
against fishmem and scores answers with the **official LongMemEval judge protocol**:
the per-question-type grading prompts from `src/evaluation/evaluate_qa.py` are
ported verbatim into [`judge.ts`](./judge.ts), including the abstention variant
(question_ids containing `_abs` are unanswerable — the correct behavior is declining),
with the official defaults (judge model `gpt-4o`, temperature 0, max 10 tokens,
verdict = substring `yes`).

## Datasets

Place the files in `benchmarks/longmemeval/data/` (git-ignored):

| file | size | contents |
|------|------|----------|
| `longmemeval_oracle.json` | ~15MB | 500 instances, evidence-only sessions (~2/instance) — cheap validation |
| `longmemeval_s.json` | ~265MB | same 500 instances, full haystack (~50 sessions/instance) |

Download from <https://huggingface.co/datasets/xiaowu0162/longmemeval>.

## Run

```bash
# Offline pipeline check (no API key, mock providers, asserts the
# end-to-end flow including the abstention judging path):
pnpm bench:longmemeval -- --smoke

# Cheap validation on the oracle variant:
pnpm bench:longmemeval -- --systems fishmem,mem0 --variant oracle --split full

# Subset / type filter / faster iteration:
pnpm bench:longmemeval -- --variant oracle --instances 50 --types temporal-reasoning,knowledge-update --split dev

# Stable stratified sample across all six question types:
pnpm bench:longmemeval -- --systems fishmem,mem0 --variant oracle --per-type 5 --split dev

# Full haystack (expensive — see cost guidance below):
NODE_OPTIONS=--max-old-space-size=8192 pnpm bench:longmemeval -- --variant s --concurrency 8 --split full

# Subscription-backed Codex answer run (publishable only after the full gate):
pnpm bench:longmemeval -- --systems fishmem,mem0 --variant oracle \
  --instances 2 --split dev \
  --llm gpt-5.6-luna --write-reasoning none \
  --answer-provider codex-cli \
  --answer-model gpt-5.6-sol --answer-reasoning none \
  --codex-transport app-server
```

`OPENAI_API_KEY` is read from the environment or the repo-root `.env`.
It remains required for Codex answer runs because memory writes, embeddings,
and the official judge stay on their configured compatible API provider. See the shared
[answer provider policy](../README.md#answer-provider-policy).

### Flags

| flag | default | meaning |
|------|---------|---------|
| `--variant oracle\|s` | `oracle` | dataset variant |
| `--split dev\|holdout\|full` | required | disclosure written into result JSON |
| `--instances N` | all (500) | run only the first N instances |
| `--per-type N` | off | take the first N instances of every selected type; mutually exclusive with `--instances` |
| `--types a,b,c` | all | filter question types (`multi-session`, `temporal-reasoning`, `knowledge-update`, `single-session-user`, `single-session-assistant`, `single-session-preference`) |
| `--question-ids a,b` | off | exact diagnostic/reproduction set; mutually exclusive with other sampling flags |
| `--concurrency N` | 8 | instances processed in parallel (sequential within an instance) |
| `--top-k N` | 10 | memories retrieved per question |
| `--chunk-size N` | 4 | conversation turns per `add()` call |
| `--profile-every N` | 10 | `endSession()` (profile refresh) every N sessions; 0 disables |
| `--llm MODEL` | `gpt-4o-mini` | memory-write model and default answer model |
| `--write-reasoning LEVEL` | off | explicit write/extraction reasoning effort for supported models |
| `--answer-model MODEL` | = `--llm` | override the answering model only |
| `--answer-provider NAME` | `openai-chat` | `openai-chat`, `openai-responses`, or version-pinned `codex-cli` |
| `--answer-reasoning LEVEL` | off | Responses/Codex reasoning effort; Codex does not accept `max` |
| `--codex-path PATH` | `CODEX_PATH` or `codex` | Codex CLI binary; app-server requires CLI >= 0.144.0 |
| `--codex-transport NAME` | `exec` | `exec` or preferred persistent `app-server` |
| `--embedder MODEL` | `text-embedding-3-small` | embedding model |
| `--judge MODEL` | `gpt-4o` | judge model (official LongMemEval default) |
| `--provider-timeout-ms N` | `120000` | deadline per provider attempt |
| `--operation-timeout-ms N` | `300000` | deadline for a complete adapter `add`/`search` |
| `--provider-retries N` | `2` | retries for an individual provider request |
| `--operation-retries N` | `0` | retries of a complete adapter operation |
| `--system fishmem\|mem0` | `fishmem` | run one memory system |
| `--systems a,b` | - | run multiple systems into one paired result file |
| `--resume` | off | resume per-system instance checkpoints for the same output path |
| `--out PATH` | `benchmarks/results/longmemeval-<ts>.json` | results JSON |
| `--smoke` | off | offline mock run with 2 fabricated instances |

Each instance is fully isolated: a fresh in-memory adapter instance with
`userId = question_id`, every haystack session ingested as chunked `add()`
calls with the first message of each chunk prefixed
`(conversation date: <haystack_date>)`.

Output: a JSON file (one native run or a paired `systems[]` suite) plus printed
tables with per-question verdicts, accuracy, latency, ingest, usage, and memory
counts.

## Cost guidance (gpt-4o-mini memory writes/answering, gpt-4o judge)

- **oracle**: ≈950 sessions to ingest, 500 answers, 500 judge calls — roughly
  **$2–4**, finishes in tens of minutes at `--concurrency 8`.
- **s (full haystack)**: ≈25,000 sessions; write-side LLM calls only apply to
  systems/overrides that enable derivation or extraction. Do a partial run first
  (`--instances 25`) and use the emitted token accounting to project spend.

## Comparison discipline

Our number is measured under the **official LongMemEval judge protocol**
(verbatim `evaluate_qa.py` prompts, judge model disclosed via `--judge`,
default `gpt-4o`) with the full configuration written into the results JSON —
variant, models, top-k, chunking, retrieval setup.

mem0's published **94.4%** on LongMemEval is their **self-reported** figure with
an undisclosed setup (variant, retrieval configuration, answer model, and judge
configuration are not fully specified in their materials). Cite it as their
claim; do **not** present it as directly comparable to numbers produced by this
harness. The only apples-to-apples comparison is between runs of this harness
with disclosed, identical configs.

### Resumed timing semantics

`successfulOperationMs` is the sum of recorded ingest, search, answer, and
judge durations for successful checkpointed instances. It remains valid across
resume operations and is independent of runner concurrency.
`invocationWallClockMs` measures only the current process invocation and is
reported with `resumedUnits` and `freshUnits`; it must not be presented as
cross-resume elapsed time. Scorecards compare aggregate ingest and per-call
latency, not invocation wall time.
