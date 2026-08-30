import { describe, expect, it } from "vitest";
import {
  type NamespaceSnapshotV1,
  parseNamespaceSnapshot,
  SNAPSHOT_FORMAT,
  SNAPSHOT_VERSION,
} from "../src/core/snapshot.js";

const ISO = "2026-07-30T10:00:00.000Z";

function richSnapshot(): NamespaceSnapshotV1 {
  return {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    exportedAt: ISO,
    sourceNamespaceId: "source",
    projections: {
      sidecar: "rebuild-required",
      vectors: "rebuild-required",
    },
    data: {
      memories: [
        {
          id: "memory-1",
          namespaceId: "source",
          content: "Ada prefers tea",
          memoryType: "preference",
          importance: 0.8,
          createdAt: ISO,
          updatedAt: ISO,
          lastAccessedAt: ISO,
          demotedAt: ISO,
          eventDate: ISO,
          validFrom: ISO,
          validTo: ISO,
          accessCount: 1,
          forgotten: false,
          tier: "graph",
          projectionHints: {
            belief: {
              version: 1,
              origin: "inferred",
              applicability: { kind: "project", key: "source" },
              claimValue: "likes tea",
              evidenceKey: "add-1",
              contextId: "conversation-1",
              weight: 0.8,
            },
          },
          episodeId: "episode-1",
          supersededBy: "memory-2",
        },
        {
          id: "memory-2",
          namespaceId: "source",
          content: "Ada prefers coffee",
          memoryType: "preference",
          importance: 0.8,
          createdAt: ISO,
          updatedAt: ISO,
          lastAccessedAt: ISO,
          accessCount: 0,
          forgotten: false,
          tier: "graph",
        },
      ],
      documents: [
        {
          id: "document-1",
          namespaceId: "source",
          sourceKey: "guide.md",
          contentHash: "source-hash",
          versionHash: "version-hash",
          content: "source body",
          mimeType: "text/markdown",
          sizeBytes: 11,
          createdAt: ISO,
        },
      ],
      documentHeads: [
        {
          id: "head-1",
          namespaceId: "source",
          sourceKey: "guide.md",
          documentId: "document-1",
          updatedAt: ISO,
        },
      ],
      documentChunks: [
        {
          id: "chunk-1",
          namespaceId: "source",
          documentId: "document-1",
          sourceKey: "guide.md",
          index: 0,
          content: "source body",
          startOffset: 0,
          endOffset: 11,
          contentHash: "chunk-hash",
          createdAt: ISO,
        },
      ],
      associations: [
        {
          id: "association-1",
          sourceId: "memory-1",
          targetId: "memory-2",
          relationType: "updates",
          weight: 1,
          createdAt: ISO,
        },
      ],
      history: [
        {
          id: "history-1",
          memoryId: "memory-1",
          event: "ADD",
          previousValue: null,
          newValue: "Ada prefers tea",
          createdAt: ISO,
        },
      ],
      entities: [
        {
          id: "entity-1",
          namespaceId: "source",
          name: "Ada",
          normalized: "ada",
          mentionCount: 1,
          createdAt: ISO,
        },
      ],
      memoryEntities: [{ memoryId: "memory-1", entityId: "entity-1" }],
      episodes: [
        {
          id: "episode-1",
          namespaceId: "source",
          messages: [{ role: "user", content: "I prefer tea" }],
          createdAt: ISO,
        },
      ],
      operations: [
        {
          id: "operation-1",
          namespaceId: "source",
          idempotencyKey: "add-1",
          kind: "add",
          requestHash: "request-hash",
          command: {},
          memoryIds: ["memory-1"],
          status: "committed",
          rawStatus: "ready",
          vectorStatus: "ready",
          derivedStatus: "not_requested",
          result: { results: [] },
          leaseExpiresAt: ISO,
          attempts: 1,
          createdAt: ISO,
          updatedAt: ISO,
        },
      ],
      events: [
        {
          id: "event-1",
          namespaceId: "source",
          operationId: "operation-1",
          memoryId: "memory-1",
          eventType: "ADD",
          payload: {},
          occurredAt: ISO,
        },
      ],
    },
  };
}

