# OSS dashboard (@fishmem/web) on Node — self-host with libSQL or Postgres.
# Cloudflare deploys the TanStack Start worker directly; this image is Node-only.
# Build from the REPO ROOT (pnpm workspace): the root docker-compose.yml does.
#   docker build -f apps/web/Dockerfile -t fishmem-web .

FROM node:22-slim AS base
RUN corepack enable
WORKDIR /repo
ENV FISHMEM_RUNTIME=node

# ── deps + build ───────────────────────────────────────────────────────────────
FROM base AS builder
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/fishmem/package.json packages/fishmem/
COPY packages/contracts/package.json packages/contracts/
COPY packages/application/package.json packages/application/
COPY packages/dashboard/package.json packages/dashboard/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @fishmem/web... --filter fishmem
COPY packages packages
COPY apps/web apps/web
RUN pnpm --filter fishmem build
# FISHMEM_DB drives the build's runtime branch; default libSQL for self-host.
ENV FISHMEM_DB=libsql
RUN pnpm --filter @fishmem/web build
RUN pnpm --filter @fishmem/web deploy --prod --legacy /runtime

# ── runtime ────────────────────────────────────────────────────────────────────
FROM node:22-slim AS runtime
ENV NODE_ENV=production FISHMEM_DB=libsql
COPY --from=builder /runtime /app
WORKDIR /app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
	CMD ["node", "-e", "fetch('http://127.0.0.1:3000/').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
# Apply committed app-table migrations transactionally, then serve the built
# fetch handler and static client without shipping the Vite development server.
CMD ["sh", "-c", "node scripts/migrate-libsql.mjs && exec node node_modules/srvx/bin/srvx.mjs serve --prod --dir /app --static /app/dist/client --entry /app/dist/server/server.js"]
