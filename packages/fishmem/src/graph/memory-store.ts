import { matchesMemoryFilter } from "../core/filter.js";
import type {
  MemoryJournalEvent,
  MemoryOperation,
  OperationClaim,
  OperationSummary,
  ProjectionStatus,
} from "../core/journal.js";
import { uuid } from "../core/util.js";
import type {
  Association,
  DocumentChunk,
  DocumentFilters,
  DocumentHead,
  DocumentSource,
  Entity,
  Episode,
  HistoryEntry,
  Memory,
  MemoryEvent,
  MemoryFilters,
  ScopeEntity,
  ScopeEntityType,
} from "../types.js";
import type {
  GraphSnapshotData,
  GraphStore,
  ListOptions,
  ScopeEntityCursor,
  ScopeEntityListOptions,
} from "./base.js";

/**
 * Pure in-memory graph store. Implements the full `GraphStore` contract and is
 * the canonical reference for the semantics every Drizzle adapter must match
 * (BFS neighbourhoods, atomic merge with edge rewiring, scoped listing).
 *
 * Mirrors spacebot's `store.rs`.
 */
export class InMemoryGraphStore implements GraphStore {
  private memories = new Map<string, Memory>();
  private associations = new Map<string, Association>();
  private history: HistoryEntry[] = [];
  private entities = new Map<string, Entity>();
  /** memoryId → Set<entityId> */
  private mentions = new Map<string, Set<string>>();
  private episodes = new Map<string, Episode>();
  private documents = new Map<string, DocumentSource>();
  private documentHeads = new Map<string, DocumentHead>();
  private documentChunks = new Map<string, DocumentChunk>();
  private operations = new Map<string, MemoryOperation>();
  private operationKeys = new Map<string, string>();
  private events = new Map<string, MemoryJournalEvent>();

  async init(): Promise<void> {}
  async close(): Promise<void> {}

  async saveMemory(memory: Memory): Promise<void> {
    this.memories.set(memory.id, clone(memory));
  }

  async getMemory(id: string): Promise<Memory | null> {
    const m = this.memories.get(id);
    return m ? clone(m) : null;
  }

  async updateMemory(memory: Memory): Promise<void> {
    this.memories.set(memory.id, clone(memory));
  }

  async deleteMemory(id: string): Promise<void> {
    this.memories.delete(id);
    await this.deleteAssociationsForMemory(id);
    this.history = this.history.filter((entry) => entry.memoryId !== id);
    this.mentions.delete(id);
  }

  async deleteMemories(ids: string[]): Promise<void> {
    for (const id of new Set(ids)) await this.deleteMemory(id);
  }

  async recordAccess(id: string): Promise<void> {
    const m = this.memories.get(id);
    if (!m) return;
    m.lastAccessedAt = new Date();
    m.accessCount += 1;
  }

  async forget(id: string): Promise<boolean> {
    const m = this.memories.get(id);
    if (!m || m.forgotten) return false;
    m.forgotten = true;
    m.updatedAt = new Date();
    return true;
  }

  async listMemories(
    filters: MemoryFilters,
    options: ListOptions = {},
  ): Promise<Memory[]> {
    const sort = options.sort ?? "recent";
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;
    let rows = [...this.memories.values()].filter(
      (m) => !m.forgotten && matchesScope(m, filters),
    );
    rows = sortMemories(rows, sort);
    if (options.cursor) {
      const cursor = options.cursor;
      rows = rows.filter(
        (memory) =>
          memory.createdAt.getTime() < cursor.createdAt.getTime() ||
          (memory.createdAt.getTime() === cursor.createdAt.getTime() &&
            memory.id < cursor.id),
      );
    }
    return rows.slice(offset, offset + limit).map(clone);
  }

  async countMemories(filters: MemoryFilters): Promise<number> {
    return [...this.memories.values()].filter(
      (m) => !m.forgotten && matchesScope(m, filters),
    ).length;
  }

  async listScopeEntities(
    namespaceId: string,
    options: ScopeEntityListOptions = {},
  ): Promise<ScopeEntity[]> {
    const entities = new Map<string, ScopeEntity>();
    const add = (memory: Memory, type: ScopeEntityType, id?: string) => {
      if (!id || (options.type && options.type !== type)) return;
      if (options.id && options.id !== id) return;
      const key = `${type}\0${id}`;
      const current = entities.get(key);
      if (!current) {
        entities.set(key, {
          id,
          type,
          totalMemories: 1,
          createdAt: new Date(memory.createdAt),
          updatedAt: new Date(memory.updatedAt),
        });
        return;
      }
      current.totalMemories += 1;
      if (memory.createdAt.getTime() < current.createdAt.getTime()) {
        current.createdAt = new Date(memory.createdAt);
      }
      if (memory.updatedAt.getTime() > current.updatedAt.getTime()) {
        current.updatedAt = new Date(memory.updatedAt);
      }
    };
    for (const memory of this.memories.values()) {
      if (memory.forgotten || memory.namespaceId !== namespaceId) continue;
      add(memory, "user", memory.userId);
      add(memory, "agent", memory.agentId);
      add(memory, "run", memory.runId);
    }
    const rows = [...entities.values()].sort(compareScopeEntities);
    const after = options.cursor
      ? rows.filter((entity) => isScopeEntityAfter(entity, options.cursor!))
      : rows;
    return after.slice(0, options.limit ?? 100).map((entity) => ({
      ...entity,
      createdAt: new Date(entity.createdAt),
      updatedAt: new Date(entity.updatedAt),
    }));
  }

