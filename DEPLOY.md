# Deployment

fishmem is open-core. The **OSS** edition in this repository is a portable
TanStack Start app. The managed edition is maintained in a private repository
that imports this app and its packages, then adds hosted billing, organizations,
governance, and operations through explicit route and module extensions. No
commercial source or generated overlay is copied into this repository.

| Edition | Deploy targets | Data | Adds |
|---|---|---|---|
| **OSS** (this repo) | Vercel · Cloudflare · self-host (Docker) | libSQL/SQLite · Postgres/pgvector · D1/Vectorize · Qdrant (env-selected) | — |
| **FishMem Cloud** (private) | Cloudflare | D1 + Vectorize + R2 | billing, metering, organizations, governance, hosted operations |

The library (`packages/fishmem`) is runtime-agnostic and powers both. The
backend is chosen by env (`FISHMEM_DB` / `FISHMEM_VECTOR` / …) — see
[docs/OPEN-CORE.md](./docs/OPEN-CORE.md) for the dependency boundary.

---

## Library (self-hosted)

The published package runs anywhere Node runs. Point it at your stores:

```ts
import { Memory } from "fishmem";

const memory = await Memory.create({
  llm:         { provider: "openai",   config: { model: "gpt-4o-mini" } },
  embedder:    { provider: "openai",   config: { model: "text-embedding-3-small" } },
  vectorStore: { provider: "pgvector", config: { connectionString: process.env.DATABASE_URL } },
  graphStore:  { provider: "postgres", config: { connectionString: process.env.DATABASE_URL } },
});
```

Bring up a ready Postgres+pgvector with the bundled compose file:

```bash
docker compose up -d postgres
# DATABASE_URL=postgres://fishmem:fishmem@localhost:5432/fishmem
```

libSQL/SQLite and Qdrant are equally supported — see the [README](./README.md#-how-it-works) providers table.

---

## Docs site (`apps/docs`)

Fumadocs static export, served by nginx.

```bash
docker compose up -d docs          # → http://localhost:8080
# or directly:
docker build -f apps/docs/Dockerfile -t fishmem-docs .
docker run -p 8080:80 fishmem-docs
```

Locally without Docker: `pnpm --filter docs dev` (→ http://localhost:3000).

---

## Dashboard (`apps/web`)

The control plane (TanStack Start + Better Auth + the FishMem API). It is
**runtime-adaptive by design**:

- **OSS on Cloudflare** → D1 (database), Vectorize (vectors), R2, Queues, and a
  Docling Container. Copy `apps/web/wrangler.jsonc`, create resources in your
  own account, fill the placeholder database ID and service names, then deploy
  with `pnpm --filter @fishmem/web deploy`. FishMem-operated production,
  staging, demo, billing, and CMS configuration is intentionally kept outside
  this repository.
- **FishMem Cloud** → imports the same route tree and packages from its private
  application, then adds the marketing, billing, organization, and CMS
  surfaces. OSS does not depend on those modules.
- **OSS self-host** → Node: a relational database (libSQL/SQLite or Postgres) +
  the fishmem Postgres/SQLite stores. Selected by env.

### Self-host runtime selection

Set `FISHMEM_DB` (and `DATABASE_URL` for Postgres). The app detects the runtime
and wires the right adapters:

| `FISHMEM_DB` | App DB (drizzle) | fishmem stores |
|---|---|---|
| `d1` (default on Cloudflare) | `drizzle-orm/d1` | D1 graph + Vectorize |
| `libsql` | `drizzle-orm/libsql` | SQLite graph + SQLite vectors |
| `postgres` | `drizzle-orm/node-postgres` | Postgres graph + pgvector |

On Cloudflare, R2 holds direct-text originals, raw uploaded files, extracted
Markdown, and lossless JSON artifacts. D1 owns immutable descriptors, durable
task state, current heads, and deterministic chunks. A Queue wakes extraction
and a pinned Docling Container converts the file; the D1 row remains the retry
authority and cron repairs lost delivery. `DocumentCorpus` is the only final
RAG writer. Reads verify checksums, snapshots include direct-text originals,
and document/project purge removes linked raw and artifact objects. Vectorize
known-ID reads and deletes are batched in groups of 1,000.

### Status (self-host)

**Node + libSQL is implemented and verified** (Phase A, `docs/OPEN-CORE.md`):
the `lib/platform.ts` seam selects the backend by env; `vite build` + `vite
preview` boot on Node with no Cloudflare (`/v1/memories` no-key → 401, homepage
→ login redirect), and `pnpm --filter @fishmem/web db:push` creates the app
tables on libSQL. The Cloudflare path is unchanged (default).

```bash
# Node self-host, zero external DB server (embedded SQLite):
cp apps/web/.env.example apps/web/.env      # set OPENAI_API_KEY, secrets
FISHMEM_DB=libsql pnpm --filter @fishmem/web db:push   # app tables
FISHMEM_RUNTIME=node FISHMEM_DB=libsql pnpm --filter @fishmem/web build
FISHMEM_RUNTIME=node FISHMEM_DB=libsql pnpm --filter @fishmem/web start
# or: docker compose up -d web
```

The bundled Compose stack includes the web app, a persistent libSQL/object
volume, the pinned Docling CPU image, and a durable task poller:

```bash
docker compose up -d web task-worker
docker compose logs -f web task-worker extractor
```

Back up `fishmem-webdata` as one unit. `FISHMEM_ASSET_DIR` and `DATABASE_URL`
must remain on durable storage together.

**Remaining:** Postgres app-DB support still needs a pg-dialect
`db/schema.pg.ts` mirror before `FISHMEM_DB=postgres` can own the control-plane
tables. The engine's memory stores already support Postgres/pgvector/Qdrant
independently.
