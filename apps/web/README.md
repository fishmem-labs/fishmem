# FishMem — self-hostable control-plane (`@fishmem/web`)

The open-source web app that wraps the [`fishmem`](../../packages/fishmem) engine
with a documented REST API and dashboard: projects, API keys, a memory browser,
a source-RAG browser, a playground, request/usage views, and webhooks. It is the
open application foundation used by [FishMem Cloud](https://fishmem.com), whose
hosted overlay adds organizations, metering, billing, and managed operations.
Run this application yourself on Node, Docker, or your own Cloudflare account.

**Docs:** [Self-hosted dashboard guide](https://docs.fishmem.com/open-source/self-hosted-dashboard)
· [Engine](../../packages/fishmem) · [API reference](https://docs.fishmem.com/api-reference)

> Licensed under the repository's open-source license. This app contains no
> billing, metering, or payment code — the managed cloud adds those separately.

## Architecture

- **Engine**: the workspace [`fishmem`](../../packages/fishmem) package on a graph
  store + vector index (libSQL/SQLite or Postgres+pgvector on Node; D1 + Vectorize
  on Cloudflare), with `text-embedding-3-small` embeddings and a `gpt-4o-mini`-class
  model for extraction.
- **Control plane** (this app): Better Auth (optional Google/GitHub OAuth +
  email magic links), projects, API keys (`fm_…`, SHA-256 at rest), and webhooks.
- **File ingestion**: immutable source assets, durable extraction tasks, pinned
  Docling conversion, lossless artifacts, then one canonical document/RAG
  writer. Node uses a persistent asset directory and poller; Cloudflare uses R2,
  Queues, and a Container.
- **Tenancy**: every request binds the project id through
  `Memory.forNamespace()`. Namespace is stored and filtered structurally across
  raw memories, vectors, entities, episodes, and derived state.

## Public API

The memory lifecycle is mem0-style with explicit migration differences.
Long-form sources use FishMem's separate document contract.

Authenticate with `Authorization: Bearer fm_…`.

| Method & path | Purpose |
|---|---|
| `POST /v1/memories` | queue inferred add (`202` Event receipt) or synchronously store `infer:false` records |
| `GET /v1/events[/{id}]` | list or inspect privacy-safe memory-inference status and refined results |
| `GET /v1/memories?user_id=…` | list by scope |
| `DELETE /v1/memories?user_id=…` | delete-all by scope |
| `POST /v1/memories/search` | Scoped hybrid search with type, scalar metadata, strategy, sort, and score controls |
| `GET /v1/memories/{id}` | fetch one |
| `PUT /v1/memories/{id}` | update content/metadata |
| `DELETE /v1/memories/{id}` | delete one |
| `GET /v1/memories/{id}/history` | change log (ADD/UPDATE/INVALIDATE/DELETE) |
| `POST /v1/documents` | ingest and version an exact textual source |
| `POST /v1/document-uploads` | create an immutable asynchronous file upload |
| `GET /v1/document-uploads/{id}` | inspect upload/extraction status |
| `PUT /v1/document-uploads/{id}/content` | upload the exact file bytes |
| `POST /v1/document-uploads/{id}/complete` | queue durable extraction |
| `GET /v1/documents` | list current source heads by scope |
| `POST /v1/documents/search` | retrieve citation-ready source chunks |
| `GET /v1/documents/{id}` | fetch source metadata |
| `GET /v1/documents/{id}/content` | fetch direct original text or extracted Markdown |
| `DELETE /v1/documents/{id}` | permanently delete the complete source family |

## Dashboard

`/dashboard` — project overview; `/dashboard/memories` — browse/search memories;
`/dashboard/sources` — upload, version, search, inspect, and delete sources;
`/dashboard/playground` — add → extract → recall loop; `/dashboard/requests` —
inspect API activity; `/dashboard/entities` — users/agents/runs;
`/dashboard/usage` — request and operation breakdowns; plus API keys, webhooks,
settings, and create-api.

## Development

From the monorepo root:

```bash
pnpm install
pnpm --filter fishmem build          # build the engine once

# Node self-host (embedded SQLite — the default OSS path):
cp apps/web/.env.example apps/web/.env                  # set OPENAI_API_KEY + BETTER_AUTH_SECRET
FISHMEM_DB=libsql pnpm --filter @fishmem/web db:migrate:libsql
FISHMEM_RUNTIME=node FISHMEM_DB=libsql pnpm --filter @fishmem/web dev   # → http://localhost:3000

# Cloudflare instead (requires D1 and Vectorize bindings):
pnpm --filter @fishmem/web dev:cloudflare

pnpm --filter @fishmem/web typecheck
```

Required env (a `.env` locally — see `.env.example`; `wrangler secret put` in production):

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY` | LLM extraction + embeddings |
| `BETTER_AUTH_SECRET` | session signing |
| `CRON_SECRET` | authenticates task and maintenance pickup |
| `FISHMEM_ASSET_DIR` | durable raw-file/artifact directory on Node |
| `FISHMEM_EXTRACTOR_URL` | Docling service origin on Node |
| `FISHMEM_TASK_WORKER_BASE_URL` | web origin used by the Node task poller |
| `FISHMEM_SETUP_TOKEN` | one-time proof required to create the first production admin |
| `FISHMEM_TRUSTED_IP_HEADERS` | trusted auth client-IP header(s); Node proxy must overwrite them (default `x-forwarded-for`), Cloudflare defaults to `cf-connecting-ip` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth (optional) |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub OAuth (optional) |
| `AUTH_EMAIL_FROM` / `AUTH_EMAIL_FROM_NAME` | magic-link sender (Node: printed to console if no provider; CF: `EMAIL` binding) |

## Deployment (Cloudflare)

```bash
wrangler d1 create fishmem                 # then set database_id in wrangler.jsonc
wrangler vectorize create fishmem-memories --dimensions=1536 --metric=cosine
wrangler r2 bucket create fishmem
wrangler queues create fishmem-document-tasks
wrangler queues create fishmem-document-tasks-dlq

# REQUIRED: Vectorize only honors query filters on properties with a metadata
# index, and only for vectors inserted AFTER the index exists — create these
# BEFORE writing any memories, or filtered search (incl. the tenant filter)
# silently returns empty results.
for prop in namespaceId recordKind userId agentId runId memoryType documentId sourceKey; do
  wrangler vectorize create-metadata-index fishmem-memories \
    --property-name="$prop" --type=string
done

pnpm run deploy:database                    # apply migrations (incl. engine tables)
pnpm run deploy                             # app + Queue consumer + Docling Container
```

These eight properties stay within Vectorize's ten-index limit. They narrow
candidates only: FishMem rehydrates every hit from D1 and reapplies the full
scope before returning it.

The container image is pinned in `services/extractor/Dockerfile`; Wrangler
builds it during deploy. `DOCUMENT_TASKS` wakes all durable work, including
memory inference and file extraction; its legacy binding name is not a second
document-only queue. D1 owns task status, leases, attempts, backoff, and result,
and the minute cron repairs lost delivery.

Set your own domain/bindings in `wrangler.jsonc`. See the
[self-hosted dashboard guide](https://docs.fishmem.com/open-source/self-hosted-dashboard)
for the full walkthrough.

Production builds reject the first sign-up unless the request supplies the
value of `FISHMEM_SETUP_TOKEN`. Set it as a secret, open `/setup`, and enter it
once when creating the initial admin. After that account exists, FishMem is
invite-only and the token is no longer consulted.
