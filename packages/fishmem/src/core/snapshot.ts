import type { GraphSnapshotData } from "../graph/base.js";
import type {
  Association,
  DocumentChunk,
  DocumentHead,
  DocumentSource,
  Entity,
  Episode,
  HistoryEntry,
  Memory,
  MemoryProjectionHints,
} from "../types.js";
import { APPLICABILITY_KINDS } from "./belief-reconciler.js";
import type { MemoryJournalEvent, MemoryOperation } from "./journal.js";

export const SNAPSHOT_FORMAT = "fishmem.namespace-snapshot" as const;
export const SNAPSHOT_VERSION = 1 as const;

export type SnapshotMemory = Omit<
  Memory,
  | "createdAt"
  | "updatedAt"
  | "lastAccessedAt"
  | "demotedAt"
  | "eventDate"
  | "validFrom"
  | "validTo"
> & {
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string;
  demotedAt?: string;
  eventDate?: string;
  validFrom?: string;
  validTo?: string;
};

export type SnapshotEntity = Omit<Entity, "createdAt"> & { createdAt: string };
export type SnapshotDocument = Omit<DocumentSource, "createdAt"> & {
  createdAt: string;
};
export type SnapshotDocumentHead = Omit<DocumentHead, "updatedAt"> & {
  updatedAt: string;
};
export type SnapshotDocumentChunk = Omit<DocumentChunk, "createdAt"> & {
  createdAt: string;
};
export type SnapshotEpisode = Omit<Episode, "createdAt"> & {
  createdAt: string;
};
export type SnapshotAssociation = Omit<Association, "createdAt"> & {
  createdAt: string;
};
export type SnapshotHistoryEntry = Omit<HistoryEntry, "createdAt"> & {
  createdAt: string;
};
export type SnapshotOperation = Omit<
  MemoryOperation,
  "createdAt" | "updatedAt" | "leaseExpiresAt"
> & {
  createdAt: string;
  updatedAt: string;
  leaseExpiresAt?: string;
};
export type SnapshotJournalEvent = Omit<MemoryJournalEvent, "occurredAt"> & {
  occurredAt: string;
};

export interface NamespaceSnapshotV1 {
  format: typeof SNAPSHOT_FORMAT;
  version: typeof SNAPSHOT_VERSION;
  exportedAt: string;
  sourceNamespaceId: string;
  projections: {
    sidecar: "rebuild-required";
    vectors: "rebuild-required";
    /** Additive in v1 so snapshots produced before this projection still load. */
    beliefs?: "rebuild-required";
  };
  data: {
    memories: SnapshotMemory[];
    documents: SnapshotDocument[];
    documentHeads: SnapshotDocumentHead[];
    documentChunks: SnapshotDocumentChunk[];
    associations: SnapshotAssociation[];
    history: SnapshotHistoryEntry[];
    entities: SnapshotEntity[];
    memoryEntities: Array<{ memoryId: string; entityId: string }>;
    episodes: SnapshotEpisode[];
    operations: SnapshotOperation[];
    events: SnapshotJournalEvent[];
  };
}

