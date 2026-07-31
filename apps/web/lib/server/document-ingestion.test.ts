import { createClient } from "@libsql/client";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import {
  extractionArtifacts,
  operationTasks,
  sourceAssets,
} from "@/db/schema";
import {
  DoclingDocumentExtractor,
  DocumentIngestion,
  type DocumentObjectStore,
  type StoredObject,
  processDocumentExtractionTask,
} from "./document-ingestion";
import { processOperationTaskById } from "./operation-tasks";

async function database() {
  const client = createClient({ url: "file::memory:" });
  for (const name of [
    "../../migrations/0001_fishmem_core.sql",
    "../../migrations/0015_operations_observability.sql",
    "../../migrations/0017_task_leases_provider_prices.sql",
    "../../migrations/0022_async_memory_events.sql",
    "../../migrations/0021_document_extraction.sql",
  ]) {
    await client.executeMultiple(
      readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8"),
    );
  }
  return { client, db: drizzle(client, { schema }) };
}

class MemoryObjectStore implements DocumentObjectStore {
  readonly objects = new Map<
    string,
    StoredObject & { contentType: string }
  >();

  async put(
    key: string,
    bytes: Uint8Array,
    metadata: { contentType: string; checksumSha256: string },
  ) {
    const existing = this.objects.get(key);
    if (existing) {
      if (
        existing.size !== bytes.byteLength ||
        existing.checksumSha256 !== metadata.checksumSha256
      ) {
        throw new Error(`object collision: ${key}`);
      }
      return;
    }
    this.objects.set(key, {
      bytes: Uint8Array.from(bytes),
      size: bytes.byteLength,
      checksumSha256: metadata.checksumSha256,
      contentType: metadata.contentType,
    });
  }

  async get(key: string) {
    const object = this.objects.get(key);
    return object
      ? {
          bytes: Uint8Array.from(object.bytes),
          size: object.size,
          checksumSha256: object.checksumSha256,
        }
      : null;
  }

  async head(key: string) {
    const object = this.objects.get(key);
    return object
      ? {
          size: object.size,
          checksumSha256: object.checksumSha256,
        }
      : null;
  }

  async delete(key: string) {
    this.objects.delete(key);
  }
}

