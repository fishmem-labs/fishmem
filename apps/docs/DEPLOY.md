# FishMem Docs — deploy

Standalone docs sub-app: **Next.js + Fumadocs**, static export (`output: 'export'`).
No OpenNext — the build emits plain static files in `out/`, served by a
Cloudflare **assets-only Worker** (`fishmem-docs`). It installs independently
(its own `node_modules` / `pnpm-lock.yaml`) and does not touch the main app.

## Build & deploy

```bash
cd apps/docs
pnpm install --frozen-lockfile
pnpm run deploy     # clean-source gate + build + wrangler deploy
```

The deploy command requires a clean Git worktree, verifies the critical Cloud,
migration, cookbook, and integration pages in the static export, and attaches
the source commit to the Cloudflare deployment. Use the normal build or Docker
container smoke tests while developing; only a reviewed commit can replace the
public docs site.

`pnpm preview` runs the same build under `wrangler dev` locally.
`pnpm dev` runs the Fumadocs dev server (fast, Turbopack).

## Where it serves

`wrangler.jsonc` mounts a **subdomain**: `docs.fishmem.com` (custom domain on the
`fishmem-docs` worker). The apex `fishmem.com` stays on the main app worker,
untouched. Same pattern mem0 uses (`docs.mem0.ai`).

Docs are served at the **root** of the subdomain — `docsRoute = '/'` and the
pages live in the `src/app/(docs)/[[...slug]]` route group, so:
`docs.fishmem.com/` is the overview, `docs.fishmem.com/quickstart`, etc.
(There is no `/docs` segment.)

The custom domain provisions automatically on deploy because the `fishmem.com`
zone is already in the same Cloudflare account.

## Option: serve at `fishmem.com/docs*` instead of a subdomain

The docs already serve at the app root, so subpath hosting only needs:

1. `next.config.mjs` → add `basePath: '/docs'` (so assets resolve under
   `/docs/_next/*`), and rewrite the `content/docs/*.mdx` cross-links to be
   route-relative so Next's basePath can prefix them.
2. `wrangler.jsonc` → replace the subdomain route with a pattern route
   `{ "pattern": "fishmem.com/docs*", "zone_name": "fishmem.com" }`.
   Cloudflare routes the `/docs*` path to `fishmem-docs`; everything else stays
   on the main app worker.

## Notes

- Static search (Orama) is prebuilt into `out/api/search` at build time — works
  without a server.
- The AI-chat route from the template was removed (it requires a server runtime,
  incompatible with static export).
- An OpenAPI playground for the `/v1/memories*` API is a planned follow-up.
