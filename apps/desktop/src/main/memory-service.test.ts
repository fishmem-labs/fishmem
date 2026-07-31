import { afterEach, describe, expect, it } from "vitest";
import type { EmbeddingOptions } from "fishmem";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DesktopMemoryService,
  type LocalEmbeddingRuntime,
} from "./memory-service";
import type { LocalEmbeddingState } from "./local-embedder";

class ControlledLocalEmbedder implements LocalEmbeddingRuntime {
  readonly dimensions = 4;
  readonly model = "test/local-e5";
  state: LocalEmbeddingState = { phase: "downloading" };

  private releasePreparation!: () => void;
  private readonly preparation = new Promise<void>((resolve) => {
    this.releasePreparation = resolve;
  });

  async prepare(): Promise<void> {
    await this.preparation;
  }

  release() {
    this.state = { phase: "ready" };
    this.releasePreparation();
  }

  async embed(
    _text: string,
    _options?: EmbeddingOptions,
  ): Promise<number[]> {
    if (this.state.phase !== "ready") throw new Error("model not ready");
    return [1, 0, 0, 0];
  }

  async embedBatch(
    texts: string[],
    options?: EmbeddingOptions,
  ): Promise<number[][]> {
    return Promise.all(texts.map((text) => this.embed(text, options)));
  }
}