  async getHighImportance(
    threshold: number,
    limit: number,
    filters: MemoryFilters,
  ): Promise<Memory[]> {
    return [...this.memories.values()]
      .filter(
        (m) =>
          !m.forgotten && m.importance >= threshold && matchesScope(m, filters),
      )
      .sort(
        (a, b) =>
          b.importance - a.importance ||
          b.updatedAt.getTime() - a.updatedAt.getTime(),
      )
      .slice(0, limit)
      .map(clone);
  }

  async createAssociation(association: Association): Promise<void> {
    // Enforce UNIQUE(source_id, target_id, relation_type) like spacebot.
    for (const existing of this.associations.values()) {
      if (
        existing.sourceId === association.sourceId &&
        existing.targetId === association.targetId &&
        existing.relationType === association.relationType
      ) {
        existing.weight = association.weight;
        return;
      }
    }
    this.associations.set(association.id, { ...association });
  }

  async getAssociations(memoryId: string): Promise<Association[]> {
    return [...this.associations.values()]
      .filter((a) => a.sourceId === memoryId || a.targetId === memoryId)
      .map((a) => ({ ...a }));
  }

  async getAssociationsBetween(memoryIds: string[]): Promise<Association[]> {
    const set = new Set(memoryIds);
    return [...this.associations.values()]
      .filter((a) => set.has(a.sourceId) && set.has(a.targetId))
      .map((a) => ({ ...a }));
  }

  async deleteAssociationsForMemory(memoryId: string): Promise<number> {
    let n = 0;
    for (const [id, a] of this.associations) {
      if (a.sourceId === memoryId || a.targetId === memoryId) {
        this.associations.delete(id);
        n++;
      }
    }
    return n;
  }

  async getNeighbors(
    memoryId: string,
    depth: number,
    excludeIds: string[],
  ): Promise<{ nodes: Memory[]; edges: Association[] }> {
    const visited = new Set<string>(excludeIds);
    visited.add(memoryId);
    const edges: Association[] = [];
    let frontier = [memoryId];

    for (let d = 0; d < depth; d++) {
      if (frontier.length === 0) break;
      const next: string[] = [];
      for (const node of frontier) {
        const assocs = await this.getAssociations(node);
        for (const a of assocs) {
          const neighbor = a.sourceId === node ? a.targetId : a.sourceId;
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            next.push(neighbor);
          }
          edges.push(a);
        }
      }
      frontier = next;
    }

    // Dedup edges by id.
    const seen = new Set<string>();
    const dedupedEdges = edges.filter((e) => {
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    });

