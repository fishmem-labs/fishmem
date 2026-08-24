# fishmem evaluation scorecard (DRAFT - NOT PUBLISHABLE)

Exploratory paired results. This stage report has not passed the complete portfolio release gate; do not use these numbers as benchmark claims.

Source result artifacts:

- `benchmarks/results/longmemeval-final-artifact-integrity-2026-08-23.json` — SHA-256 `8ad44cd31fcc6770d85747b66256f9ca1688890040d4e41babd514b50f6bb0b6`

## longmemeval:oracle (dev)

Run-level publication checks:

- Passed; complete portfolio coverage and release gate are still required.

Configuration: write `gpt-5.6-luna` (reasoning `none`); answer `codex-cli:gpt-5.6-sol` (reasoning `none`); embedder `text-embedding-3-small`; judge `gpt-4o`; endpoint `https://api.openai-next.com/v1`; top-k `10`; chunk size `4`.

Versions: fishmem `fishmem-src:85784dfa2bd2f93a+adapter:73f2f2497c42083e`; mem0 `mem0ai:3.1.2+adapter:73f2f2497c42083e`.

Codex answer runtime: `{"provider":"codex-cli","model":"gpt-5.6-sol","transport":"codex-app-server","reasoningEffort":"none","runtime":{"codexCli":"codex-cli 0.149.0","codexProviderPackage":"ai-sdk-provider-codex-cli@1.3.1","instructionsSha256":"27ac740a2c0324790effd1288717fbe17dd09e8010e3bb41c2f2ece3fb351a1b"},"billing":"chatgpt-subscription","isolation":{"cwd":"ephemeral","threadMode":"stateless","sandbox":"read-only","tools":"disabled"},"publishable":true}`. Estimated USD below covers metered API calls only; exactly one ChatGPT-subscription Codex answer call per item is excluded from USD cost and retained in call/token evidence.

| system | n | quality | ingest | search p95 | context mean | LLM calls | embed calls | failed calls | metered API USD | degradations |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| fishmem | 1 | 100.0% | 76.1 s | 719 ms | 208 tok | 8 | 30 | 0 | $0.0062 | 0 |
| mem0 | 1 | 0.0% | 79.7 s | 1039 ms | 507 tok | 8 | 20 | 0 | $0.0145 | 0 |

Paired quality delta: +100.0 pt (95% bootstrap CI +100.0 pt to +100.0 pt); McNemar p=1.0000 (1/0 discordant).

| category | n | fishmem | mem0 | paired delta |
|---|---:|---:|---:|---:|
| temporal-reasoning | 1 | 100.0% | 0.0% | +100.0 pt |