export function createNamespaceSnapshot(
  namespaceId: string,
  data: GraphSnapshotData,
  exportedAt = new Date(),
): NamespaceSnapshotV1 {
  const byId = <T extends { id: string }>(a: T, b: T) =>
    a.id.localeCompare(b.id);
  return {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    exportedAt: exportedAt.toISOString(),
    sourceNamespaceId: namespaceId,
    projections: {
      sidecar: "rebuild-required",
      vectors: "rebuild-required",
      beliefs: "rebuild-required",
    },
    data: {
      memories: data.memories
        .map((memory) => ({
          ...memory,
          createdAt: memory.createdAt.toISOString(),
          updatedAt: memory.updatedAt.toISOString(),
          lastAccessedAt: memory.lastAccessedAt.toISOString(),
          demotedAt: memory.demotedAt?.toISOString(),
          eventDate: memory.eventDate?.toISOString(),
          validFrom: memory.validFrom?.toISOString(),
          validTo: memory.validTo?.toISOString(),
        }))
        .sort(byId),
      documents: data.documents
        .map((document) => ({
          ...document,
          createdAt: document.createdAt.toISOString(),
        }))
        .sort(byId),
      documentHeads: data.documentHeads
        .map((head) => ({
          ...head,
          updatedAt: head.updatedAt.toISOString(),
        }))
        .sort(byId),
      documentChunks: data.documentChunks
        .map((chunk) => ({
          ...chunk,
          createdAt: chunk.createdAt.toISOString(),
        }))
        .sort(byId),
      associations: data.associations
        .map((association) => ({
          ...association,
          createdAt: association.createdAt.toISOString(),
        }))
        .sort(byId),
      history: data.history
        .map((entry) => ({
          ...entry,
          createdAt: entry.createdAt.toISOString(),
        }))
        .sort(byId),
      entities: data.entities
        .map((entity) => ({
          ...entity,
          createdAt: entity.createdAt.toISOString(),
        }))
        .sort(byId),
      memoryEntities: [...data.memoryEntities].sort(
        (a, b) =>
          a.memoryId.localeCompare(b.memoryId) ||
          a.entityId.localeCompare(b.entityId),
      ),
      episodes: data.episodes
        .map((episode) => ({
          ...episode,
          createdAt: episode.createdAt.toISOString(),
        }))
        .sort(byId),
      operations: data.operations
        .map((operation) => ({
          ...operation,
          createdAt: operation.createdAt.toISOString(),
          updatedAt: operation.updatedAt.toISOString(),
          leaseExpiresAt: operation.leaseExpiresAt?.toISOString(),
        }))
        .sort(byId),
      events: data.events
        .map((event) => ({
          ...event,
          occurredAt: event.occurredAt.toISOString(),
        }))
        .sort(byId),
    },
  };
}