    const excludeSet = new Set(excludeIds);
    excludeSet.add(memoryId); // the seed is not its own neighbour
    const nodes: Memory[] = [];
    for (const id of visited) {
      if (excludeSet.has(id)) continue;
      const m = this.memories.get(id);
      if (m && !m.forgotten) nodes.push(clone(m));
    }
    return { nodes, edges: dedupedEdges };
  }

  // ── Entities & mentions ─────────────────────────────────────────────────────
  async saveEntity(entity: Entity): Promise<void> {
    this.entities.set(entity.id, {
      ...entity,
      embedding: entity.embedding ? [...entity.embedding] : undefined,
    });
  }

  async updateEntity(entity: Entity): Promise<void> {
    await this.saveEntity(entity);
  }

  async listEntities(
    filters: MemoryFilters,
    limit = 10_000,
  ): Promise<Entity[]> {
    return [...this.entities.values()]
      .filter((e) => matchesEntityScope(e, filters))
      .slice(0, limit)
      .map((e) => ({
        ...e,
        embedding: e.embedding ? [...e.embedding] : undefined,
      }));
  }

  async linkMemoryEntities(
    memoryId: string,
    entityIds: string[],
  ): Promise<void> {
    const set = this.mentions.get(memoryId) ?? new Set<string>();
    for (const id of entityIds) set.add(id);
    this.mentions.set(memoryId, set);
  }

  async getEntityIdsForMemories(
    memoryIds: string[],
  ): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    for (const id of memoryIds) {
      const set = this.mentions.get(id);
      if (set?.size) out.set(id, [...set]);
    }
    return out;
  }

  async getMemoryIdsForEntities(
    entityIds: string[],
  ): Promise<Map<string, string[]>> {
    const want = new Set(entityIds);
    const out = new Map<string, string[]>();
    for (const [memoryId, set] of this.mentions) {
      for (const entityId of set) {
        if (!want.has(entityId)) continue;
        const list = out.get(entityId) ?? [];
        list.push(memoryId);
        out.set(entityId, list);
      }
    }
    return out;
  }

  // ── Episodes ───────────────────────────────────────────────────────────────
  async saveEpisode(episode: Episode): Promise<void> {
    this.episodes.set(episode.id, {
      ...episode,
      messages: episode.messages.map((m) => ({ ...m })),
    });
  }

  async getEpisode(id: string): Promise<Episode | null> {
    const e = this.episodes.get(id);
    return e ? { ...e, messages: e.messages.map((m) => ({ ...m })) } : null;
  }

  async listEpisodes(
    filters: MemoryFilters,
    options: ListOptions = {},
  ): Promise<Episode[]> {
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;
    return [...this.episodes.values()]
      .filter((e) => matchesEntityScope(e, filters))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(offset, offset + limit)
      .map((e) => ({ ...e, messages: e.messages.map((m) => ({ ...m })) }));
  }

  async mergeMemoriesAtomic(survivor: Memory, merged: Memory): Promise<void> {
    // 1. Update survivor.
    this.memories.set(survivor.id, clone(survivor));

    // 2. Rewire merged's edges onto survivor (skip self-loops, dedupe).
    for (const a of [...this.associations.values()]) {
      if (a.sourceId !== merged.id && a.targetId !== merged.id) continue;
      const newSource = a.sourceId === merged.id ? survivor.id : a.sourceId;
      const newTarget = a.targetId === merged.id ? survivor.id : a.targetId;
      this.associations.delete(a.id);
      if (newSource === newTarget) continue;
      await this.createAssociation({
        id: uuid(),
        sourceId: newSource,
        targetId: newTarget,
        relationType: a.relationType,
        weight: a.weight,
        createdAt: a.createdAt,
      });
    }

    // 3. Record survivor --updates--> merged.
    await this.createAssociation({
      id: uuid(),
      sourceId: survivor.id,
      targetId: merged.id,
      relationType: "updates",
      weight: 1.0,
      createdAt: new Date(),
    });

    // 3.5 Rewire entity mentions onto the survivor.
    const mergedMentions = this.mentions.get(merged.id);
    if (mergedMentions) {
      await this.linkMemoryEntities(survivor.id, [...mergedMentions]);
      this.mentions.delete(merged.id);
    }

    // 4. Forget merged.
    const m = this.memories.get(merged.id);
    if (m && !m.forgotten) {
      m.forgotten = true;
      m.updatedAt = new Date();
    }
  }

  async addHistory(entry: {
    id?: string;
    memoryId: string;
    event: MemoryEvent;
    previousValue: string | null;
    newValue: string | null;
    createdAt?: Date;
  }): Promise<void> {
    const id = entry.id ?? uuid();
    if (this.history.some((history) => history.id === id)) return;
    this.history.push({
      id,
      memoryId: entry.memoryId,
      event: entry.event,
      previousValue: entry.previousValue,
      newValue: entry.newValue,
      createdAt: entry.createdAt ?? new Date(),
    });
  }

  async getHistory(memoryId: string): Promise<HistoryEntry[]> {
    return this.history
      .filter((h) => h.memoryId === memoryId)
      .map((h) => ({ ...h }))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async exportNamespace(namespaceId: string): Promise<GraphSnapshotData> {
    const memories = [...this.memories.values()]
      .filter((memory) => memory.namespaceId === namespaceId)
      .map(clone);
    const memoryIds = new Set(memories.map((memory) => memory.id));
    const entities = [...this.entities.values()]
      .filter((entity) => entity.namespaceId === namespaceId)
      .map((entity) => ({
        ...entity,
        embedding: entity.embedding ? [...entity.embedding] : undefined,
      }));
    const entityIds = new Set(entities.map((entity) => entity.id));
    const memoryEntities: GraphSnapshotData["memoryEntities"] = [];
    for (const [memoryId, mentions] of this.mentions) {
      if (!memoryIds.has(memoryId)) continue;
      for (const entityId of mentions) {
        if (entityIds.has(entityId))
          memoryEntities.push({ memoryId, entityId });
      }
    }
    return {
      memories,
      documents: [...this.documents.values()]
        .filter((document) => document.namespaceId === namespaceId)
        .map(cloneDocumentSource),
      documentHeads: [...this.documentHeads.values()]
        .filter((head) => head.namespaceId === namespaceId)
        .map(cloneDocumentHead),
      documentChunks: [...this.documentChunks.values()]
        .filter((chunk) => chunk.namespaceId === namespaceId)
        .map(cloneDocumentChunk),
      associations: [...this.associations.values()]
        .filter(
          (association) =>
            memoryIds.has(association.sourceId) &&
            memoryIds.has(association.targetId),
        )
        .map((association) => ({ ...association })),
      history: this.history
        .filter((entry) => memoryIds.has(entry.memoryId))
        .map((entry) => ({ ...entry, createdAt: new Date(entry.createdAt) })),
      entities,
      memoryEntities,
      episodes: [...this.episodes.values()]
        .filter((episode) => episode.namespaceId === namespaceId)
        .map((episode) => ({
          ...episode,
          createdAt: new Date(episode.createdAt),
          messages: episode.messages.map((message) => ({ ...message })),
        })),
      operations: [...this.operations.values()]
        .filter((operation) => operation.namespaceId === namespaceId)
        .map(cloneOperation),
      events: [...this.events.values()]
        .filter((event) => event.namespaceId === namespaceId)
        .map(cloneEvent),
    };
  }

  async stageNamespaceImport(
    stagingNamespaceId: string,
    data: GraphSnapshotData,
  ): Promise<void> {
    const assertAvailable = <T extends { id: string }>(
      map: Map<string, T>,
      row: T,
      label: string,
    ) => {
      const existing = map.get(row.id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(row)) {
        throw new Error(`snapshot ${label} id collision: ${row.id}`);
      }
    };
    const memories = data.memories.map((row) => ({
      ...clone(row),
      namespaceId: stagingNamespaceId,
    }));
    const entities = data.entities.map((row) => ({
      ...structuredClone(row),
      namespaceId: stagingNamespaceId,
    }));
    const episodes = data.episodes.map((row) => ({
      ...structuredClone(row),
      namespaceId: stagingNamespaceId,
    }));
    const documents = data.documents.map((row) => ({
      ...cloneDocumentSource(row),
      namespaceId: stagingNamespaceId,
    }));
    const documentHeads = data.documentHeads.map((row) => ({
      ...cloneDocumentHead(row),
      namespaceId: stagingNamespaceId,
    }));
    const documentChunks = data.documentChunks.map((row) => ({
      ...cloneDocumentChunk(row),
      namespaceId: stagingNamespaceId,
    }));
    const operations = data.operations.map((row) => ({
      ...cloneOperation(row),
      namespaceId: stagingNamespaceId,
    }));
    const events = data.events.map((row) => ({
      ...cloneEvent(row),
      namespaceId: stagingNamespaceId,
    }));
    for (const row of memories) assertAvailable(this.memories, row, "memory");
    for (const row of entities) assertAvailable(this.entities, row, "entity");
    for (const row of episodes) assertAvailable(this.episodes, row, "episode");
    for (const row of documents) {
      assertAvailable(this.documents, row, "document");
    }
    for (const row of documentHeads) {
      assertAvailable(this.documentHeads, row, "document head");
    }
    for (const row of documentChunks) {
      assertAvailable(this.documentChunks, row, "document chunk");
    }
    for (const row of operations) {
      assertAvailable(this.operations, row, "operation");
    }
    for (const row of events) assertAvailable(this.events, row, "event");
    for (const row of data.associations) {
      assertAvailable(this.associations, row, "association");
    }
    for (const row of memories) this.memories.set(row.id, row);
    for (const row of entities) this.entities.set(row.id, row);
    for (const row of episodes) this.episodes.set(row.id, row);
    for (const row of documents) this.documents.set(row.id, row);
    for (const row of documentHeads) this.documentHeads.set(row.id, row);
    for (const row of documentChunks) this.documentChunks.set(row.id, row);
    for (const row of data.associations) {
      this.associations.set(row.id, structuredClone(row));
    }
    for (const row of data.history) {
      if (!this.history.some((entry) => entry.id === row.id)) {
        this.history.push(structuredClone(row));
      }
    }
    for (const row of data.memoryEntities) {
      const mentions = this.mentions.get(row.memoryId) ?? new Set<string>();
      mentions.add(row.entityId);
      this.mentions.set(row.memoryId, mentions);
    }
    for (const row of operations) {
      this.operations.set(row.id, row);
      this.operationKeys.set(
        `${stagingNamespaceId}\0${row.idempotencyKey}`,
        row.id,
      );
    }
    for (const row of events) this.events.set(row.id, row);
  }

  async commitNamespaceImport(
    stagingNamespaceId: string,
    targetNamespaceId: string,
  ): Promise<void> {
    for (const memory of this.memories.values()) {
      if (memory.namespaceId === stagingNamespaceId) {
        memory.namespaceId = targetNamespaceId;
      }
    }
    for (const entity of this.entities.values()) {
      if (entity.namespaceId === stagingNamespaceId) {
        entity.namespaceId = targetNamespaceId;
      }
    }
    for (const episode of this.episodes.values()) {
      if (episode.namespaceId === stagingNamespaceId) {
        episode.namespaceId = targetNamespaceId;
      }
    }
    for (const document of this.documents.values()) {
      if (document.namespaceId === stagingNamespaceId) {
        document.namespaceId = targetNamespaceId;
      }
    }
    for (const head of this.documentHeads.values()) {
      if (head.namespaceId === stagingNamespaceId) {
        head.namespaceId = targetNamespaceId;
      }
    }
    for (const chunk of this.documentChunks.values()) {
      if (chunk.namespaceId === stagingNamespaceId) {
        chunk.namespaceId = targetNamespaceId;
      }
    }
    for (const operation of this.operations.values()) {
      if (operation.namespaceId !== stagingNamespaceId) continue;
      this.operationKeys.delete(
        `${stagingNamespaceId}\0${operation.idempotencyKey}`,
      );
      operation.namespaceId = targetNamespaceId;
      this.operationKeys.set(
        `${targetNamespaceId}\0${operation.idempotencyKey}`,
        operation.id,
      );
    }
    for (const event of this.events.values()) {
      if (event.namespaceId === stagingNamespaceId) {
        event.namespaceId = targetNamespaceId;
      }
    }
  }

  async commitDocumentVersion(
    source: DocumentSource,
    chunks: DocumentChunk[],
    head: DocumentHead,
  ): Promise<void> {
    if (
      head.namespaceId !== source.namespaceId ||
      head.sourceKey !== source.sourceKey ||
      head.documentId !== source.id
    ) {
      throw new Error("document head does not match source version");
    }
    const existing = this.documents.get(source.id);
    if (
      existing &&
      JSON.stringify(cloneDocumentSource(existing)) !==
        JSON.stringify(cloneDocumentSource(source))
    ) {
      throw new Error(`document id collision: ${source.id}`);
    }
    for (const chunk of chunks) {
      if (
        chunk.documentId !== source.id ||
        chunk.namespaceId !== source.namespaceId ||
        chunk.sourceKey !== source.sourceKey
      ) {
        throw new Error(`document chunk does not match source: ${chunk.id}`);
      }
      const stored = this.documentChunks.get(chunk.id);
      if (
        stored &&
        JSON.stringify(cloneDocumentChunk(stored)) !==
          JSON.stringify(cloneDocumentChunk(chunk))
      ) {
        throw new Error(`document chunk id collision: ${chunk.id}`);
      }
    }
    this.documents.set(source.id, cloneDocumentSource(source));
    for (const chunk of chunks) {
      this.documentChunks.set(chunk.id, cloneDocumentChunk(chunk));
    }
    const conflictingHead = [...this.documentHeads.values()].find(
      (candidate) =>
        candidate.namespaceId === head.namespaceId &&
        candidate.sourceKey === head.sourceKey &&
        candidate.id !== head.id,
    );
    if (conflictingHead) this.documentHeads.delete(conflictingHead.id);
    const currentHead = this.documentHeads.get(head.id);
    if (
      !currentHead ||
      currentHead.updatedAt.getTime() <= head.updatedAt.getTime()
    ) {
      this.documentHeads.set(head.id, cloneDocumentHead(head));
    }
  }

  async getDocument(id: string): Promise<DocumentSource | null> {
    const source = this.documents.get(id);
    return source ? cloneDocumentSource(source) : null;
  }

  async getCurrentDocument(
    namespaceId: string,
    sourceKey: string,
  ): Promise<DocumentSource | null> {
    const head = [...this.documentHeads.values()].find(
      (candidate) =>
        candidate.namespaceId === namespaceId &&
        candidate.sourceKey === sourceKey,
    );
    if (!head) return null;
    return this.getDocument(head.documentId);
  }

  async listDocumentVersions(
    namespaceId: string,
    sourceKey: string,
  ): Promise<DocumentSource[]> {
    return [...this.documents.values()]
      .filter(
        (source) =>
          source.namespaceId === namespaceId && source.sourceKey === sourceKey,
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map(cloneDocumentSource);
  }

  async listCurrentDocuments(
    filters: DocumentFilters,
    options: ListOptions = {},
  ): Promise<DocumentSource[]> {
    const currentIds = new Set(
      [...this.documentHeads.values()]
        .filter(
          (head) =>
            head.namespaceId === filters.namespaceId &&
            (filters.sourceKey === undefined ||
              head.sourceKey === filters.sourceKey),
        )
        .map((head) => head.documentId),
    );
    let rows = [...this.documents.values()]
      .filter((source) => currentIds.has(source.id))
      .filter((source) => matchesDocumentScope(source, filters))
      .sort(
        (a, b) =>
          b.createdAt.getTime() - a.createdAt.getTime() ||
          b.id.localeCompare(a.id),
      );
    if (options.cursor) {
      rows = rows.filter(
        (row) =>
          row.createdAt < options.cursor!.createdAt ||
          (row.createdAt.getTime() === options.cursor!.createdAt.getTime() &&
            row.id < options.cursor!.id),
      );
    }
    const offset = Math.max(0, options.offset ?? 0);
    const limit = Math.max(0, options.limit ?? 100);
    return rows.slice(offset, offset + limit).map(cloneDocumentSource);
  }

  async getDocumentChunk(id: string): Promise<DocumentChunk | null> {
    const chunk = this.documentChunks.get(id);
    return chunk ? cloneDocumentChunk(chunk) : null;
  }

  async listDocumentChunks(documentId: string): Promise<DocumentChunk[]> {
    return [...this.documentChunks.values()]
      .filter((chunk) => chunk.documentId === documentId)
      .sort((a, b) => a.index - b.index)
      .map(cloneDocumentChunk);
  }

  async purgeDocument(documentId: string): Promise<{
    documentIds: string[];
    chunkIds: string[];
  }> {
    const addressed = this.documents.get(documentId);
    if (!addressed) return { documentIds: [], chunkIds: [] };
    const documentIds = [...this.documents.values()]
      .filter(
        (source) =>
          source.namespaceId === addressed.namespaceId &&
          source.sourceKey === addressed.sourceKey,
      )
      .map((source) => source.id);
    const ids = new Set(documentIds);
    const chunkIds = [...this.documentChunks.values()]
      .filter((chunk) => ids.has(chunk.documentId))
      .map((chunk) => chunk.id);
    for (const id of documentIds) this.documents.delete(id);
    for (const id of chunkIds) this.documentChunks.delete(id);
    for (const [id, head] of this.documentHeads) {
      if (
        head.namespaceId === addressed.namespaceId &&
        head.sourceKey === addressed.sourceKey
      ) {
        this.documentHeads.delete(id);
      }
    }
    return { documentIds, chunkIds };
  }

  async claimOperation(operation: MemoryOperation): Promise<OperationClaim> {
    const key = `${operation.namespaceId}\0${operation.idempotencyKey}`;
    const existingId = this.operationKeys.get(key);
    if (existingId) {
      const existing = this.operations.get(existingId)!;
      if (
        existing.status === "pending" &&
        (!existing.leaseExpiresAt ||
          existing.leaseExpiresAt.getTime() <= operation.createdAt.getTime())
      ) {
        existing.leaseExpiresAt = operation.leaseExpiresAt;
        existing.attempts += 1;
        existing.updatedAt = operation.createdAt;
        return { operation: cloneOperation(existing), claimed: true };
      }
      return {
        operation: cloneOperation(existing),
        claimed: false,
      };
    }
    this.operations.set(operation.id, cloneOperation(operation));
    this.operationKeys.set(key, operation.id);
    return { operation: cloneOperation(operation), claimed: true };
  }

  async planOperation(
    operationId: string,
    command: Record<string, unknown>,
    memoryIds: string[],
  ): Promise<MemoryOperation> {
    const operation = this.operations.get(operationId);
    if (!operation) throw new Error(`operation not found: ${operationId}`);
    if (operation.status !== "pending") {
      throw new Error(`operation is not pending: ${operationId}`);
    }
    operation.command = structuredClone(command);
    operation.memoryIds = [...memoryIds];
    operation.updatedAt = new Date();
    return cloneOperation(operation);
  }

  async getOperation(operationId: string): Promise<MemoryOperation | null> {
    const operation = this.operations.get(operationId);
    return operation ? cloneOperation(operation) : null;
  }

  async listOperations(
    namespaceId: string,
    limit = 100,
  ): Promise<MemoryOperation[]> {
    return [...this.operations.values()]
      .filter((operation) => operation.namespaceId === namespaceId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
      .map(cloneOperation);
  }

  async summarizeOperations(namespaceId: string): Promise<OperationSummary> {
    const summary: OperationSummary = {
      pending: 0,
      failed: 0,
      vectorPending: 0,
      derivedPending: 0,
    };
    for (const operation of this.operations.values()) {
      if (operation.namespaceId !== namespaceId) continue;
      if (operation.status === "pending") summary.pending++;
      if (operation.status === "failed") summary.failed++;
      if (operation.vectorStatus === "pending") summary.vectorPending++;
      if (operation.derivedStatus === "pending") summary.derivedPending++;
      const hasPendingWork =
        operation.status === "pending" ||
        operation.vectorStatus === "pending" ||
        operation.derivedStatus === "pending";
      if (
        hasPendingWork &&
        (!summary.oldestPendingAt ||
          operation.createdAt < summary.oldestPendingAt)
      ) {
        summary.oldestPendingAt = new Date(operation.createdAt);
      }
    }
    return summary;
  }

  async markProjectionReady(
    namespaceId: string,
    projection: "vector" | "derived",
  ): Promise<number> {
    let changed = 0;
    for (const operation of this.operations.values()) {
      if (operation.namespaceId !== namespaceId) continue;
      const key = projection === "vector" ? "vectorStatus" : "derivedStatus";
      if (operation[key] !== "pending") continue;
      operation[key] = "ready";
      operation.updatedAt = new Date();
      changed++;
    }
    return changed;
  }

  async retryOperation(
    operationId: string,
    leaseExpiresAt: Date,
  ): Promise<boolean> {
    const operation = this.operations.get(operationId);
    if (operation?.status !== "failed") return false;
    operation.status = "pending";
    operation.error = undefined;
    operation.leaseExpiresAt = leaseExpiresAt;
    operation.attempts += 1;
    operation.updatedAt = new Date();
    return true;
  }

  async completeOperation(
    operationId: string,
    result: unknown,
    projections: {
      raw: ProjectionStatus;
      vector: ProjectionStatus;
      derived: ProjectionStatus;
    },
    events: MemoryJournalEvent[],
  ): Promise<void> {
    const operation = this.operations.get(operationId);
    if (!operation) throw new Error(`operation not found: ${operationId}`);
    operation.status = "committed";
    operation.rawStatus = projections.raw;
    operation.vectorStatus = projections.vector;
    operation.derivedStatus = projections.derived;
    operation.result = structuredClone(result);
    operation.error = undefined;
    operation.leaseExpiresAt = undefined;
    operation.updatedAt = new Date();
    for (const event of events) this.events.set(event.id, cloneEvent(event));
  }

  async failOperation(
    operationId: string,
    error: string,
    projections?: {
      raw: ProjectionStatus;
      vector: ProjectionStatus;
      derived: ProjectionStatus;
    },
  ): Promise<void> {
    const operation = this.operations.get(operationId);
    if (!operation) throw new Error(`operation not found: ${operationId}`);
    operation.status = "failed";
    if (projections) {
      operation.rawStatus = projections.raw;
      operation.vectorStatus = projections.vector;
      operation.derivedStatus = projections.derived;
    }
    operation.error = error;
    operation.leaseExpiresAt = undefined;
    operation.updatedAt = new Date();
  }

  async listEvents(namespaceId: string): Promise<MemoryJournalEvent[]> {
    return [...this.events.values()]
      .filter((event) => event.namespaceId === namespaceId)
      .map(cloneEvent)
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  }

  async deleteAll(filters: MemoryFilters): Promise<string[]> {
    const ids = [...this.memories.values()]
      .filter((m) => !m.forgotten && matchesScope(m, filters))
      .map((m) => m.id);
    await this.deleteMemories(ids);
    return ids;
  }

  async purgeNamespace(namespaceId: string): Promise<string[]> {
    const memoryIds = new Set(
      [...this.memories.values()]
        .filter((memory) => memory.namespaceId === namespaceId)
        .map((memory) => memory.id),
    );
    const entityIds = new Set(
      [...this.entities.values()]
        .filter((entity) => entity.namespaceId === namespaceId)
        .map((entity) => entity.id),
    );
    for (const id of memoryIds) {
      this.memories.delete(id);
      this.mentions.delete(id);
    }
    for (const [id, association] of this.associations) {
      if (
        memoryIds.has(association.sourceId) ||
        memoryIds.has(association.targetId)
      ) {
        this.associations.delete(id);
      }
    }
    this.history = this.history.filter(
      (entry) => !memoryIds.has(entry.memoryId),
    );
    for (const id of entityIds) this.entities.delete(id);
    for (const mentions of this.mentions.values()) {
      for (const id of entityIds) mentions.delete(id);
    }
    for (const [id, episode] of this.episodes) {
      if (episode.namespaceId === namespaceId) this.episodes.delete(id);
    }
    const documentIds = new Set(
      [...this.documents.values()]
        .filter((document) => document.namespaceId === namespaceId)
        .map((document) => document.id),
    );
    for (const id of documentIds) this.documents.delete(id);
    for (const [id, head] of this.documentHeads) {
      if (head.namespaceId === namespaceId) this.documentHeads.delete(id);
    }
    for (const [id, chunk] of this.documentChunks) {
      if (chunk.namespaceId === namespaceId) this.documentChunks.delete(id);
    }
    for (const [id, operation] of this.operations) {
      if (operation.namespaceId !== namespaceId) continue;
      this.operations.delete(id);
      this.operationKeys.delete(`${namespaceId}\0${operation.idempotencyKey}`);
    }
    for (const [id, event] of this.events) {
      if (event.namespaceId === namespaceId) this.events.delete(id);
    }
    return [...memoryIds];
  }

  async reset(): Promise<void> {
    this.memories.clear();
    this.associations.clear();
    this.history = [];
    this.entities.clear();
    this.mentions.clear();
    this.episodes.clear();
    this.documents.clear();
    this.documentHeads.clear();
    this.documentChunks.clear();
    this.operations.clear();
    this.operationKeys.clear();
    this.events.clear();
  }
}

function cloneOperation(operation: MemoryOperation): MemoryOperation {
  return {
    ...operation,
    command: structuredClone(operation.command),
    memoryIds: [...operation.memoryIds],
    leaseExpiresAt: operation.leaseExpiresAt
      ? new Date(operation.leaseExpiresAt)
      : undefined,
    result: operation.result ? structuredClone(operation.result) : undefined,
    createdAt: new Date(operation.createdAt),
    updatedAt: new Date(operation.updatedAt),
  };
}

function cloneEvent(event: MemoryJournalEvent): MemoryJournalEvent {
  return {
    ...event,
    payload: structuredClone(event.payload),
    occurredAt: new Date(event.occurredAt),
  };
}

function clone(m: Memory): Memory {
  return {
    ...m,
    createdAt: new Date(m.createdAt),
    updatedAt: new Date(m.updatedAt),
    lastAccessedAt: new Date(m.lastAccessedAt),
    metadata: m.metadata ? { ...m.metadata } : undefined,
  };
}

function cloneDocumentSource(source: DocumentSource): DocumentSource {
  return {
    ...source,
    metadata: source.metadata ? structuredClone(source.metadata) : undefined,
    createdAt: new Date(source.createdAt),
  };
}

function cloneDocumentHead(head: DocumentHead): DocumentHead {
  return { ...head, updatedAt: new Date(head.updatedAt) };
}

function cloneDocumentChunk(chunk: DocumentChunk): DocumentChunk {
  return { ...chunk, createdAt: new Date(chunk.createdAt) };
}

function matchesDocumentScope(
  source: DocumentSource,
  filters: DocumentFilters,
) {
  return (
    source.namespaceId === filters.namespaceId &&
    (filters.userId === undefined || source.userId === filters.userId) &&
    (filters.agentId === undefined || source.agentId === filters.agentId) &&
    (filters.runId === undefined || source.runId === filters.runId) &&
    (filters.sourceKey === undefined || source.sourceKey === filters.sourceKey)
  );
}

export function matchesScope(m: Memory, filters?: MemoryFilters): boolean {
  if (!filters) return true;
  if (
    filters.namespaceId !== undefined &&
    m.namespaceId !== filters.namespaceId
  )
    return false;
  if (filters.userId !== undefined && m.userId !== filters.userId) return false;
  if (filters.agentId !== undefined && m.agentId !== filters.agentId)
    return false;
  if (filters.runId !== undefined && m.runId !== filters.runId) return false;
  if (filters.memoryType !== undefined && m.memoryType !== filters.memoryType)
    return false;
  if (filters.metadata) {
    const md = m.metadata ?? {};
    for (const [k, v] of Object.entries(filters.metadata)) {
      if (md[k] !== v) return false;
    }
  }
  if (
    filters.eventDateFrom !== undefined ||
    filters.eventDateTo !== undefined
  ) {
    if (!m.eventDate) return false;
    const t = m.eventDate.getTime();
    if (filters.eventDateFrom && t < filters.eventDateFrom.getTime())
      return false;
    if (filters.eventDateTo && t > filters.eventDateTo.getTime()) return false;
  }
  const createdAt = m.createdAt.getTime();
  if (filters.createdAtFrom && createdAt < filters.createdAtFrom.getTime()) {
    return false;
  }
  if (filters.createdAtTo && createdAt > filters.createdAtTo.getTime()) {
    return false;
  }
  const lastAccessedAt = m.lastAccessedAt.getTime();
  if (
    filters.lastAccessedAtFrom &&
    lastAccessedAt < filters.lastAccessedAtFrom.getTime()
  ) {
    return false;
  }
  if (
    filters.lastAccessedAtTo &&
    lastAccessedAt > filters.lastAccessedAtTo.getTime()
  ) {
    return false;
  }
  if (filters.accessed === true && m.accessCount === 0) return false;
  if (filters.accessed === false && m.accessCount > 0) return false;
  if (
    filters.subject !== undefined &&
    m.subject?.toLowerCase() !== filters.subject.toLowerCase()
  ) {
    return false;
  }
  if (
    filters.attribute !== undefined &&
    m.attribute?.toLowerCase() !== filters.attribute.toLowerCase()
  ) {
    return false;
  }
  return matchesMemoryFilter(m, filters.predicate);
}

export function sortMemories(rows: Memory[], sort: string): Memory[] {
  const copy = [...rows];
  switch (sort) {
    case "importance":
      copy.sort(
        (a, b) =>
          b.importance - a.importance ||
          b.createdAt.getTime() - a.createdAt.getTime(),
      );
      break;
    case "most_accessed":
      copy.sort(
        (a, b) =>
          b.accessCount - a.accessCount ||
          b.createdAt.getTime() - a.createdAt.getTime(),
      );
      break;
    case "last_accessed":
      copy.sort(
        (a, b) =>
          b.lastAccessedAt.getTime() - a.lastAccessedAt.getTime() ||
          b.createdAt.getTime() - a.createdAt.getTime(),
      );
      break;
    default:
      copy.sort(
        (a, b) =>
          b.createdAt.getTime() - a.createdAt.getTime() ||
          b.id.localeCompare(a.id),
      );
      break;
  }
  return copy;
}

const SCOPE_ENTITY_ORDER: Record<ScopeEntityType, number> = {
  user: 0,
  agent: 1,
  run: 2,
};

/** Stable newest-first order shared by every scope-entity adapter. */
export function compareScopeEntities(a: ScopeEntity, b: ScopeEntity): number {
  return (
    b.updatedAt.getTime() - a.updatedAt.getTime() ||
    SCOPE_ENTITY_ORDER[a.type] - SCOPE_ENTITY_ORDER[b.type] ||
    a.id.localeCompare(b.id)
  );
}

export function isScopeEntityAfter(
  entity: ScopeEntity,
  cursor: ScopeEntityCursor,
): boolean {
  const time = entity.updatedAt.getTime();
  const cursorTime = cursor.updatedAt.getTime();
  if (time !== cursorTime) return time < cursorTime;
  const typeOrder = SCOPE_ENTITY_ORDER[entity.type];
  const cursorTypeOrder = SCOPE_ENTITY_ORDER[cursor.type];
  if (typeOrder !== cursorTypeOrder) return typeOrder > cursorTypeOrder;
  return entity.id > cursor.id;
}

function matchesEntityScope(
  e: {
    namespaceId?: string;
    userId?: string;
    agentId?: string;
    runId?: string;
  },
  filters?: MemoryFilters,
): boolean {
  if (!filters) return true;
  if (
    filters.namespaceId !== undefined &&
    e.namespaceId !== filters.namespaceId
  )
    return false;
  if (filters.userId !== undefined && e.userId !== filters.userId) return false;
  if (filters.agentId !== undefined && e.agentId !== filters.agentId)
    return false;
  if (filters.runId !== undefined && e.runId !== filters.runId) return false;
  return true;
}
