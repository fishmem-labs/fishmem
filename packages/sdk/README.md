# `@fishmem/sdk`

Official TypeScript SDK for FishMem Cloud, self-hosted FishMem, and the local
FishMem Desktop process.

```bash
npm install @fishmem/sdk
```

```ts
import { FishMem } from "@fishmem/sdk";

const fishmem = new FishMem({
  apiKey: process.env.FISHMEM_API_KEY!,
});

await fishmem.memories.addAndWait(
  {
    content: "The user prefers concise answers.",
    user_id: "alex",
  },
  { idempotencyKey: "alex-answer-style-v1" },
);

const { results } = await fishmem.memories.search({
  query: "How should I answer Alex?",
  user_id: "alex",
});
```

Inferred writes are asynchronous: `addAsync` returns a durable Event receipt,
`events.wait` polls it, and `addAndWait` is the convenience form above.
Already-distilled `infer:false` writes remain synchronous. `fishmem.memories`
also exposes search, list, `listAll`, get, update, audited feedback, durable
batch update/delete, delete-all, and history. Batch calls accept up to 1,000 unique
IDs, require an idempotency key, and return an operation for polling.
Long-form text uses the separate `documents` resource:

```ts
import { readFile } from "node:fs/promises";

const source = await fishmem.documents.ingest(
  {
    source_key: "handbook/deployments.md",
    content: "# Deployments\n\nProduction deploys require...",
    mime_type: "text/markdown",
    user_id: "alex",
  },
  { idempotencyKey: "handbook-deployments-v1" },
);

const uploaded = await fishmem.documents.upload(
  {
    file: new Blob([await readFile("./handbook.pdf")], {
      type: "application/pdf",
    }),
    filename: "handbook.pdf",
    source_key: "handbook/product.pdf",
    user_id: "alex",
  },
  { idempotencyKey: "handbook-pdf-v1" },
);

const completed = await fishmem.operations.wait(uploaded.operation.id, {
  intervalMs: 1_000,
  timeoutMs: 10 * 60_000,
});

const evidence = await fishmem.documents.search({
  query: "What is required before deployment?",
  user_id: "alex",
});
const original = await fishmem.documents.content(source.document.id);
```

`documents.upload()` creates an immutable source asset, uploads exact bytes,
queues Docling extraction, and returns without waiting for extraction. HTTP
deployments accept supported PDF, Office, EPUB, email, image, and text files up
to 25 MB and 300 extracted pages. The raw file and lossless structure are
retained; extracted Markdown, chunks, and indexes are rebuildable.

Direct `documents.ingest()` is the synchronous path for already-textual UTF-8
content up to 1 MB. `documents` exposes ingest, upload, search, list, `listAll`,
get, content, and delete, plus `createUpload`, `getUpload`, and
`completeUpload` for manual lifecycle control. Cloudflare uses R2 for raw files
and artifacts; Node/Docker uses a durable asset directory.
The client also exposes:

- `health.get`;
- `entities.list`, `entities.listAll`, `entities.get`, and idempotent
  `entities.delete` for structural user, agent, and run scopes;
- `state.get` and `state.history`;
- `profile.get`;
- `operations.list`, `operations.get`, and `operations.wait`;
- `events.list`, `events.get`, and `events.wait` for privacy-safe memory
  inference status;
- `exports.create` and `imports.create`.

Feedback is available on both HTTP and Desktop clients:

```ts
await fishmem.memories.setFeedback(
  "mem_123",
  { rating: "negative", reason: "Out of date", request_id: "req_123" },
  { idempotencyKey: "req-123-feedback-v1" },
);
const current = await fishmem.memories.getFeedback("mem_123");
```

The default package entry uses only standard web APIs. The same import works in
Node 20+, Bun, Deno (`npm:@fishmem/sdk`), Cloudflare Workers, and Vercel
Functions. It applies no hidden retries; pass an idempotency key when a
mutation may be retried.

See the [complete SDK documentation](https://docs.fishmem.com/sdk) for every
resource, runtime, error, pagination, and idempotency contract.

## Desktop

The explicit Desktop entry is Node-only because it invokes the installed
`fishmem` CLI without a shell:

```ts
import { FishMemDesktop } from "@fishmem/sdk/desktop";

const desktop = new FishMemDesktop();

await desktop.memories.add(
  {
    content: "Use the canonical deployment pipeline.",
    infer: false,
  },
  { idempotencyKey: "deployment-pipeline-v1" },
);

const { results } = await desktop.memories.search({
  query: "How do we deploy?",
});

const source = await desktop.documents.ingest(
  {
    source_key: "handbook/deployments.md",
    content: "# Deployments\n\nProduction deploys require...",
    mime_type: "text/markdown",
  },
  { idempotencyKey: "local-handbook-deployments-v1" },
);
const uploaded = await desktop.documents.upload(
  {
    file: new Blob(["# Local exact source\n"], {
      type: "text/markdown",
    }),
    filename: "local.md",
    agent_id: "codex",
  },
  { idempotencyKey: "local-upload-v1" },
);
const evidence = await desktop.documents.search({
  query: "What is required before deployment?",
});
const original = await desktop.documents.content(source.document.id);

for await (const entity of desktop.entities.listAll({ type: "user" })) {
  console.log(entity.id, entity.total_memories);
}
```

Desktop accepts already-distilled records with `infer=false`, uses only its
local multilingual E5 embedding model, and never falls back to a hosted
provider. `desktop.documents` has the same source-corpus surface as the HTTP
client for textual documents. Desktop file upload is deliberately UTF-8-only
and capped at 1 MB; it does not run Docling/OCR or call remote embedding or
file-processing providers. SDK payloads travel over stdin, so long source text
is not exposed in the process argument list or constrained by the OS
argument-length limit.
`desktop.entities` uses the same canonical scope aggregation and response
shape as the HTTP client; it does not create a second local entity store.
