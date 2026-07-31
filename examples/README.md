# Examples

Run with [`tsx`](https://github.com/privatenumber/tsx):

```bash
npm i -D tsx

# Offline (mock providers) or OpenAI if OPENAI_API_KEY is set:
npx tsx examples/basic.ts

# Postgres + pgvector:
DATABASE_URL=postgres://... OPENAI_API_KEY=sk-... npx tsx examples/postgres.ts
```

| File                   | Backends                                   |
| ---------------------- | ------------------------------------------ |
| `basic.ts`             | SQLite (libSQL) graph + vector, local file |
| `postgres.ts`          | Postgres graph + pgvector                  |
| `cloudflare-worker.ts` | Cloudflare D1 graph + Vectorize            |

The Cloudflare example is deployed with `wrangler`; see the header comment for
the `wrangler.toml` bindings and the `wrangler vectorize create` command.
