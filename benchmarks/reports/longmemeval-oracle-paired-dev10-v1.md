# fishmem evaluation scorecard

All rows use paired items and identical disclosed fairness configuration.

## longmemeval:oracle (dev)

| system | n | quality | ingest | search p95 | context mean | LLM calls | embed calls | est. USD | degradations |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| fishmem | 10 | 60.0% | 130.8 s | 1258 ms | 6260 tok | 30 | 73 | $0.0296 | 0 |
| mem0 | 10 | 60.0% | 1126.2 s | 3342 ms | 346 tok | 86 | 214 | $0.1072 | 6 |

Paired quality delta: +0.0 pt (95% bootstrap CI -40.0 pt to +40.0 pt); McNemar p=1.0000 (2/2 discordant).
