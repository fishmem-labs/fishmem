# Changelog

All notable changes are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[SemVer](https://semver.org/) (pre-1.0: minor bumps may break).

## [0.1.0] — 2026-06-11

Initial release.

### Engine
- mem0-compatible API: `add / search / get / getAll / update / delete /
  forget / deleteAll / history / reset`, declarative `{ provider, config }`
  configuration, custom extraction/update prompts.
- Spacebot-ported core: relational graph memory (`associations` table),
  importance decay / consolidation / pruning, RRF hybrid recall (parity
  modes preserved and config-gated).
- Hybrid retrieval: vector + FTS + time-aware stream + Personalized-PageRank
  graph diffusion, fused with weighted RRF; diversity pass; opt-in LLM
  rerank; invalidation-chain completion.
- Bi-temporal facts (`eventDate` / `validFrom` / `validTo` /
  `supersededBy`) with an INVALIDATE update op — superseded facts keep a
  validity interval and stay searchable.
- Profile blocks (`refreshProfile` / `getProfile`), tiered memory
  (working/graph, TTL + LRU demotion, `promote`), auto-association on add.

### Storage
- Graph stores: in-memory, Postgres, SQLite/libSQL/Turso, Cloudflare D1
  (one Drizzle adapter). Vector stores: in-memory, pgvector, SQLite, Qdrant,
  Cloudflare Vectorize. All drivers lazily imported; edge-safe.

### Benchmarks
- LOCOMO harness vs mem0 OSS (`mem0ai/oss`) with a documented fairness
  protocol and dev/hold-out discipline. Held-out result: 62.2% vs 54.5%
  LLM-judge accuracy (+41.5pt temporal) at ~6–9× faster search.
