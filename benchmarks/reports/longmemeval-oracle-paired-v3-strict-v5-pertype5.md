# fishmem evaluation scorecard

All rows use paired items and identical disclosed fairness configuration.

## longmemeval:oracle (dev)

| system | n | quality | ingest | search p95 | context mean | LLM calls | embed calls | failed calls | est. USD | degradations |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| fishmem | 30 | 73.3% | 567.1 s | 1498 ms | 5153 tok | 90 | 192 | 0 | $0.0748 | 0 |
| mem0 | 30 | 56.7% | 1775.6 s | 3481 ms | 291 tok | 222 | 546 | 0 | $0.2610 | 0 |

Paired quality delta: +16.7 pt (95% bootstrap CI +0.0 pt to +33.3 pt); McNemar p=0.1250 (6/1 discordant).
