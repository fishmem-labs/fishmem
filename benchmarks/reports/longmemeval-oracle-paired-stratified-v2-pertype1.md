# fishmem evaluation scorecard

All rows use paired items and identical disclosed fairness configuration.

## longmemeval:oracle (dev)

| system | n | quality | ingest | search p95 | context mean | LLM calls | embed calls | est. USD | degradations |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| fishmem | 6 | 83.3% | 94.5 s | 858 ms | 5920 tok | 18 | 42 | $0.0168 | 0 |
| mem0 | 6 | 66.7% | 622.4 s | 3570 ms | 248 tok | 49 | 127 | $0.0584 | 2 |

Paired quality delta: +16.7 pt (95% bootstrap CI +0.0 pt to +50.0 pt); McNemar p=1.0000 (1/0 discordant).
