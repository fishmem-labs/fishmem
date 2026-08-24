# fishmem evaluation scorecard (DRAFT - NOT PUBLISHABLE)

Exploratory paired results. This stage report has not passed the complete portfolio release gate; do not use these numbers as benchmark claims.

Source result artifacts:

- `benchmarks/results/longmemeval-oracle-luna-strict-provider-canary-pertype1-2026-08-23.json` — SHA-256 `7a8549507a6916a8291690f76219786eea2b4db4e9615c32a6f2df91c6cc78d8`

## longmemeval:oracle (dev)

Run-level publication checks:

- Passed; complete portfolio coverage and release gate are still required.

Configuration: write `gpt-5.6-luna` (reasoning `none`); answer `openai-responses:gpt-5.6-luna` (reasoning `none`); embedder `text-embedding-3-small`; judge `gpt-4o`; endpoint `https://api.openai-next.com/v1`; top-k `10`; chunk size `4`.

Versions: fishmem `fishmem-src:85784dfa2bd2f93a+adapter:56b725fd5fdab303`; mem0 `mem0ai:3.1.2+adapter:56b725fd5fdab303`.

| system | n | quality | ingest | search p95 | context mean | LLM calls | embed calls | failed calls | est. USD | degradations |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| fishmem | 6 | 83.3% | 338.3 s | 795 ms | 184 tok | 48 | 92 | 0 | $0.0333 | 0 |
| mem0 | 6 | 83.3% | 381.8 s | 2487 ms | 391 tok | 48 | 118 | 0 | $0.0656 | 0 |

Paired quality delta: +0.0 pt (95% bootstrap CI +0.0 pt to +0.0 pt); McNemar p=1.0000 (0/0 discordant).

| category | n | fishmem | mem0 | paired delta |
|---|---:|---:|---:|---:|
| knowledge-update | 1 | 100.0% | 100.0% | +0.0 pt |
| multi-session | 1 | 0.0% | 0.0% | +0.0 pt |
| single-session-assistant | 1 | 100.0% | 100.0% | +0.0 pt |
| single-session-preference | 1 | 100.0% | 100.0% | +0.0 pt |
| single-session-user | 1 | 100.0% | 100.0% | +0.0 pt |
| temporal-reasoning | 1 | 100.0% | 100.0% | +0.0 pt |
