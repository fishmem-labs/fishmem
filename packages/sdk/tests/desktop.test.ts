import { describe, expect, it, vi } from "vitest";
import {
  FishMemDesktop,
  type DesktopCommandRunner,
} from "../src/desktop.js";

function output(value: unknown) {
  return { stdout: JSON.stringify(value), stderr: "" };
}

describe("FishMem Desktop CLI adapter", () => {
  it("passes JSON as one execFile argument and preserves content literally", async () => {
    const runner = vi.fn<DesktopCommandRunner>().mockResolvedValue(
      output({
        results: [
          {
            id: "m1",
            memory: "Remember $HOME and `backticks`",
            event: "ADD",
          },
        ],
      }),
    );
    const desktop = new FishMemDesktop({ command: "/opt/fishmem", runner });

    await desktop.memories.add(
      {
        content: "Remember $HOME and `backticks`",
        user_id: "ada",
        infer: false,
      },
      { idempotencyKey: "add-1" },
    );

    expect(runner).toHaveBeenCalledOnce();
    const [command, args, options] = runner.mock.calls[0]!;
    expect(command).toBe("/opt/fishmem");
    expect(args).toEqual(["call", "add", "--input-stdin"]);
    expect(JSON.parse(options.stdin!)).toEqual({
      content: "Remember $HOME and `backticks`",
      user_id: "ada",
      infer: false,
      idempotency_key: "add-1",
    });
  });

  it("maps Desktop records to the canonical SDK wire shape", async () => {
    const runner = vi.fn<DesktopCommandRunner>().mockResolvedValue(
      output({
        results: [
          {
            id: "m1",
            content: "Ada prefers tea",
            memoryType: "fact",
            importance: 0.7,
            userId: "ada",
            agentId: "fishmem-desktop",
            createdAt: "2026-07-30T00:00:00.000Z",
            updatedAt: "2026-07-30T00:00:00.000Z",
            lastAccessedAt: "2026-07-30T00:00:00.000Z",
            accessCount: 2,
            score: 0.91,
          },
        ],
      }),
    );
    const desktop = new FishMemDesktop({ runner });

    await expect(
      desktop.memories.search({
        query: "drink",
        user_id: "ada",
        top_k: 4,
        memory_type: "preference",
        search_strategy: "precision",
        filters: {
          and: [
            {
              field: "metadata.channel",
              operator: "eq",
              value: "support",
            },
            {
              field: "importance",
              operator: "gte",
              value: 0.5,
            },
          ],
        },
        trace: true,
      }),
    ).resolves.toEqual({
      results: [
        expect.objectContaining({
          id: "m1",
          memory: "Ada prefers tea",
          memory_type: "fact",
          user_id: "ada",
          event_date: null,
          score: 0.91,
        }),
      ],
    });
    expect(JSON.parse(runner.mock.calls[0]![2].stdin!)).toEqual({
      query: "drink",
      user_id: "ada",
      top_k: 4,
      memory_type: "preference",
      search_strategy: "precision",
      filters: {
        and: [
          {
            field: "metadata.channel",
            operator: "eq",
            value: "support",
          },
          {
            field: "importance",
            operator: "gte",
            value: 0.5,
          },
        ],
      },
      trace: true,
    });
  });

  it("rejects inferred Desktop writes before invoking the CLI", async () => {
    const runner = vi.fn<DesktopCommandRunner>();
    const desktop = new FishMemDesktop({ runner });

    expect(() =>
      desktop.memories.add({
        content: "raw",
        infer: true,
      } as never),
    ).toThrow("infer must be false");
    expect(runner).not.toHaveBeenCalled();
  });

  it("runs batch mutations through one Desktop CLI call with retry identity", async () => {
    const runner = vi.fn<DesktopCommandRunner>().mockResolvedValue(
      output({
        id: "desktop_batch_1",
        kind: "batch_update",
        status: "success",
        attempts: 1,
        max_attempts: 1,
        error: null,
        result: {
          total: 1,
          processed: 1,
          succeeded: 1,
          failed: 0,
          items: [
            {
              memory_id: "mem_1",
              status: "succeeded",
              event: "UPDATE",
            },
          ],
        },
        created_at: "2026-07-30T00:00:00.000Z",
        updated_at: "2026-07-30T00:00:00.000Z",
      }),
    );
    const desktop = new FishMemDesktop({ runner });

    await expect(
      desktop.memories.batchUpdate(
        { memories: [{ memory_id: "mem_1", content: "Updated" }] },
        { idempotencyKey: "desktop-batch-1" },
      ),
    ).resolves.toMatchObject({
      kind: "batch_update",
      result: { succeeded: 1 },
    });
    expect(runner).toHaveBeenCalledWith(
      "fishmem",
      ["call", "batchUpdate", "--input-stdin"],
      expect.objectContaining({
        stdin: JSON.stringify({
          memories: [{ memory_id: "mem_1", content: "Updated" }],
          idempotency_key: "desktop-batch-1",
        }),
      }),
    );
  });

  it("passes delete-all idempotency through the Desktop CLI bridge", async () => {
    const runner = vi
      .fn<DesktopCommandRunner>()
      .mockResolvedValue(output({ deleted: 2 }));
    const desktop = new FishMemDesktop({ command: "/opt/fishmem", runner });

    await expect(
      desktop.memories.deleteAll(
        { user_id: "ada" },
        { idempotencyKey: "delete-all-ada" },
      ),
    ).resolves.toEqual({ deleted: 2 });
    expect(runner).toHaveBeenCalledWith(
      "/opt/fishmem",
      ["call", "deleteAll", "--input-stdin"],
      expect.objectContaining({
        stdin: JSON.stringify({
          user_id: "ada",
          idempotency_key: "delete-all-ada",
        }),
      }),
    );
  });

  it("uses the same feedback surface through the Desktop CLI", async () => {
    const runner = vi
      .fn<DesktopCommandRunner>()
      .mockResolvedValueOnce(output({ feedback: null }))
      .mockResolvedValueOnce(
        output({
          feedback: {
            id: "feedback_1",
            memory_id: "mem_1",
            rating: "positive",
            reason: null,
            request_id: "req_1",
            created_at: "2026-07-31T00:00:00.000Z",
          },
        }),
      )
      .mockResolvedValueOnce(output({ cleared: true }));
    const desktop = new FishMemDesktop({ runner });

    await desktop.memories.getFeedback("mem_1");
    await desktop.memories.setFeedback(
      "mem_1",
      { rating: "positive", request_id: "req_1" },
      { idempotencyKey: "desktop-feedback-1" },
    );
    await desktop.memories.clearFeedback("mem_1", {
      idempotencyKey: "desktop-feedback-clear-1",
    });

    expect(runner.mock.calls.map((call) => call[1][1])).toEqual([
      "getFeedback",
      "setFeedback",
      "clearFeedback",
    ]);
    expect(JSON.parse(runner.mock.calls[1]![2].stdin!)).toEqual({
      id: "mem_1",
      rating: "positive",
      request_id: "req_1",
      idempotency_key: "desktop-feedback-1",
    });
  });

  it("uses the same structural scope-entity resource through Desktop", async () => {
    const now = "2026-07-31T00:00:00.000Z";
    const first = {
      id: "ada/team",
      type: "user",
      total_memories: 2,
      created_at: now,
      updated_at: now,
    } as const;
    const second = {
      id: "run-2",
      type: "run",
      total_memories: 1,
      created_at: now,
      updated_at: now,
    } as const;
    const runner = vi
      .fn<DesktopCommandRunner>()
      .mockResolvedValueOnce(
        output({ results: [first], next_cursor: "page-2" }),
      )
      .mockResolvedValueOnce(
        output({ results: [second], next_cursor: null }),
      )
      .mockResolvedValueOnce(output(first))
      .mockResolvedValueOnce(
        output({
          id: first.id,
          type: first.type,
          deleted_memories: 2,
        }),
      );
    const desktop = new FishMemDesktop({ runner });
    const ids: string[] = [];

    for await (const entity of desktop.entities.listAll({ limit: 1 })) {
      ids.push(entity.id);
    }
    await expect(
      desktop.entities.get("user", "ada/team"),
    ).resolves.toEqual(first);
    await expect(
      desktop.entities.delete("user", "ada/team", {
        idempotencyKey: "desktop-entity-delete-1",
      }),
    ).resolves.toEqual({
      id: "ada/team",
      type: "user",
      deleted_memories: 2,
    });

    expect(ids).toEqual(["ada/team", "run-2"]);
    expect(runner.mock.calls.map((call) => call[1][1])).toEqual([
      "entityList",
      "entityList",
      "entityGet",
      "entityDelete",
    ]);
    expect(JSON.parse(runner.mock.calls[1]![2].stdin!)).toEqual({
      limit: 1,
      cursor: "page-2",
    });
    expect(JSON.parse(runner.mock.calls[3]![2].stdin!)).toEqual({
      type: "user",
      id: "ada/team",
      idempotency_key: "desktop-entity-delete-1",
    });
    expect(() =>
      desktop.entities.delete("user", "ada", { idempotencyKey: " " }),
    ).toThrow("entities.delete requires a non-empty idempotencyKey");
  });

  it("exposes the source corpus through the same Desktop CLI bridge", async () => {
    const runner = vi
      .fn<DesktopCommandRunner>()
      .mockResolvedValueOnce(
        output({
          document: {
            id: "d1",
            source_key: "docs/guide.md",
            content_hash: "content-hash",
            version_hash: "version-hash",
            title: "Guide",
            mime_type: "text/markdown",
            source_uri: null,
            user_id: null,
            agent_id: "fishmem-desktop",
            run_id: null,
            metadata: null,
            size_bytes: 11,
            created_at: "2026-07-30T00:00:00.000Z",
          },
          chunks: 1,
          created: true,
        }),
      )
      .mockResolvedValueOnce(
        output({
          id: "d1",
          content: "source body",
          content_hash: "content-hash",
        }),
      );
    const desktop = new FishMemDesktop({ runner });

    await expect(
      desktop.documents.ingest(
        {
          source_key: "docs/guide.md",
          content: "source body",
          title: "Guide",
          mime_type: "text/markdown",
        },
        { idempotencyKey: "document-1" },
      ),
    ).resolves.toMatchObject({
      document: { id: "d1", source_key: "docs/guide.md" },
      chunks: 1,
      created: true,
    });
    const ingestCall = runner.mock.calls[0]!;
    expect(ingestCall[1]).toEqual([
      "call",
      "documentIngest",
      "--input-stdin",
    ]);
    expect(JSON.parse(ingestCall[2].stdin!)).toMatchObject({
      source_key: "docs/guide.md",
      content: "source body",
      idempotency_key: "document-1",
    });

    await expect(desktop.documents.content("d1")).resolves.toEqual({
      id: "d1",
      content: "source body",
      content_hash: "content-hash",
    });
  });

  it("decodes a textual upload locally before using the Desktop document command", async () => {
    const runner = vi.fn<DesktopCommandRunner>().mockResolvedValue(
      output({
        document: { id: "d-upload", source_key: "docs/upload.md" },
        chunks: 1,
        created: true,
      }),
    );
    const desktop = new FishMemDesktop({ runner });

    await desktop.documents.upload(
      {
        file: new Blob(["# Exact desktop bytes\n"], {
          type: "text/markdown",
        }),
        filename: "upload.md",
        source_key: "docs/upload.md",
        agent_id: "codex",
      },
      { idempotencyKey: "desktop-upload-1" },
    );

    const [, args, options] = runner.mock.calls[0]!;
    expect(args).toEqual(["call", "documentIngest", "--input-stdin"]);
    expect(JSON.parse(options.stdin!)).toEqual({
      source_key: "docs/upload.md",
      content: "# Exact desktop bytes\n",
      title: "upload.md",
      mime_type: "text/markdown",
      agent_id: "codex",
      idempotency_key: "desktop-upload-1",
    });
  });
});
