# FishMem Open-Core Architecture

FishMem uses an open-core layout without generated overlays or source copying.

## Open-source repository

- `packages/fishmem`: memory engine, graph storage, vector search, and provider contracts.
- `packages/application`: application use cases shared by every product surface.
- `packages/contracts`: API and integration contracts.
- `packages/sdk`: universal TypeScript HTTP client and explicit Node-only
  Desktop CLI adapter.
- `packages/python-sdk`: synchronous/asynchronous Python HTTP client and
  Desktop CLI adapter.
- `packages/dashboard`: reusable dashboard UI, theme, and presentation logic.
- `apps/web`: TanStack Start web application and public API.
- `apps/desktop`: Electron application providing a privacy-first local memory
  layer for Codex and Claude Code users.

The desktop product stores graph and vector data in one local SQLite database. It
does not require a separate vector database or embedding API key. Its bundled
local embedding model provides semantic search; remote embedding providers are
not supported by Desktop.

See [PRODUCT.md](./PRODUCT.md) for the boundary between Desktop, the
self-hostable web service, and the managed commercial product.

## Commercial repository

The private `fishmem-cloud` repository consumes the open-source packages and
route source directly:

- `web`: TanStack Start commercial application. It mounts the open-source route
  tree and adds billing, usage, pricing, and hosted-service routes.
- `cms`: isolated Payload CMS application. Payload's admin UI requires Next.js,
  so this is intentionally not part of the TanStack product application.

Commercial code may depend on open-source code. Open-source code must never
depend on commercial code.

## Maintenance rules

- Do not restore the former `ee/overlay` or rsync composition workflow.
- Put reusable behavior in open-source packages instead of duplicating it in an
  application.
- Keep commercial additions additive; override an open-source boundary only
  when hosted billing or operations require different behavior.
- Schema changes must be represented by migrations in the owning repository.
