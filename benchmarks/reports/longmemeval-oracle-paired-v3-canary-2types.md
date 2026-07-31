# fishmem evaluation scorecard (DRAFT - NOT PUBLISHABLE)

Exploratory paired results. This stage report has not passed the complete portfolio release gate; do not use these numbers as benchmark claims.

## longmemeval:oracle (dev)

Run-level publication checks:

- longmemeval:oracle/mem0 has 2 failed provider calls

| system | n | quality | ingest | search p95 | context mean | LLM calls | embed calls | failed calls | est. USD | degradations |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| fishmem | 2 | 50.0% | 163.0 s | 1627 ms | 5127 tok | 6 | 15 | 0 | $0.0049 | 0 |
| mem0 | 2 | 0.0% | 524.1 s | 5767 ms | 327 tok | 18 | 62 | 2 | $0.0214 | 6 |

Paired quality delta: +50.0 pt (95% bootstrap CI +0.0 pt to +100.0 pt); McNemar p=1.0000 (1/0 discordant).
