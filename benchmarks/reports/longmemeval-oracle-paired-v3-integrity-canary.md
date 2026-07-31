# fishmem evaluation scorecard (DRAFT - NOT PUBLISHABLE)

Exploratory paired results. This stage report has not passed the complete portfolio release gate; do not use these numbers as benchmark claims.

## longmemeval:oracle (dev)

Run-level publication checks:

- Passed; complete portfolio coverage and release gate are still required.

| system | n | quality | ingest | search p95 | context mean | LLM calls | embed calls | failed calls | est. USD | degradations |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| fishmem | 1 | 100.0% | 17.6 s | 1412 ms | 2085 tok | 3 | 5 | 0 | $0.0015 | 0 |
| mem0 | 1 | 0.0% | 62.9 s | 3413 ms | 279 tok | 6 | 14 | 0 | $0.0059 | 0 |

Paired quality delta: +100.0 pt (95% bootstrap CI +100.0 pt to +100.0 pt); McNemar p=1.0000 (1/0 discordant).