async function checksum(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function uploadCommand(bytes: Uint8Array, checksumSha256: string) {
  return {
    filename: "guide.pdf",
    size_bytes: bytes.byteLength,
    content_type: "application/pdf",
    checksum_sha256: checksumSha256,
    source_key: "manuals/guide.pdf",
    title: "Guide",
    metadata: { channel: "test" },
    user_id: "ada",
  };
}

function ingestedDocument() {
  return {
    document: {
      id: "doc_extracted",
      namespaceId: "workspace",
      sourceKey: "manuals/guide.pdf",
      contentHash: "a".repeat(64),
      versionHash: "b".repeat(64),
      title: "Guide",
      mimeType: "text/markdown",
      sourceUri: undefined,
      metadata: { channel: "test" },
      userId: "ada",
      agentId: undefined,
      runId: undefined,
      sizeBytes: 56,
      createdAt: new Date("2026-07-30T00:00:00.000Z"),
    },
    chunks: 2,
    created: true,
  };
}

describe("asynchronous document ingestion", () => {
  it("uses Docling's asynchronous API and returns Markdown plus structure", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = vi.fn(
      async (url: string, init: RequestInit): Promise<Response> => {
        calls.push({ url, init });
        if (url.endsWith("/v1/convert/file/async")) {
          return Response.json({
            task_id: "docling-task-1",
            task_status: "pending",
          });
        }
        if (url.endsWith("/v1/status/poll/docling-task-1")) {
          return Response.json({
            task_id: "docling-task-1",
            task_status: "success",
          });
        }
        if (url.endsWith("/v1/result/docling-task-1")) {
          return Response.json({
            status: "success",
            processing_time: 1.25,
            errors: [],
            document: {
              md_content: "# Extracted\n\nViolet release token.",
              json_content: { pages: [{ page_no: 1 }] },
            },
          });
        }
        return Response.json({ error_message: "not found" }, { status: 404 });
      },
    );
    const extractor = new DoclingDocumentExtractor(
      fetcher,
      "http://docling",
    );

    await expect(
      extractor.extract({
        bytes: new TextEncoder().encode("%PDF source"),
        filename: "guide.pdf",
        mediaType: "application/pdf",
      }),
    ).resolves.toEqual({
      markdown: "# Extracted\n\nViolet release token.",
      structure: { pages: [{ page_no: 1 }] },
      pageCount: 1,
      processingTimeSeconds: 1.25,
    });
    expect(calls.map((call) => call.url)).toEqual([
      "http://docling/v1/convert/file/async",
      "http://docling/v1/status/poll/docling-task-1",
      "http://docling/v1/result/docling-task-1",
    ]);
    const form = calls[0]?.init.body as FormData;
    expect(form.getAll("to_formats")).toEqual(["md", "json"]);
    expect(form.get("do_ocr")).toBe("true");
    const file = form.get("files");
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe("guide.pdf");
    await expect((file as File).text()).resolves.toBe("%PDF source");
  });

  it("enforces an immutable, idempotent upload lifecycle", async () => {
    const { client, db } = await database();
    const objects = new MemoryObjectStore();
    const ingestion = new DocumentIngestion(db as never, objects);
    const bytes = new TextEncoder().encode("%PDF exact source bytes");
    const checksumSha256 = await checksum(bytes);
    const now = new Date("2026-07-30T00:00:00.000Z");
    const command = uploadCommand(bytes, checksumSha256);

    const created = await ingestion.create(
      "workspace",
      command,
      "upload-guide-1",
      "https://memory.example/v1/document-uploads",
      now,
    );
    expect(created).toMatchObject({
      source_asset: {
        status: "awaiting_upload",
        checksum_sha256: null,
      },
      upload: {
        method: "PUT",
        headers: { "content-type": "application/pdf" },
      },
      operation: { status: "awaiting_upload", attempts: 0 },
    });
    await expect(
      ingestion.create(
        "workspace",
        command,
        "upload-guide-1",
        "https://memory.example/v1/document-uploads",
        now,
      ),
    ).resolves.toMatchObject({
      source_asset: { id: created.source_asset.id },
      operation: { id: created.operation.id },
    });
    await expect(
      ingestion.create(
        "workspace",
        { ...command, title: "Different guide" },
        "upload-guide-1",
        "https://memory.example/v1/document-uploads",
        now,
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: "IDEMPOTENCY_CONFLICT",
    });

    await expect(
      ingestion.putContent(
        "workspace",
        created.source_asset.id,
        bytes.slice(0, -1),
        now,
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: "DOCUMENT_UPLOAD_SIZE_MISMATCH",
    });
    const uploaded = await ingestion.putContent(
      "workspace",
      created.source_asset.id,
      bytes,
      now,
    );
    expect(uploaded).toMatchObject({
      status: "uploaded",
      checksum_sha256: checksumSha256,
    });
    await expect(
      ingestion.putContent(
        "workspace",
        created.source_asset.id,
        bytes,
        now,
      ),
    ).resolves.toMatchObject({ status: "uploaded" });

    const queued = await ingestion.complete(
      "workspace",
      created.source_asset.id,
      now,
    );
    expect(queued).toMatchObject({
      source_asset: { status: "queued" },
      operation: { status: "pending" },
    });
    await expect(
      ingestion.complete("workspace", created.source_asset.id, now),
    ).resolves.toMatchObject({
      source_asset: { status: "queued" },
      operation: { status: "pending" },
    });
    await ingestion.create(
      "workspace",
      command,
      "stale-upload-1",
      "https://memory.example/v1/document-uploads",
      new Date(now.getTime() - 48 * 60 * 60_000),
    );
    await expect(
      ingestion.deleteExpiredUploads(
        new Date(now.getTime() - 24 * 60 * 60_000),
      ),
    ).resolves.toEqual({ source_assets: 1, artifacts: 0 });
    expect(await db.select().from(sourceAssets)).toHaveLength(1);
    expect(await db.select().from(operationTasks)).toHaveLength(1);
    client.close();
  });

  it("cancels only unclaimed uploads and expires terminal failures", async () => {
    const { client, db } = await database();
    const objects = new MemoryObjectStore();
    const ingestion = new DocumentIngestion(db as never, objects);
    const bytes = new TextEncoder().encode("%PDF cancellation source");
    const checksumSha256 = await checksum(bytes);
    const now = new Date("2026-07-30T00:00:00.000Z");

    const cancellable = await ingestion.create(
      "workspace",
      uploadCommand(bytes, checksumSha256),
      "upload-cancel-1",
      "https://memory.example/v1/document-uploads",
      now,
    );
    await ingestion.putContent(
      "workspace",
      cancellable.source_asset.id,
      bytes,
      now,
    );
    await ingestion.complete("workspace", cancellable.source_asset.id, now);
    await expect(
      ingestion.deleteUpload("workspace", cancellable.source_asset.id),
    ).resolves.toEqual({ source_assets: 1, artifacts: 0 });
    expect(objects.objects.size).toBe(0);
    expect(await db.select().from(sourceAssets)).toHaveLength(0);
    expect(await db.select().from(operationTasks)).toHaveLength(0);

    const failed = await ingestion.create(
      "workspace",
      uploadCommand(bytes, checksumSha256),
      "upload-failed-1",
      "https://memory.example/v1/document-uploads",
      now,
    );
    await ingestion.putContent(
      "workspace",
      failed.source_asset.id,
      bytes,
      now,
    );
    await ingestion.complete("workspace", failed.source_asset.id, now);
    await db
      .update(operationTasks)
      .set({ status: "processing" })
      .where(eq(operationTasks.documentId, failed.operation.id));
    await db
      .update(sourceAssets)
      .set({ status: "processing" })
      .where(eq(sourceAssets.id, failed.source_asset.id));
    await expect(
      ingestion.deleteUpload("workspace", failed.source_asset.id),
    ).rejects.toMatchObject({
      status: 409,
      code: "SOURCE_ASSET_BUSY",
    });

    const expiredAt = new Date("2026-06-01T00:00:00.000Z");
    await db
      .update(operationTasks)
      .set({ status: "dead" })
      .where(eq(operationTasks.documentId, failed.operation.id));
    await db
      .update(sourceAssets)
      .set({ status: "failed", updatedAt: expiredAt })
      .where(eq(sourceAssets.id, failed.source_asset.id));
    await expect(
      ingestion.deleteExpiredFailures(
        new Date("2026-07-01T00:00:00.000Z"),
      ),
    ).resolves.toEqual({ source_assets: 1, artifacts: 0 });
    expect(objects.objects.size).toBe(0);
    expect(await db.select().from(sourceAssets)).toHaveLength(0);
    expect(await db.select().from(operationTasks)).toHaveLength(0);
    client.close();
  });

  it("reuses the immutable extraction artifact when final RAG ingest retries", async () => {
    const { client, db } = await database();
    const objects = new MemoryObjectStore();
    const ingestion = new DocumentIngestion(db as never, objects);
    const bytes = new TextEncoder().encode("%PDF retry source bytes");
    const checksumSha256 = await checksum(bytes);
    const now = new Date("2026-07-30T00:00:00.000Z");
    const created = await ingestion.create(
      "workspace",
      uploadCommand(bytes, checksumSha256),
      "upload-retry-1",
      "https://memory.example/v1/document-uploads",
      now,
    );
    await ingestion.putContent("workspace", created.source_asset.id, bytes, now);
    await ingestion.complete("workspace", created.source_asset.id, now);

    const extractor = {
      name: "test-extractor",
      version: "1.0.0",
      extract: vi.fn().mockResolvedValue({
        markdown:
          "# Guide\n\nThe violet release token must be verified before rollout.",
        structure: { pages: [{ number: 1 }, { number: 2 }] },
        pageCount: 2,
      }),
    };
    const ingestDocument = vi
      .fn()
      .mockRejectedValueOnce(new Error("document corpus temporarily offline"))
      .mockResolvedValueOnce(ingestedDocument());
    const memory = {
      forNamespace: vi.fn().mockReturnValue({ ingestDocument }),
    };
    const handler = async (task: typeof operationTasks.$inferSelect) =>
      processDocumentExtractionTask(
        db as never,
        memory as never,
        objects,
        extractor,
        task,
      );

    await expect(
      processOperationTaskById(
        db as never,
        { document_extract: handler },
        created.operation.id,
        now,
      ),
    ).resolves.toMatchObject({ claimed: 1, retried: 1 });
    expect(extractor.extract).toHaveBeenCalledOnce();
    expect(ingestDocument).toHaveBeenCalledOnce();
    expect(await db.select().from(extractionArtifacts)).toHaveLength(1);
    expect(
      await db
        .select()
        .from(sourceAssets)
        .where(
          and(
            eq(sourceAssets.workspaceId, "workspace"),
            eq(sourceAssets.id, created.source_asset.id),
          ),
        )
        .get(),
    ).toMatchObject({ status: "failed", ingestedDocumentId: null });

    const retryAt = new Date(now.getTime() + 60_000);
    await expect(
      processOperationTaskById(
        db as never,
        { document_extract: handler },
        created.operation.id,
        retryAt,
      ),
    ).resolves.toMatchObject({ claimed: 1, succeeded: 1 });
    expect(extractor.extract).toHaveBeenCalledOnce();
    expect(ingestDocument).toHaveBeenCalledTimes(2);
    expect(ingestDocument).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sourceKey: "manuals/guide.pdf",
        content: expect.stringContaining("violet release token"),
        mimeType: "text/markdown",
      }),
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(/^document-extract:artifact_/),
      }),
    );
    expect(await db.select().from(extractionArtifacts)).toHaveLength(1);
    expect(
      await db
        .select()
        .from(sourceAssets)
        .where(eq(sourceAssets.id, created.source_asset.id))
        .get(),
    ).toMatchObject({
      status: "ready",
      ingestedDocumentId: "doc_extracted",
      error: null,
    });
    expect(
      await db
        .select()
        .from(operationTasks)
        .where(eq(operationTasks.documentId, created.operation.id))
        .get(),
    ).toMatchObject({
      status: "success",
      attempts: 2,
      error: null,
      result: {
        retrieval: {
          status: "propagating",
          visibility_target_ms: 120_000,
        },
      },
    });
    expect(objects.objects.size).toBe(3);
    await expect(
      ingestion.deleteForDocument("workspace", "doc_extracted"),
    ).resolves.toEqual({ source_assets: 1, artifacts: 1 });
    expect(objects.objects.size).toBe(0);
    expect(await db.select().from(sourceAssets)).toHaveLength(0);
    expect(await db.select().from(extractionArtifacts)).toHaveLength(0);
    expect(await db.select().from(operationTasks)).toHaveLength(0);
    client.close();
  });
});