describe("namespace snapshot validation", () => {
  it("retargets every authoritative row and parses every date field", () => {
    const parsed = parseNamespaceSnapshot(richSnapshot(), "target");

    expect(parsed.memories[0]).toMatchObject({
      namespaceId: "target",
      createdAt: new Date(ISO),
      demotedAt: new Date(ISO),
      eventDate: new Date(ISO),
      validFrom: new Date(ISO),
      validTo: new Date(ISO),
      projectionHints: {
        belief: {
          applicability: { kind: "project", key: "target" },
          claimValue: "likes tea",
          evidenceKey: "add-1",
          contextId: "conversation-1",
          weight: 0.8,
        },
      },
    });
    expect(parsed.documents[0]?.namespaceId).toBe("target");
    expect(parsed.documentHeads[0]?.namespaceId).toBe("target");
    expect(parsed.documentChunks[0]?.namespaceId).toBe("target");
    expect(parsed.entities[0]?.namespaceId).toBe("target");
    expect(parsed.episodes[0]?.namespaceId).toBe("target");
    expect(parsed.operations[0]).toMatchObject({
      namespaceId: "target",
      leaseExpiresAt: new Date(ISO),
    });
    expect(parsed.events[0]?.namespaceId).toBe("target");
  });

  it("rejects malformed envelopes and primitive rows", () => {
    expect(() => parseNamespaceSnapshot(null, "target")).toThrow(
      "snapshot must be an object",
    );
    expect(() => parseNamespaceSnapshot("snapshot", "target")).toThrow(
      "snapshot must be an object",
    );
    expect(() =>
      parseNamespaceSnapshot({ ...richSnapshot(), format: "other" }, "target"),
    ).toThrow("unsupported fishmem snapshot");
    expect(() =>
      parseNamespaceSnapshot({ ...richSnapshot(), version: 2 }, "target"),
    ).toThrow("unsupported fishmem snapshot");
    expect(() =>
      parseNamespaceSnapshot(
        { ...richSnapshot(), sourceNamespaceId: " " },
        "target",
      ),
    ).toThrow("sourceNamespaceId must be a non-empty string");
    expect(() => parseNamespaceSnapshot(richSnapshot(), " ")).toThrow(
      "target namespace must be a non-empty string",
    );

    const withoutData = richSnapshot();
    (withoutData as unknown as { data?: unknown }).data = undefined;
    expect(() => parseNamespaceSnapshot(withoutData, "target")).toThrow(
      "snapshot data is required",
    );

    const invalidArray = richSnapshot();
    (invalidArray.data as unknown as Record<string, unknown>).memoryEntities =
      null;
    expect(() => parseNamespaceSnapshot(invalidArray, "target")).toThrow(
      "data.memoryEntities must be an array",
    );

    const primitiveRow = richSnapshot();
    (primitiveRow.data.memories as unknown[])[0] = [];
    expect(() => parseNamespaceSnapshot(primitiveRow, "target")).toThrow(
      "memory[0] must be an object",
    );

    const blankId = richSnapshot();
    blankId.data.memories[0]!.id = " ";
    expect(() => parseNamespaceSnapshot(blankId, "target")).toThrow(
      "memory[0].id must be a non-empty string",
    );

    const nonStringDate = richSnapshot();
    (
      nonStringDate.data.memories[0] as unknown as { createdAt: unknown }
    ).createdAt = 0;
    expect(() => parseNamespaceSnapshot(nonStringDate, "target")).toThrow(
      "memory.createdAt must be an ISO date",
    );

    const invalidDate = richSnapshot();
    invalidDate.data.memories[0]!.createdAt = "not-a-date";
    expect(() => parseNamespaceSnapshot(invalidDate, "target")).toThrow(
      "memory.createdAt must be an ISO date",
    );

    const nonCanonicalDate = richSnapshot();
    nonCanonicalDate.data.memories[0]!.createdAt = "2026-07-30T10:00:00Z";
    expect(() => parseNamespaceSnapshot(nonCanonicalDate, "target")).toThrow(
      "memory.createdAt must be an ISO date",
    );
  });

  it("rejects every dangling cross-row reference", () => {
    const cases: Array<{
      mutate: (snapshot: NamespaceSnapshotV1) => void;
      message: string;
    }> = [
      {
        mutate: (snapshot) => {
          snapshot.data.documentHeads[0]!.documentId = "missing";
        },
        message: "documentHead[0] must reference an imported document",
      },
      {
        mutate: (snapshot) => {
          snapshot.data.documentHeads[0]!.sourceKey = "other.md";
        },
        message: "documentHead[0] sourceKey must match its document",
      },
      {
        mutate: (snapshot) => {
          snapshot.data.documentChunks[0]!.documentId = "missing";
        },
        message: "documentChunk[0] must reference an imported document",
      },
      {
        mutate: (snapshot) => {
          snapshot.data.documentChunks[0]!.sourceKey = "other.md";
        },
        message: "documentChunk[0] sourceKey must match its document",
      },
      {
        mutate: (snapshot) => {
          snapshot.data.associations[0]!.sourceId = "missing";
        },
        message: "association[0] must reference imported memories",
      },
      {
        mutate: (snapshot) => {
          snapshot.data.associations[0]!.targetId = "missing";
        },
        message: "association[0] must reference imported memories",
      },
      {
        mutate: (snapshot) => {
          snapshot.data.history[0]!.memoryId = "missing";
        },
        message: "history[0] must reference an imported memory",
      },
      {
        mutate: (snapshot) => {
          snapshot.data.memoryEntities[0]!.memoryId = "missing";
        },
        message: "memoryEntities[0] must reference imported rows",
      },
      {
        mutate: (snapshot) => {
          snapshot.data.memoryEntities[0]!.entityId = "missing";
        },
        message: "memoryEntities[0] must reference imported rows",
      },
      {
        mutate: (snapshot) => {
          snapshot.data.memories[0]!.episodeId = "missing";
        },
        message: "memory[0].episodeId must reference an imported episode",
      },
      {
        mutate: (snapshot) => {
          snapshot.data.memories[0]!.supersededBy = "missing";
        },
        message: "memory[0].supersededBy must reference an imported memory",
      },
      {
        mutate: (snapshot) => {
          snapshot.data.operations[0]!.memoryIds = ["missing"];
        },
        message: "operation[0] must reference imported memories",
      },
      {
        mutate: (snapshot) => {
          snapshot.data.events[0]!.memoryId = "missing";
        },
        message: "event[0] must reference an imported memory",
      },
      {
        mutate: (snapshot) => {
          snapshot.data.events[0]!.operationId = "missing";
        },
        message: "event[0] must reference an imported operation",
      },
      {
        mutate: (snapshot) => {
          snapshot.data.documents[0]!.namespaceId = "other";
        },
        message: "document[0].namespaceId must match sourceNamespaceId",
      },
    ];

    for (const testCase of cases) {
      const snapshot = richSnapshot();
      testCase.mutate(snapshot);
      expect(() => parseNamespaceSnapshot(snapshot, "target")).toThrow(
        testCase.message,
      );
    }
  });

  it("validates implementation-owned belief projection hints", () => {
    const invalidKind = richSnapshot();
    (
      invalidKind.data.memories[0]!.projectionHints!.belief!.applicability as {
        kind: string;
      }
    ).kind = "forged";
    expect(() => parseNamespaceSnapshot(invalidKind, "target")).toThrow(
      "applicability.kind is invalid",
    );

    const invalidWeight = richSnapshot();
    invalidWeight.data.memories[0]!.projectionHints!.belief!.weight = 2;
    expect(() => parseNamespaceSnapshot(invalidWeight, "target")).toThrow(
      "weight must be within (0, 1]",
    );

    const globalWithKey = richSnapshot();
    globalWithKey.data.memories[0]!.projectionHints!.belief!.applicability = {
      kind: "global",
      key: "forged",
    };
    expect(() => parseNamespaceSnapshot(globalWithKey, "target")).toThrow(
      "global applicability must not have a key",
    );
  });
});
