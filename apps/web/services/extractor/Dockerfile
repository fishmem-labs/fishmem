# Keep Cloudflare Containers and Docker/self-host on the exact same extractor
# implementation. The version is pinned because extraction artifacts record it.
FROM ghcr.io/docling-project/docling-serve-cpu:v1.21.0

ENV DOCLING_DEVICE=cpu \
    DOCLING_SERVE_ENABLE_UI=false \
    DOCLING_SERVE_ENABLE_REMOTE_SERVICES=false \
    DOCLING_SERVE_ENG_KIND=local \
    DOCLING_SERVE_ENG_LOC_NUM_WORKERS=1

EXPOSE 5001