export function parseNamespaceSnapshot(
  value: unknown,
  targetNamespaceId: string,
): GraphSnapshotData {
  if (!value || typeof value !== "object") {
    throw new TypeError("snapshot must be an object");
  }
  const snapshot = value as Partial<NamespaceSnapshotV1>;
  if (
    snapshot.format !== SNAPSHOT_FORMAT ||
    snapshot.version !== SNAPSHOT_VERSION
  ) {
    throw new TypeError("unsupported fishmem snapshot format or version");
  }
  const sourceNamespaceId = snapshot.sourceNamespaceId;
  if (typeof sourceNamespaceId !== "string" || !sourceNamespaceId.trim()) {
    throw new TypeError(
      "snapshot sourceNamespaceId must be a non-empty string",
    );
  }
  if (!targetNamespaceId.trim()) {
    throw new TypeError("snapshot target namespace must be a non-empty string");
  }
  const data = snapshot.data;
  if (!data) throw new TypeError("snapshot data is required");
  for (const key of [
    "memories",
    "documents",
    "documentHeads",
    "documentChunks",
    "associations",
    "history",
    "entities",
    "memoryEntities",
    "episodes",
    "operations",
    "events",
  ] as const) {
    if (!Array.isArray(data[key])) {
      throw new TypeError(`snapshot data.${key} must be an array`);
    }
  }
  const record = (input: unknown, field: string): Record<string, unknown> => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError(`snapshot ${field} must be an object`);
    }
    return input as Record<string, unknown>;
  };
  const namespaced = <T extends { namespaceId?: string }>(
    row: T,
    field: string,
  ): T & { namespaceId: string } => {
    if (row.namespaceId !== sourceNamespaceId) {
      throw new TypeError(
        `snapshot ${field}.namespaceId must match sourceNamespaceId`,
      );
    }
    return { ...row, namespaceId: targetNamespaceId };
  };
  const id = (input: unknown, field: string): string => {
    if (typeof input !== "string" || !input.trim()) {
      throw new TypeError(`snapshot ${field} must be a non-empty string`);
    }
    return input;
  };
  const date = (input: unknown, field: string): Date => {
    if (typeof input !== "string") {
      throw new TypeError(`snapshot ${field} must be an ISO date`);
    }
    const parsed = new Date(input);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== input) {
      throw new TypeError(`snapshot ${field} must be an ISO date`);
    }
    return parsed;
  };
  const optionalDate = (input: unknown, field: string) =>
    input === undefined ? undefined : date(input, field);
  const projectionHints = (
    input: unknown,
    field: string,
  ): MemoryProjectionHints | undefined => {
    if (input === undefined) return undefined;
    const hints = record(input, field);
    if (hints.belief === undefined) return undefined;
    const belief = record(hints.belief, `${field}.belief`);
    if (belief.version !== 1 || belief.origin !== "inferred") {
      throw new TypeError(
        `${field}.belief has an unsupported version or origin`,
      );
    }
    const applicability = record(
      belief.applicability,
      `${field}.belief.applicability`,
    );
    if (
      typeof applicability.kind !== "string" ||
      !APPLICABILITY_KINDS.includes(applicability.kind as never)
    ) {
      throw new TypeError(`${field}.belief.applicability.kind is invalid`);
    }
    const key =
      applicability.key === undefined
        ? undefined
        : id(applicability.key, `${field}.belief.applicability.key`);
    if (applicability.kind === "global" && key) {
      throw new TypeError(
        `${field}.belief global applicability must not have a key`,
      );
    }
    if (applicability.kind !== "global" && !key) {
      throw new TypeError(
        `${field}.belief ${applicability.kind} applicability requires a key`,
      );
    }
    const applicabilityValidFrom = applicability.validFrom as unknown;
    const applicabilityValidTo = applicability.validTo as unknown;
    if (applicabilityValidFrom !== undefined) {
      date(applicabilityValidFrom, `${field}.belief.applicability.validFrom`);
    }
    if (applicabilityValidTo !== undefined) {
      date(applicabilityValidTo, `${field}.belief.applicability.validTo`);
    }
    if (
      typeof applicabilityValidFrom === "string" &&
      typeof applicabilityValidTo === "string" &&
      Date.parse(applicabilityValidTo) <= Date.parse(applicabilityValidFrom)
    ) {
      throw new TypeError(
        `${field}.belief applicability.validTo must be after validFrom`,
      );
    }
    const evidenceKey = id(belief.evidenceKey, `${field}.belief.evidenceKey`);
    const contextId = id(belief.contextId, `${field}.belief.contextId`);
    if (
      typeof belief.weight !== "number" ||
      !Number.isFinite(belief.weight) ||
      belief.weight <= 0 ||
      belief.weight > 1
    ) {
      throw new TypeError(`${field}.belief.weight must be within (0, 1]`);
    }
    const claimValue =
      belief.claimValue === undefined
        ? undefined
        : id(belief.claimValue, `${field}.belief.claimValue`);
    const retargetedKey =
      applicability.kind === "project" && key === sourceNamespaceId
        ? targetNamespaceId
        : key;
    const retargetedContextId =
      applicability.kind === "project" &&
      key === sourceNamespaceId &&
      contextId === sourceNamespaceId
        ? targetNamespaceId
        : contextId;
    return {
      belief: {
        version: 1,
        origin: "inferred",
        applicability: {
          kind: applicability.kind as (typeof APPLICABILITY_KINDS)[number],
          ...(retargetedKey ? { key: retargetedKey } : {}),
          ...(typeof applicabilityValidFrom === "string"
            ? { validFrom: applicabilityValidFrom }
            : {}),
          ...(typeof applicabilityValidTo === "string"
            ? { validTo: applicabilityValidTo }
            : {}),
        },
        ...(claimValue ? { claimValue } : {}),
        evidenceKey,
        contextId: retargetedContextId,
        weight: belief.weight,
      },
    };
  };
  const memoryIds = new Set(
    data.memories.map((row, index) =>
      id(record(row, `memory[${index}]`).id, `memory[${index}].id`),
    ),
  );
  const entityIds = new Set(
    data.entities.map((row, index) =>
      id(record(row, `entity[${index}]`).id, `entity[${index}].id`),
    ),
  );
  const episodeIds = new Set(
    data.episodes.map((row, index) =>
      id(record(row, `episode[${index}]`).id, `episode[${index}].id`),
    ),
  );
  const documentIds = new Set(
    data.documents.map((row, index) =>
      id(record(row, `document[${index}]`).id, `document[${index}].id`),
    ),
  );
  for (const [index, row] of data.documentHeads.entries()) {
    const head = record(row, `documentHead[${index}]`);
    const documentId = id(head.documentId, `documentHead[${index}].documentId`);
    if (!documentIds.has(documentId)) {
      throw new TypeError(
        `snapshot documentHead[${index}] must reference an imported document`,
      );
    }
    const document = data.documents.find(
      (candidate) => candidate.id === documentId,
    );
    if (document?.sourceKey !== head.sourceKey) {
      throw new TypeError(
        `snapshot documentHead[${index}] sourceKey must match its document`,
      );
    }
  }
  for (const [index, row] of data.documentChunks.entries()) {
    const chunk = record(row, `documentChunk[${index}]`);
    const documentId = id(
      chunk.documentId,
      `documentChunk[${index}].documentId`,
    );
    if (!documentIds.has(documentId)) {
      throw new TypeError(
        `snapshot documentChunk[${index}] must reference an imported document`,
      );
    }
    const document = data.documents.find(
      (candidate) => candidate.id === documentId,
    );
    if (document?.sourceKey !== chunk.sourceKey) {
      throw new TypeError(
        `snapshot documentChunk[${index}] sourceKey must match its document`,
      );
    }
  }
  for (const [index, row] of data.associations.entries()) {
    const association = record(row, `association[${index}]`);
    if (
      !memoryIds.has(
        id(association.sourceId, `association[${index}].sourceId`),
      ) ||
      !memoryIds.has(id(association.targetId, `association[${index}].targetId`))
    ) {
      throw new TypeError(
        `snapshot association[${index}] must reference imported memories`,
      );
    }
  }
  for (const [index, row] of data.history.entries()) {
    const history = record(row, `history[${index}]`);
    if (!memoryIds.has(id(history.memoryId, `history[${index}].memoryId`))) {
      throw new TypeError(
        `snapshot history[${index}] must reference an imported memory`,
      );
    }
  }
  for (const [index, row] of data.memoryEntities.entries()) {
    const mention = record(row, `memoryEntities[${index}]`);
    if (
      !memoryIds.has(
        id(mention.memoryId, `memoryEntities[${index}].memoryId`),
      ) ||
      !entityIds.has(id(mention.entityId, `memoryEntities[${index}].entityId`))
    ) {
      throw new TypeError(
        `snapshot memoryEntities[${index}] must reference imported rows`,
      );
    }
  }
  return {
    memories: data.memories.map((row, index) => {
      const memory = namespaced(
        record(row, `memory[${index}]`) as unknown as SnapshotMemory,
        `memory[${index}]`,
      );
      if (
        memory.episodeId !== undefined &&
        !episodeIds.has(id(memory.episodeId, `memory[${index}].episodeId`))
      ) {
        throw new TypeError(
          `snapshot memory[${index}].episodeId must reference an imported episode`,
        );
      }
      if (
        memory.supersededBy !== undefined &&
        !memoryIds.has(id(memory.supersededBy, `memory[${index}].supersededBy`))
      ) {
        throw new TypeError(
          `snapshot memory[${index}].supersededBy must reference an imported memory`,
        );
      }
      return {
        ...memory,
        projectionHints: projectionHints(
          memory.projectionHints,
          `memory[${index}].projectionHints`,
        ),
        createdAt: date(memory.createdAt, "memory.createdAt"),
        updatedAt: date(memory.updatedAt, "memory.updatedAt"),
        lastAccessedAt: date(memory.lastAccessedAt, "memory.lastAccessedAt"),
        demotedAt: optionalDate(memory.demotedAt, "memory.demotedAt"),
        eventDate: optionalDate(memory.eventDate, "memory.eventDate"),
        validFrom: optionalDate(memory.validFrom, "memory.validFrom"),
        validTo: optionalDate(memory.validTo, "memory.validTo"),
      };
    }) as Memory[],
    documents: data.documents.map((row, index) => {
      const document = namespaced(
        record(row, `document[${index}]`) as unknown as SnapshotDocument,
        `document[${index}]`,
      );
      return {
        ...document,
        createdAt: date(document.createdAt, "document.createdAt"),
      };
    }) as DocumentSource[],
    documentHeads: data.documentHeads.map((row, index) => {
      const head = namespaced(
        record(
          row,
          `documentHead[${index}]`,
        ) as unknown as SnapshotDocumentHead,
        `documentHead[${index}]`,
      );
      return {
        ...head,
        updatedAt: date(head.updatedAt, "documentHead.updatedAt"),
      };
    }) as DocumentHead[],
    documentChunks: data.documentChunks.map((row, index) => {
      const chunk = namespaced(
        record(
          row,
          `documentChunk[${index}]`,
        ) as unknown as SnapshotDocumentChunk,
        `documentChunk[${index}]`,
      );
      return {
        ...chunk,
        createdAt: date(chunk.createdAt, "documentChunk.createdAt"),
      };
    }) as DocumentChunk[],
    associations: data.associations.map((row) => ({
      ...row,
      createdAt: date(row.createdAt, "association.createdAt"),
    })) as Association[],
    history: data.history.map((row) => ({
      ...row,
      createdAt: date(row.createdAt, "history.createdAt"),
    })) as HistoryEntry[],
    entities: data.entities.map((row, index) => {
      const entity = namespaced(
        record(row, `entity[${index}]`) as unknown as SnapshotEntity,
        `entity[${index}]`,
      );
      return {
        ...entity,
        createdAt: date(entity.createdAt, "entity.createdAt"),
      };
    }) as Entity[],
    memoryEntities: data.memoryEntities.map((row) => ({ ...row })),
    episodes: data.episodes.map((row, index) => {
      const episode = namespaced(
        record(row, `episode[${index}]`) as unknown as SnapshotEpisode,
        `episode[${index}]`,
      );
      return {
        ...episode,
        createdAt: date(episode.createdAt, "episode.createdAt"),
      };
    }) as Episode[],
    operations: data.operations.map((row, index) => {
      const operation = namespaced(
        record(row, `operation[${index}]`) as unknown as SnapshotOperation,
        `operation[${index}]`,
      );
      for (const memoryId of operation.memoryIds) {
        if (!memoryIds.has(id(memoryId, `operation[${index}].memoryIds`))) {
          throw new TypeError(
            `snapshot operation[${index}] must reference imported memories`,
          );
        }
      }
      return {
        ...operation,
        createdAt: date(operation.createdAt, "operation.createdAt"),
        updatedAt: date(operation.updatedAt, "operation.updatedAt"),
        leaseExpiresAt: optionalDate(
          operation.leaseExpiresAt,
          "operation.leaseExpiresAt",
        ),
      };
    }) as MemoryOperation[],
    events: data.events.map((row, index) => {
      const event = namespaced(
        record(row, `event[${index}]`) as unknown as SnapshotJournalEvent,
        `event[${index}]`,
      );
      if (!memoryIds.has(id(event.memoryId, `event[${index}].memoryId`))) {
        throw new TypeError(
          `snapshot event[${index}] must reference an imported memory`,
        );
      }
      return {
        ...event,
        occurredAt: date(event.occurredAt, "event.occurredAt"),
      };
    }) as MemoryJournalEvent[],
  };
}
