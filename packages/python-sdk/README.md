# `fishmem`

Official Python SDK for FishMem Cloud, self-hosted FishMem, and FishMem
Desktop.

```bash
pip install fishmem
```

```python
from fishmem import FishMem

with FishMem(api_key="fm_...") as fishmem:
    fishmem.memories.add_and_wait(
        {
            "content": "The user prefers concise answers.",
            "user_id": "alex",
        },
        idempotency_key="alex-answer-style-v1",
    )
    results = fishmem.memories.search(
        {"query": "How should I answer Alex?", "user_id": "alex"}
    )
```

Use `AsyncFishMem` in async applications. Neither client applies hidden
automatic retries; mutation methods accept an explicit `idempotency_key`.
Both clients expose `health.get()` for authenticated project readiness and
durable backlog status.

Structural scope entities are available on sync, async, and Desktop clients:

```python
for entity in fishmem.entities.list_all(entity_type="user"):
    print(entity["id"], entity["total_memories"])

fishmem.entities.delete(
    "user", "alex", idempotency_key="delete-user-alex-v1"
)
```

They are derived from active canonical memories and are distinct from named
entities in the memory graph.

The HTTP and Desktop clients share audited memory feedback:

```python
fishmem.memories.set_feedback(
    "mem_123",
    {"rating": "negative", "reason": "Out of date"},
    idempotency_key="feedback-mem-123-v1",
)
current = fishmem.memories.get_feedback("mem_123")
```

Inferred writes are asynchronous. `memories.add_async(...)` returns a durable
Event receipt immediately, `events.wait(...)` polls it, and
`memories.add_and_wait(...)` returns the terminal refined results. An
already-distilled `infer=False` add remains synchronous. Both sync and async
clients expose `events.list`, `events.get`, and `events.wait`.

`memories.batch_update(...)` and `memories.batch_delete(...)` queue up to 1,000
selected mutations and return an operation with ordered per-item results. Both
require `idempotency_key`; the same methods work through `FishMemDesktop` in
one local CLI call.

Long-form text uses the separate source-RAG resource:

```python
from pathlib import Path

uploaded = fishmem.documents.upload(
    Path("./handbook.pdf"),
    {
        "source_key": "handbook/product.pdf",
        "user_id": "alex",
    },
    idempotency_key="handbook-pdf-v1",
)

completed = fishmem.operations.wait(
    uploaded["operation"]["id"],
    interval=1.0,
    timeout=600.0,
)

source = fishmem.documents.ingest(
    {
        "source_key": "handbook/deployments.md",
        "content": "# Deployments\n\nProduction deploys require...",
        "mime_type": "text/markdown",
        "user_id": "alex",
    },
    idempotency_key="handbook-deployments-v1",
)
evidence = fishmem.documents.search(
    {"query": "What is required before deployment?", "user_id": "alex"}
)
original = fishmem.documents.content(source["document"]["id"])
```

The synchronous and asynchronous clients both expose direct text ingest,
asynchronous file upload, search, list/list-all, get, content, and permanent
source-family deletion. HTTP file upload accepts supported PDF, Office, EPUB,
email, image, and text files up to 25 MB and 300 extracted pages. It retains the
raw file and lossless extraction structure, then indexes extracted Markdown.
Use `create_upload`, `get_upload`, and `complete_upload` when you need manual
lifecycle control.

For the local Desktop process:

```python
from fishmem import FishMemDesktop

desktop = FishMemDesktop()  # invokes the machine-oriented fishmem CLI
desktop.memories.add(
    {
        "content": "Use the canonical deployment pipeline.",
        "infer": False,
    },
    idempotency_key="deployment-pipeline-v1",
)
source = desktop.documents.ingest(
    {
        "source_key": "handbook/deployments.md",
        "content": "# Deployments\n\nProduction deploys require...",
        "mime_type": "text/markdown",
    },
    idempotency_key="local-handbook-deployments-v1",
)
uploaded = desktop.documents.upload(
    Path("./deployments.md"),
    {"source_key": "handbook/deployments.md", "agent_id": "codex"},
    idempotency_key="local-handbook-file-v1",
)
evidence = desktop.documents.search(
    {"query": "What is required before deployment?"}
)
original = desktop.documents.content(source["document"]["id"])

for entity in desktop.entities.list_all(entity_type="user"):
    print(entity["id"], entity["total_memories"])
```

FishMem Desktop accepts already-distilled records and always stores them with
`infer=false`. It never invokes a remote LLM or embedding provider.
`desktop.documents` exposes the same ingest, upload, search, list/list-all,
get, content, and delete operations for textual sources. Upload validates and
decodes at most 1 MB of UTF-8 locally; it does not run Docling/OCR or call a
remote embedding or file-processing provider. Payloads travel over stdin, not
the process argument list.