describe("DesktopMemoryService local-only embedding contract", () => {
  let directory: string | undefined;
  let service: DesktopMemoryService | undefined;

  afterEach(async () => {
    await service?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("rejects add and search until local E5 is ready instead of using keyword fallback", async () => {
    directory = await mkdtemp(join(tmpdir(), "fishmem-desktop-test-"));
    const embedder = new ControlledLocalEmbedder();
    service = new DesktopMemoryService(
      join(directory, "fishmem.db"),
      join(directory, "models"),
      join(directory, "desktop.sock"),
      () => embedder,
    );
    await service.initialize();

    await expect(
      service.invoke("add", { content: "Local-only memory" }),
    ).rejects.toMatchObject({ code: "LOCAL_EMBEDDING_NOT_READY" });
    await expect(
      service.invoke("search", { query: "memory" }),
    ).rejects.toMatchObject({ code: "LOCAL_EMBEDDING_NOT_READY" });
    await expect(
      service.invoke("documentIngest", {
        source_key: "docs/local.md",
        content: "Local source",
      }),
    ).rejects.toMatchObject({ code: "LOCAL_EMBEDDING_NOT_READY" });

    const retry = service.invoke("retryEmbedding");
    embedder.release();
    await expect(retry).resolves.toMatchObject({ embeddingState: "ready" });
    const added = (await service.invoke("add", {
      content: "Local-only memory",
      idempotency_key: "local-add-1",
    })) as { results: Array<{ id: string; memory: string }> };
    expect(added).toMatchObject({
      results: [{ memory: "Local-only memory" }],
    });
    const id = added.results[0]!.id;
    await expect(service.invoke("get", { id })).resolves.toMatchObject({
      id,
      content: "Local-only memory",
      importance: expect.any(Number),
    });
    await service.invoke("add", {
      content: "Scoped desktop memory",
      user_id: "ada/研究",
      run_id: "run-1",
      idempotency_key: "local-scope-add-1",
    });
    await expect(
      service.invoke("entityList", { type: "user", limit: 10 }),
    ).resolves.toMatchObject({
      results: [
        {
          id: "ada/研究",
          type: "user",
          total_memories: 1,
        },
      ],
      next_cursor: null,
    });
    await expect(
      service.invoke("entityGet", { type: "user", id: "ada/研究" }),
    ).resolves.toMatchObject({
      id: "ada/研究",
      type: "user",
      total_memories: 1,
    });
    const deleteEntityInput = {
      type: "user",
      id: "ada/研究",
      idempotency_key: "local-scope-delete-1",
    };
    await expect(
      service.invoke("entityDelete", deleteEntityInput),
    ).resolves.toEqual({
      id: "ada/研究",
      type: "user",
      deleted_memories: 1,
    });
    await expect(
      service.invoke("entityDelete", deleteEntityInput),
    ).resolves.toEqual({
      id: "ada/研究",
      type: "user",
      deleted_memories: 1,
    });
    await expect(
      service.invoke("entityDelete", {
        ...deleteEntityInput,
        idempotency_key: "local-scope-delete-2",
      }),
    ).rejects.toMatchObject({ code: "SCOPE_ENTITY_NOT_FOUND" });
    await expect(
      service.invoke("entityDelete", {
        type: "user",
        id: "ada/研究",
      }),
    ).rejects.toThrow("entities.delete requires idempotency_key");
    const batchTarget = (await service.invoke("add", {
      content: "Batch target",
      idempotency_key: "local-add-batch",
    })) as { results: Array<{ id: string }> };
    const batchTargetId = batchTarget.results[0]!.id;
    await expect(
      service.invoke("batchUpdate", {
        memories: [
          { memory_id: id, content: "Batch-updated local memory" },
          { memory_id: "missing", content: "Never written" },
        ],
        idempotency_key: "local-batch-update-1",
      }),
    ).resolves.toMatchObject({
      kind: "batch_update",
      status: "success",
      result: {
        total: 2,
        processed: 2,
        succeeded: 1,
        failed: 1,
        items: [
          { memory_id: id, status: "succeeded", event: "UPDATE" },
          {
            memory_id: "missing",
            status: "failed",
            error: { code: "MEMORY_NOT_FOUND" },
          },
        ],
      },
    });
    await expect(
      service.invoke("batchDelete", {
        memories: [{ memory_id: batchTargetId }],
        idempotency_key: "local-batch-delete-1",
      }),
    ).resolves.toMatchObject({
      kind: "batch_delete",
      status: "success",
      result: { succeeded: 1, failed: 0 },
    });
    await expect(
      service.invoke("update", {
        id,
        content: "Updated local memory",
        idempotency_key: "local-update-1",
      }),
    ).resolves.toMatchObject({
      id,
      memory: "Updated local memory",
      event: "UPDATE",
    });
    await expect(service.invoke("history", { id })).resolves.toMatchObject({
      results: [
        { event: "ADD" },
        { event: "UPDATE" },
        { event: "UPDATE" },
      ],
    });
    await expect(
      service.invoke("setFeedback", {
        id,
        rating: "negative",
        reason: "Out of date",
        request_id: "desktop-search-1",
        idempotency_key: "desktop-feedback-1",
      }),
    ).resolves.toMatchObject({
      feedback: {
        memory_id: id,
        rating: "negative",
        reason: "Out of date",
        request_id: "desktop-search-1",
      },
    });
    await expect(service.invoke("getFeedback", { id })).resolves.toMatchObject({
      feedback: { memory_id: id, rating: "negative" },
    });
    await expect(
      service.invoke("clearFeedback", {
        id,
        idempotency_key: "desktop-feedback-clear-1",
      }),
    ).resolves.toEqual({ cleared: true });
    await expect(service.invoke("getFeedback", { id })).resolves.toEqual({
      feedback: null,
    });
    await expect(
      service.invoke("delete", {
        id,
        idempotency_key: "local-delete-1",
      }),
    ).resolves.toEqual({ id, deleted: true });

    const ingested = (await service.invoke("documentIngest", {
      source_key: "docs/local.md",
      content: "The local release token is violet.",
      title: "Local source",
      mime_type: "text/markdown",
      idempotency_key: "local-document-1",
    })) as {
      document: { id: string; source_key: string };
      chunks: number;
      created: boolean;
    };
    expect(ingested).toMatchObject({
      document: {
        source_key: "docs/local.md",
        agent_id: "fishmem-desktop",
      },
      chunks: 1,
      created: true,
    });
    const documentId = ingested.document.id;
    await expect(
      service.invoke("documentList", { limit: 10 }),
    ).resolves.toMatchObject({
      results: [{ id: documentId, source_key: "docs/local.md" }],
      next_cursor: null,
    });
    await expect(
      service.invoke("documentContent", { id: documentId }),
    ).resolves.toMatchObject({
      id: documentId,
      content: "The local release token is violet.",
    });
    await expect(
      service.invoke("documentSearch", {
        query: "violet release token",
      }),
    ).resolves.toMatchObject({
      results: [
        {
          document: { id: documentId },
          chunk: { content: "The local release token is violet." },
        },
      ],
    });
    const deleteInput = {
      id: documentId,
      idempotency_key: "local-document-delete-1",
    };
    await expect(
      service.invoke("documentDelete", deleteInput),
    ).resolves.toMatchObject({ id: documentId, deleted: true });
    await expect(
      service.invoke("documentDelete", deleteInput),
    ).resolves.toMatchObject({ id: documentId, deleted: true });
    await expect(
      service.invoke("documentDelete", {
        id: documentId,
        idempotency_key: "local-document-delete-2",
      }),
    ).rejects.toMatchObject({ code: "DOCUMENT_NOT_FOUND" });
  });
});
