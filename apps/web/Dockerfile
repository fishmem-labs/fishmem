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
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @fishmem/web... --filter fishmem
COPY packages packages
COPY apps/web apps/web
RUN pnpm --filter fishmem build
# FISHMEM_DB drives the build's runtime branch; default libSQL for self-host.
ENV FISHMEM_DB=libsql
RUN pnpm --filter @fishmem/web build

# ── runtime ────────────────────────────────────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production FISHMEM_DB=libsql
COPY --from=builder /repo /repo
WORKDIR /repo/apps/web
EXPOSE 3000
# Apply app-table migrations (idempotent) then serve.
CMD ["sh", "-c", "pnpm exec drizzle-kit push --force && pnpm start"]
