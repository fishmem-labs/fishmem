# Docs site (Fumadocs, Next.js static export) → served as static files by nginx.
# Build from the REPO ROOT so the pnpm workspace + lockfile resolve:
#   docker build -f apps/docs/Dockerfile -t fishmem-docs .
# (docker-compose.yml at the repo root already sets the right context.)

# ── build stage ──────────────────────────────────────────────────────────────
FROM node:22-slim AS builder
RUN corepack enable
WORKDIR /repo

# Install workspace deps (cached on lockfile + manifests).
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/docs/package.json apps/docs/
RUN pnpm install --frozen-lockfile --filter docs...

# Build the static export (output: "export" → apps/docs/out).
COPY apps/docs apps/docs
RUN pnpm --filter docs build

# ── runtime stage ────────────────────────────────────────────────────────────
FROM nginx:alpine AS runtime
# SPA-ish fallback + sensible caching for a static docs site.
RUN printf 'server {\n  listen 80;\n  absolute_redirect off;\n  root /usr/share/nginx/html;\n  location ~ ^(.+)/$ { return 308 $1; }\n  location / { try_files $uri.html $uri/index.html $uri /404.html; }\n}\n' > /etc/nginx/conf.d/default.conf
COPY --from=builder /repo/apps/docs/out /usr/share/nginx/html
EXPOSE 80
