import type { SQL } from "drizzle-orm";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
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
  MemoryType,
  RelationType,
  ScopeEntity,
  ScopeEntityType,
} from "../types.js";
import type {
  GraphSnapshotData,
  GraphStore,
  ListOptions,
  ScopeEntityListOptions,
} from "./base.js";
import {
  compareScopeEntities,
  matchesScope,
  sortMemories,
} from "./memory-store.js";

interface Tables {
  memories: any;
  associations: any;
  history: any;
  memoryOperations: any;
  memoryEvents: any;
  entities: any;
  memoryEntities: any;
  episodes: any;
  documents: any;
  documentHeads: any;
  documentChunks: any;
}

// D1 rejects statements with more than 100 bound parameters. Snapshot rows
// can be wide (operations currently bind 18 columns), so keep each insert
// below the platform limit instead of batching by row count alone.
const MAX_SNAPSHOT_INSERT_BOUND_PARAMETERS = 90;

export interface DrizzleGraphStoreOptions {
  /** A Drizzle database handle (node-postgres, libSQL, or D1). */
  db: any;
  /** Dialect-specific schema tables (pgSchema or sqliteSchema). */
  tables: Tables;
  /** Optional DDL bootstrap, run by `init()` (used for libSQL/dev). */
  migrate?: () => Promise<void>;
  /** Optional connection closer. */
  onClose?: () => Promise<void>;
  /** Optional dialect-native atomic document commit. D1 uses this to avoid
   * spending one subquery per chunk while preserving the shared validation and
   * GraphStore contract. */
  commitDocumentVersion?: (
    source: DocumentSource,
    chunks: DocumentChunk[],
    head: DocumentHead,
  ) => Promise<void>;
  /** Optional dialect-native exact bulk memory deletion. */
  deleteMemories?: (ids: string[]) => Promise<void>;
}

/**
 * Generic Drizzle-backed `GraphStore`. Because the pg and sqlite schemas use
 * matching column modes, a single implementation serves Postgres, SQLite
 * (libSQL/Turso), and Cloudflare D1 — only the `db` handle and schema differ.
 *
 * Semantics mirror `InMemoryGraphStore` (and spacebot's `store.rs`). Merge runs
 * as sequential statements rather than an interactive transaction so it is
 * compatible with D1, which has no interactive transactions.
 */
export class DrizzleGraphStore implements GraphStore {
  private readonly db: any;
  private readonly t: Tables;
  private readonly migrateFn?: () => Promise<void>;
  private readonly onClose?: () => Promise<void>;
  private readonly commitDocumentVersionFn?: DrizzleGraphStoreOptions["commitDocumentVersion"];
  private readonly deleteMemoriesFn?: DrizzleGraphStoreOptions["deleteMemories"];

  constructor(opts: DrizzleGraphStoreOptions) {
    this.db = opts.db;
    this.t = opts.tables;
    this.migrateFn = opts.migrate;
    this.onClose = opts.onClose;
    this.commitDocumentVersionFn = opts.commitDocumentVersion;
    this.deleteMemoriesFn = opts.deleteMemories;
  }

  async init(): Promise<void> {
    if (this.migrateFn) await this.migrateFn();
  }

  async close(): Promise<void> {
    if (this.onClose) await this.onClose();
  }

  async saveMemory(memory: Memory): Promise<void> {
    await this.db.insert(this.t.memories).values(memoryToRow(memory));
  }

  async getMemory(id: string): Promise<Memory | null> {
    const rows = await this.db
      .select()
      .from(this.t.memories)
      .where(eq(this.t.memories.id, id))
      .limit(1);
    return rows[0] ? rowToMemory(rows[0]) : null;
  }

  async updateMemory(memory: Memory): Promise<void> {
    const row = memoryToRow(memory);
    const { id, ...set } = row;
    await this.db
      .update(this.t.memories)
      .set(set)
      .where(eq(this.t.memories.id, memory.id));
  }

  async deleteMemory(id: string): Promise<void> {
    await this.deleteMemories([id]);
  }

  async deleteMemories(ids: string[]): Promise<void> {
    const unique = [...new Set(ids)];
    if (!unique.length) return;
    if (this.deleteMemoriesFn) {
      await this.deleteMemoriesFn(unique);
      return;
    }
    const writes = (db: any) =>
      chunkArray(unique, 400).flatMap((batch) => [
        db
          .delete(this.t.associations)
          .where(
            or(
              inArray(this.t.associations.sourceId, batch),
              inArray(this.t.associations.targetId, batch),
            ),
          ),
        db
          .delete(this.t.history)
          .where(inArray(this.t.history.memoryId, batch)),
        db
          .delete(this.t.memoryEntities)
          .where(inArray(this.t.memoryEntities.memoryId, batch)),
        db.delete(this.t.memories).where(inArray(this.t.memories.id, batch)),
      ]);
    if (typeof this.db.batch === "function") {
      await this.db.batch(writes(this.db));
      return;
    }
    if (typeof this.db.transaction === "function") {
      await this.db.transaction(async (transaction: any) => {
        for (const statement of writes(transaction)) await statement;
      });
      return;
    }
    throw new Error("graph adapter does not support atomic memory deletion");
  }

  async recordAccess(id: string): Promise<void> {
    await this.db
      .update(this.t.memories)
      .set({
        lastAccessedAt: new Date(),
        accessCount: sql`${this.t.memories.accessCount} + 1`,
      })
      .where(eq(this.t.memories.id, id));
  }

  async forget(id: string): Promise<boolean> {
    const m = await this.getMemory(id);
    if (!m || m.forgotten) return false;
    await this.db
      .update(this.t.memories)
      .set({ forgotten: true, updatedAt: new Date() })
      .where(eq(this.t.memories.id, id));
    return true;
  }

  async listMemories(
    filters: MemoryFilters,
    options: ListOptions = {},
  ): Promise<Memory[]> {
    const sortKey = options.sort ?? "recent";
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;
    const scopeWhere = this.scopeWhere(filters, false);
    const where = options.cursor
      ? and(
          scopeWhere,
          or(
            lt(this.t.memories.createdAt, options.cursor.createdAt),
            and(
              eq(this.t.memories.createdAt, options.cursor.createdAt),
              lt(this.t.memories.id, options.cursor.id),
            ),
          ),
        )
      : scopeWhere;

    if (filters.metadata || filters.predicate) {
      // Arbitrary metadata and the canonical predicate are applied in one
      // backend-independent evaluator after safe structural SQL pushdown.
      const rows = await this.db.select().from(this.t.memories).where(where);
      const mapped = rows
        .map(rowToMemory)
        .filter((memory: Memory) => matchesScope(memory, filters));
      return sortMemories(mapped, sortKey).slice(offset, offset + limit);
    }

    const rows = await this.db
      .select()
      .from(this.t.memories)
      .where(where)
      .orderBy(...this.orderBy(sortKey))
      .limit(limit)
      .offset(offset);
    return rows.map(rowToMemory);
  }

  async countMemories(filters: MemoryFilters): Promise<number> {
    if (filters.metadata || filters.predicate) {
      const all = await this.listMemories(filters, { limit: 1_000_000 });
      return all.length;
    }
    const rows = await this.db
      .select({ c: sql<number>`count(*)` })
      .from(this.t.memories)
      .where(this.scopeWhere(filters, false));
    return Number(rows[0]?.c ?? 0);
  }

  async listScopeEntities(
    namespaceId: string,
    options: ScopeEntityListOptions = {},
  ): Promise<ScopeEntity[]> {
    const types: ScopeEntityType[] = options.type
      ? [options.type]
      : ["user", "agent", "run"];
    const limit = options.limit ?? 100;
    const pages = await Promise.all(
      types.map((type) =>
        this.scopeEntityRows(type, namespaceId, options, limit),
      ),
    );
    return pages.flat().sort(compareScopeEntities).slice(0, limit);
  }

  async countScopeEntities(namespaceId: string): Promise<number> {
    const fields = [
      this.t.memories.userId,
      this.t.memories.agentId,
      this.t.memories.runId,
    ];
    const counts = await Promise.all(
      fields.map(async (field) => {
        const rows = await this.db
          .select({ c: sql<number>`count(distinct ${field})` })
          .from(this.t.memories)
          .where(
            and(
              eq(this.t.memories.namespaceId, namespaceId),
              eq(this.t.memories.forgotten, false),
              isNotNull(field),
              sql`${field} <> ''`,
            ),
          );
        return Number(rows[0]?.c ?? 0);
      }),
    );
    return counts.reduce((total, value) => total + value, 0);
  }

  private async scopeEntityRows(
    type: ScopeEntityType,
    namespaceId: string,
    options: ScopeEntityListOptions,
    limit: number,
  ): Promise<ScopeEntity[]> {
    const field =
      type === "user"
        ? this.t.memories.userId
        : type === "agent"
          ? this.t.memories.agentId
          : this.t.memories.runId;
    const createdAt = sql`min(${this.t.memories.createdAt})`;
    const updatedAt = sql`max(${this.t.memories.updatedAt})`;
    const where = and(
      eq(this.t.memories.namespaceId, namespaceId),
      eq(this.t.memories.forgotten, false),
      isNotNull(field),
      sql`${field} <> ''`,
      ...(options.id ? [eq(field, options.id)] : []),
    );
    const cursor = options.cursor;
    let afterCursor: SQL | undefined;
    if (cursor && !options.id) {
      const typeOrder: Record<ScopeEntityType, number> = {
        user: 0,
        agent: 1,
        run: 2,
      };
      const lowerTimestamp = lt(updatedAt, cursor.updatedAt);
      if (typeOrder[type] > typeOrder[cursor.type]) {
        afterCursor = or(lowerTimestamp, eq(updatedAt, cursor.updatedAt));
      } else if (type === cursor.type) {
        afterCursor = or(
          lowerTimestamp,
          and(eq(updatedAt, cursor.updatedAt), gt(field, cursor.id)),
        );
      } else {
        afterCursor = lowerTimestamp;
      }
    }
    const grouped = this.db
      .select({
        id: field,
        totalMemories: sql<number>`count(*)`,
        createdAt,
        updatedAt,
      })
      .from(this.t.memories)
      .where(where)
      .groupBy(field);
    const rows = await (afterCursor ? grouped.having(afterCursor) : grouped)
      .orderBy(desc(updatedAt), asc(field))
      .limit(limit);
    return rows.map((row: any) => ({
      id: String(row.id),
      type,
      totalMemories: Number(row.totalMemories),
      createdAt: toDate(row.createdAt),
      updatedAt: toDate(row.updatedAt),
    }));
  }

  async getHighImportance(
    threshold: number,
    limit: number,
    filters: MemoryFilters,
  ): Promise<Memory[]> {
    if (filters.metadata || filters.predicate) {
      const all = await this.listMemories(filters, {
        sort: "importance",
        limit: 1_000_000,
      });
      return all
        .filter((memory) => memory.importance >= threshold)
        .slice(0, limit);
    }
    const conds = [
      eq(this.t.memories.forgotten, false),
      sql`${this.t.memories.importance} >= ${threshold}`,
      ...this.scopeConds(filters),
    ];
    const rows = await this.db
      .select()
      .from(this.t.memories)
      .where(and(...conds))
      .orderBy(
        desc(this.t.memories.importance),
        desc(this.t.memories.updatedAt),
      )
      .limit(limit);
    return rows.map(rowToMemory);
  }

  async createAssociation(a: Association): Promise<void> {
    await this.db
      .insert(this.t.associations)
      .values({
        id: a.id,
        sourceId: a.sourceId,
        targetId: a.targetId,
        relationType: a.relationType,
        weight: a.weight,
        createdAt: a.createdAt,
      })
      .onConflictDoUpdate({
        target: [
          this.t.associations.sourceId,
          this.t.associations.targetId,
          this.t.associations.relationType,
        ],
        set: { weight: a.weight },
      });
  }

  async getAssociations(memoryId: string): Promise<Association[]> {
    const rows = await this.db
      .select()
      .from(this.t.associations)
      .where(
        or(
          eq(this.t.associations.sourceId, memoryId),
          eq(this.t.associations.targetId, memoryId),
        ),
      );
    return rows.map(rowToAssociation);
  }

  async getAssociationsBetween(memoryIds: string[]): Promise<Association[]> {
    if (memoryIds.length === 0) return [];
    const rows = await this.db
      .select()
      .from(this.t.associations)
      .where(
        and(
          inArray(this.t.associations.sourceId, memoryIds),
          inArray(this.t.associations.targetId, memoryIds),
        ),
      );
    return rows.map(rowToAssociation);
  }

  async deleteAssociationsForMemory(memoryId: string): Promise<number> {
    const existing = await this.getAssociations(memoryId);
    if (existing.length === 0) return 0;
    await this.db
      .delete(this.t.associations)
      .where(
        or(
          eq(this.t.associations.sourceId, memoryId),
          eq(this.t.associations.targetId, memoryId),
        ),
      );
    return existing.length;
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

    const seen = new Set<string>();
    const dedupedEdges = edges.filter((edge) => {
      if (seen.has(edge.id)) return false;
      seen.add(edge.id);
      return true;
    });

    const excludeSet = new Set(excludeIds);
    excludeSet.add(memoryId); // the seed is not its own neighbour
    const nodes: Memory[] = [];
    for (const id of visited) {
      if (excludeSet.has(id)) continue;
      const m = await this.getMemory(id);
      if (m && !m.forgotten) nodes.push(m);
    }
    return { nodes, edges: dedupedEdges };
  }

  // ── Entities & mentions ─────────────────────────────────────────────────────
  async saveEntity(entity: Entity): Promise<void> {
    await this.db.insert(this.t.entities).values(entityToRow(entity));
  }

  async updateEntity(entity: Entity): Promise<void> {
    await this.db
      .update(this.t.entities)
      .set(entityToRow(entity))
      .where(eq(this.t.entities.id, entity.id));
  }

  async listEntities(
    filters: MemoryFilters,
    limit = 10_000,
  ): Promise<Entity[]> {
    const conds: any[] = [];
    if (filters.namespaceId !== undefined)
      conds.push(eq(this.t.entities.namespaceId, filters.namespaceId));
    if (filters.userId !== undefined)
      conds.push(eq(this.t.entities.userId, filters.userId));
    if (filters.agentId !== undefined)
      conds.push(eq(this.t.entities.agentId, filters.agentId));
    if (filters.runId !== undefined)
      conds.push(eq(this.t.entities.runId, filters.runId));
    const rows = await this.db
      .select()
      .from(this.t.entities)
      .where(conds.length ? and(...conds) : undefined)
      .limit(limit);
    return rows.map(rowToEntity);
  }

  async linkMemoryEntities(
    memoryId: string,
    entityIds: string[],
  ): Promise<void> {
    for (const entityId of entityIds) {
      await this.db
        .insert(this.t.memoryEntities)
        .values({ memoryId, entityId })
        .onConflictDoNothing();
    }
  }

  async getEntityIdsForMemories(
    memoryIds: string[],
  ): Promise<Map<string, string[]>> {
    if (!memoryIds.length) return new Map();
    const rows = await this.db
      .select()
      .from(this.t.memoryEntities)
      .where(inArray(this.t.memoryEntities.memoryId, memoryIds));
    const out = new Map<string, string[]>();
    for (const r of rows) {
      const list = out.get(r.memoryId) ?? [];
      list.push(r.entityId);
      out.set(r.memoryId, list);
    }
    return out;
  }

  async getMemoryIdsForEntities(
    entityIds: string[],
  ): Promise<Map<string, string[]>> {
    if (!entityIds.length) return new Map();
    const rows = await this.db
      .select()
      .from(this.t.memoryEntities)
      .where(inArray(this.t.memoryEntities.entityId, entityIds));
    const out = new Map<string, string[]>();
    for (const r of rows) {
      const list = out.get(r.entityId) ?? [];
      list.push(r.memoryId);
      out.set(r.entityId, list);
    }
    return out;
  }

  // ── Episodes ───────────────────────────────────────────────────────────────
  async saveEpisode(episode: Episode): Promise<void> {
    await this.db.insert(this.t.episodes).values({
      id: episode.id,
      namespaceId: episode.namespaceId ?? null,
      userId: episode.userId ?? null,
      agentId: episode.agentId ?? null,
      runId: episode.runId ?? null,
      messages: episode.messages,
      source: episode.source ?? null,
      createdAt: episode.createdAt,
    });
  }

  async getEpisode(id: string): Promise<Episode | null> {
    const rows = await this.db
      .select()
      .from(this.t.episodes)
      .where(eq(this.t.episodes.id, id))
      .limit(1);
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id,
      namespaceId: r.namespaceId ?? undefined,
      userId: r.userId ?? undefined,
      agentId: r.agentId ?? undefined,
      runId: r.runId ?? undefined,
      messages: (r.messages ?? []) as Episode["messages"],
      source: r.source ?? undefined,
      createdAt: toDate(r.createdAt),
    };
  }

  async listEpisodes(
    filters: MemoryFilters,
    options: ListOptions = {},
  ): Promise<Episode[]> {
    const conds: any[] = [];
    if (filters.namespaceId !== undefined)
      conds.push(eq(this.t.episodes.namespaceId, filters.namespaceId));
    if (filters.userId !== undefined)
      conds.push(eq(this.t.episodes.userId, filters.userId));
    if (filters.agentId !== undefined)
      conds.push(eq(this.t.episodes.agentId, filters.agentId));
    if (filters.runId !== undefined)
      conds.push(eq(this.t.episodes.runId, filters.runId));
    const rows = await this.db
      .select()
      .from(this.t.episodes)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(this.t.episodes.createdAt))
      .limit(options.limit ?? 100)
      .offset(options.offset ?? 0);
    return rows.map((r: any) => ({
      id: r.id,
      namespaceId: r.namespaceId ?? undefined,
      userId: r.userId ?? undefined,
      agentId: r.agentId ?? undefined,
      runId: r.runId ?? undefined,
      messages: (r.messages ?? []) as Episode["messages"],
      source: r.source ?? undefined,
      createdAt: toDate(r.createdAt),
    }));
  }

  async deleteEpisodes(ids: string[]): Promise<void> {
    const unique = [...new Set(ids)];
    if (!unique.length) return;
    await this.db
      .delete(this.t.episodes)
      .where(inArray(this.t.episodes.id, unique));
  }

  async mergeMemoriesAtomic(survivor: Memory, merged: Memory): Promise<void> {
    // 1. Update survivor.
    await this.updateMemory(survivor);

    // 2. Rewire merged's edges onto survivor (skip self-loops, dedupe).
    const incident = await this.getAssociations(merged.id);
    await this.deleteAssociationsForMemory(merged.id);
    for (const a of incident) {
      const newSource = a.sourceId === merged.id ? survivor.id : a.sourceId;
      const newTarget = a.targetId === merged.id ? survivor.id : a.targetId;
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

    // 3. survivor --updates--> merged.
    await this.createAssociation({
      id: uuid(),
      sourceId: survivor.id,
      targetId: merged.id,
      relationType: "updates",
      weight: 1.0,
      createdAt: new Date(),
    });

    // 3.5 Rewire entity mentions onto the survivor.
    const mergedMentions = await this.getEntityIdsForMemories([merged.id]);
    const mentionIds = mergedMentions.get(merged.id) ?? [];
    if (mentionIds.length) {
      await this.linkMemoryEntities(survivor.id, mentionIds);
      await this.db
        .delete(this.t.memoryEntities)
        .where(eq(this.t.memoryEntities.memoryId, merged.id));
    }

    // 4. Forget merged.
    await this.db
      .update(this.t.memories)
      .set({ forgotten: true, updatedAt: new Date() })
      .where(eq(this.t.memories.id, merged.id));
  }

  async addHistory(entry: {
    id?: string;
    memoryId: string;
    event: MemoryEvent;
    previousValue: string | null;
    newValue: string | null;
    createdAt?: Date;
  }): Promise<void> {
    await this.db
      .insert(this.t.history)
      .values({
        id: entry.id ?? uuid(),
        memoryId: entry.memoryId,
        event: entry.event,
        previousValue: entry.previousValue,
        newValue: entry.newValue,
        createdAt: entry.createdAt ?? new Date(),
      })
      .onConflictDoNothing({ target: this.t.history.id });
  }

  async getHistory(memoryId: string): Promise<HistoryEntry[]> {
    const rows = await this.db
      .select()
      .from(this.t.history)
      .where(eq(this.t.history.memoryId, memoryId));
    return rows
      .map((r: any) => ({
        id: r.id,
        memoryId: r.memoryId,
        event: r.event as MemoryEvent,
        previousValue: r.previousValue ?? null,
        newValue: r.newValue ?? null,
        createdAt: toDate(r.createdAt),
      }))
      .sort(
        (a: HistoryEntry, b: HistoryEntry) =>
          a.createdAt.getTime() - b.createdAt.getTime(),
      );
  }

  async exportNamespace(namespaceId: string): Promise<GraphSnapshotData> {
    const memoryRows = await this.db
      .select()
      .from(this.t.memories)
      .where(this.scopeWhere({ namespaceId }, true));
    const memories = memoryRows.map(rowToMemory);
    const memoryIds = memories.map((memory: Memory) => memory.id);
    const entities = await this.listEntities({ namespaceId }, 1_000_000);
    const entityIds = entities.map((entity) => entity.id);
    const episodes = await this.listEpisodes(
      { namespaceId },
      { limit: 1_000_000 },
    );
    const [
      documentRows,
      documentHeadRows,
      documentChunkRows,
      operationRows,
      eventRows,
    ] = await Promise.all([
      this.db
        .select()
        .from(this.t.documents)
        .where(eq(this.t.documents.namespaceId, namespaceId)),
      this.db
        .select()
        .from(this.t.documentHeads)
        .where(eq(this.t.documentHeads.namespaceId, namespaceId)),
      this.db
        .select()
        .from(this.t.documentChunks)
        .where(eq(this.t.documentChunks.namespaceId, namespaceId)),
      this.db
        .select()
        .from(this.t.memoryOperations)
        .where(eq(this.t.memoryOperations.namespaceId, namespaceId)),
      this.db
        .select()
        .from(this.t.memoryEvents)
        .where(eq(this.t.memoryEvents.namespaceId, namespaceId)),
    ]);
    const operations = operationRows.map(rowToOperation);
    const events = eventRows.map(rowToJournalEvent);
    const documents = documentRows.map(rowToDocumentSource);
    const documentHeads = documentHeadRows.map(rowToDocumentHead);
    const documentChunks = documentChunkRows.map(rowToDocumentChunk);
    if (memoryIds.length === 0) {
      return {
        memories,
        documents,
        documentHeads,
        documentChunks,
        associations: [],
        history: [],
        entities,
        memoryEntities: [],
        episodes,
        operations,
        events,
      };
    }
    const [associations, historyRows, mentionRows] = await Promise.all([
      this.getAssociationsBetween(memoryIds),
      this.db
        .select()
        .from(this.t.history)
        .where(inArray(this.t.history.memoryId, memoryIds)),
      entityIds.length
        ? this.db
            .select()
            .from(this.t.memoryEntities)
            .where(
              and(
                inArray(this.t.memoryEntities.memoryId, memoryIds),
                inArray(this.t.memoryEntities.entityId, entityIds),
              ),
            )
        : [],
    ]);
    return {
      memories,
      documents,
      documentHeads,
      documentChunks,
      associations,
      history: historyRows.map(rowToHistory),
      entities,
      memoryEntities: mentionRows.map((row: any) => ({
        memoryId: row.memoryId,
        entityId: row.entityId,
      })),
      episodes,
      operations,
      events,
    };
  }

  async stageNamespaceImport(
    stagingNamespaceId: string,
    data: GraphSnapshotData,
  ): Promise<void> {
    const memories = data.memories.map((row) =>
      memoryToRow({ ...row, namespaceId: stagingNamespaceId }),
    );
    const entities = data.entities.map((row) =>
      entityToRow({ ...row, namespaceId: stagingNamespaceId }),
    );
    const episodes = data.episodes.map((row) => ({
      id: row.id,
      namespaceId: stagingNamespaceId,
      userId: row.userId ?? null,
      agentId: row.agentId ?? null,
      runId: row.runId ?? null,
      messages: row.messages,
      source: row.source ?? null,
      createdAt: row.createdAt,
    }));
    const documents = data.documents.map((row) =>
      documentSourceToRow({ ...row, namespaceId: stagingNamespaceId }),
    );
    const documentHeads = data.documentHeads.map((row) =>
      documentHeadToRow({ ...row, namespaceId: stagingNamespaceId }),
    );
    const documentChunks = data.documentChunks.map((row) =>
      documentChunkToRow({ ...row, namespaceId: stagingNamespaceId }),
    );
    const operations = data.operations.map((row) =>
      operationToRow({ ...row, namespaceId: stagingNamespaceId }),
    );
    const events = data.events.map((row) =>
      journalEventToRow({ ...row, namespaceId: stagingNamespaceId }),
    );
    await this.insertSnapshotRows(this.t.memories, memories);
    await this.insertSnapshotRows(this.t.entities, entities);
    await this.insertSnapshotRows(this.t.episodes, episodes);
    await this.insertSnapshotRows(this.t.documents, documents);
    await this.insertSnapshotRows(this.t.documentChunks, documentChunks);
    await this.insertSnapshotRows(this.t.documentHeads, documentHeads);
    await this.insertSnapshotRows(
      this.t.associations,
      data.associations.map((row) => ({
        id: row.id,
        sourceId: row.sourceId,
        targetId: row.targetId,
        relationType: row.relationType,
        weight: row.weight,
        createdAt: row.createdAt,
      })),
    );
    await this.insertSnapshotRows(
      this.t.history,
      data.history.map((row) => ({
        id: row.id,
        memoryId: row.memoryId,
        event: row.event,
        previousValue: row.previousValue,
        newValue: row.newValue,
        createdAt: row.createdAt,
      })),
    );
    await this.insertSnapshotRows(this.t.memoryEntities, data.memoryEntities);
    await this.insertSnapshotRows(this.t.memoryOperations, operations);
    await this.insertSnapshotRows(this.t.memoryEvents, events);
    const staged = await this.exportNamespace(stagingNamespaceId);
    assertSnapshotRows(data, staged);
  }

  async commitNamespaceImport(
    stagingNamespaceId: string,
    targetNamespaceId: string,
  ): Promise<void> {
    const updates = (db: any) => [
      db
        .update(this.t.memories)
        .set({ namespaceId: targetNamespaceId })
        .where(eq(this.t.memories.namespaceId, stagingNamespaceId)),
      db
        .update(this.t.entities)
        .set({ namespaceId: targetNamespaceId })
        .where(eq(this.t.entities.namespaceId, stagingNamespaceId)),
      db
        .update(this.t.episodes)
        .set({ namespaceId: targetNamespaceId })
        .where(eq(this.t.episodes.namespaceId, stagingNamespaceId)),
      db
        .update(this.t.documents)
        .set({ namespaceId: targetNamespaceId })
        .where(eq(this.t.documents.namespaceId, stagingNamespaceId)),
      db
        .update(this.t.documentHeads)
        .set({ namespaceId: targetNamespaceId })
        .where(eq(this.t.documentHeads.namespaceId, stagingNamespaceId)),
      db
        .update(this.t.documentChunks)
        .set({ namespaceId: targetNamespaceId })
        .where(eq(this.t.documentChunks.namespaceId, stagingNamespaceId)),
      db
        .update(this.t.memoryOperations)
        .set({ namespaceId: targetNamespaceId })
        .where(eq(this.t.memoryOperations.namespaceId, stagingNamespaceId)),
      db
        .update(this.t.memoryEvents)
        .set({ namespaceId: targetNamespaceId })
        .where(eq(this.t.memoryEvents.namespaceId, stagingNamespaceId)),
    ];
    if (typeof this.db.batch === "function") {
      await this.db.batch(updates(this.db));
      return;
    }
    if (typeof this.db.transaction === "function") {
      await this.db.transaction(async (transaction: any) => {
        for (const query of updates(transaction)) await query;
      });
      return;
    }
    throw new Error("graph adapter does not support atomic import commit");
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
    const existing = await this.getDocument(source.id);
    if (
      existing &&
      JSON.stringify(documentSourceToRow(existing)) !==
        JSON.stringify(documentSourceToRow(source))
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
    }
    if (this.commitDocumentVersionFn) {
      await this.commitDocumentVersionFn(source, chunks, head);
      return;
    }
    const writes = (db: any) => [
      db
        .insert(this.t.documents)
        .values(documentSourceToRow(source))
        .onConflictDoNothing(),
      ...chunks.map((chunk) =>
        db
          .insert(this.t.documentChunks)
          .values(documentChunkToRow(chunk))
          .onConflictDoNothing(),
      ),
      db
        .insert(this.t.documentHeads)
        .values(documentHeadToRow(head))
        .onConflictDoUpdate({
          target: this.t.documentHeads.id,
          set: {
            documentId: head.documentId,
            updatedAt: head.updatedAt,
          },
          setWhere: lte(this.t.documentHeads.updatedAt, head.updatedAt),
        }),
    ];
    if (typeof this.db.batch === "function") {
      await this.db.batch(writes(this.db));
      return;
    }
    if (typeof this.db.transaction === "function") {
      await this.db.transaction(async (transaction: any) => {
        for (const statement of writes(transaction)) await statement;
      });
      return;
    }
    throw new Error("graph adapter does not support atomic document commit");
  }

  async getDocument(id: string): Promise<DocumentSource | null> {
    const rows = await this.db
      .select()
      .from(this.t.documents)
      .where(eq(this.t.documents.id, id))
      .limit(1);
    return rows[0] ? rowToDocumentSource(rows[0]) : null;
  }

  async getCurrentDocument(
    namespaceId: string,
    sourceKey: string,
  ): Promise<DocumentSource | null> {
    const heads = await this.db
      .select()
      .from(this.t.documentHeads)
      .where(
        and(
          eq(this.t.documentHeads.namespaceId, namespaceId),
          eq(this.t.documentHeads.sourceKey, sourceKey),
        ),
      )
      .limit(1);
    return heads[0] ? this.getDocument(heads[0].documentId) : null;
  }

  async listDocumentVersions(
    namespaceId: string,
    sourceKey: string,
  ): Promise<DocumentSource[]> {
    const rows = await this.db
      .select()
      .from(this.t.documents)
      .where(
        and(
          eq(this.t.documents.namespaceId, namespaceId),
          eq(this.t.documents.sourceKey, sourceKey),
        ),
      )
      .orderBy(this.t.documents.createdAt);
    return rows.map(rowToDocumentSource);
  }

  async listCurrentDocuments(
    filters: DocumentFilters,
    options: ListOptions = {},
  ): Promise<DocumentSource[]> {
    const headConditions = [
      eq(this.t.documentHeads.namespaceId, filters.namespaceId),
    ];
    if (filters.sourceKey !== undefined) {
      headConditions.push(
        eq(this.t.documentHeads.sourceKey, filters.sourceKey),
      );
    }
    const heads = await this.db
      .select({ documentId: this.t.documentHeads.documentId })
      .from(this.t.documentHeads)
      .where(and(...headConditions));
    if (!heads.length) return [];
    const conditions = [
      inArray(
        this.t.documents.id,
        heads.map((head: { documentId: string }) => head.documentId),
      ),
      eq(this.t.documents.namespaceId, filters.namespaceId),
    ];
    if (filters.userId !== undefined) {
      conditions.push(eq(this.t.documents.userId, filters.userId));
    }
    if (filters.agentId !== undefined) {
      conditions.push(eq(this.t.documents.agentId, filters.agentId));
    }
    if (filters.runId !== undefined) {
      conditions.push(eq(this.t.documents.runId, filters.runId));
    }
    if (options.cursor) {
      conditions.push(
        or(
          lt(this.t.documents.createdAt, options.cursor.createdAt),
          and(
            eq(this.t.documents.createdAt, options.cursor.createdAt),
            lt(this.t.documents.id, options.cursor.id),
          ),
        )!,
      );
    }
    const rows = await this.db
      .select()
      .from(this.t.documents)
      .where(and(...conditions))
      .orderBy(desc(this.t.documents.createdAt), desc(this.t.documents.id))
      .offset(Math.max(0, options.offset ?? 0))
      .limit(Math.max(0, options.limit ?? 100));
    return rows.map(rowToDocumentSource);
  }

  async getDocumentChunk(id: string): Promise<DocumentChunk | null> {
    const rows = await this.db
      .select()
      .from(this.t.documentChunks)
      .where(eq(this.t.documentChunks.id, id))
      .limit(1);
    return rows[0] ? rowToDocumentChunk(rows[0]) : null;
  }

  async listDocumentChunks(documentId: string): Promise<DocumentChunk[]> {
    const rows = await this.db
      .select()
      .from(this.t.documentChunks)
      .where(eq(this.t.documentChunks.documentId, documentId))
      .orderBy(this.t.documentChunks.index);
    return rows.map(rowToDocumentChunk);
  }

  async purgeDocument(documentId: string): Promise<{
    documentIds: string[];
    chunkIds: string[];
  }> {
    const addressed = await this.getDocument(documentId);
    if (!addressed) return { documentIds: [], chunkIds: [] };
    const documentRows = await this.db
      .select({ id: this.t.documents.id })
      .from(this.t.documents)
      .where(
        and(
          eq(this.t.documents.namespaceId, addressed.namespaceId),
          eq(this.t.documents.sourceKey, addressed.sourceKey),
        ),
      );
    const documentIds = documentRows.map((row: { id: string }) => row.id);
    const chunkRows = documentIds.length
      ? await this.db
          .select({ id: this.t.documentChunks.id })
          .from(this.t.documentChunks)
          .where(inArray(this.t.documentChunks.documentId, documentIds))
      : [];
    const chunkIds = chunkRows.map((row: { id: string }) => row.id);
    const deletes = (db: any) => [
      db
        .delete(this.t.documentHeads)
        .where(
          and(
            eq(this.t.documentHeads.namespaceId, addressed.namespaceId),
            eq(this.t.documentHeads.sourceKey, addressed.sourceKey),
          ),
        ),
      ...(documentIds.length
        ? [
            db
              .delete(this.t.documentChunks)
              .where(inArray(this.t.documentChunks.documentId, documentIds)),
            db
              .delete(this.t.documents)
              .where(inArray(this.t.documents.id, documentIds)),
          ]
        : []),
    ];
    if (typeof this.db.batch === "function") {
      await this.db.batch(deletes(this.db));
    } else if (typeof this.db.transaction === "function") {
      await this.db.transaction(async (transaction: any) => {
        for (const statement of deletes(transaction)) await statement;
      });
    } else {
      throw new Error("graph adapter does not support atomic document purge");
    }
    return { documentIds, chunkIds };
  }

  async claimOperation(operation: MemoryOperation): Promise<OperationClaim> {
    await this.db
      .insert(this.t.memoryOperations)
      .values(operationToRow(operation))
      .onConflictDoNothing({
        target: [
          this.t.memoryOperations.namespaceId,
          this.t.memoryOperations.idempotencyKey,
        ],
      });
    const rows = await this.db
      .select()
      .from(this.t.memoryOperations)
      .where(
        and(
          eq(this.t.memoryOperations.namespaceId, operation.namespaceId),
          eq(this.t.memoryOperations.idempotencyKey, operation.idempotencyKey),
        ),
      )
      .limit(1);
    const stored = rowToOperation(rows[0]);
    if (stored.id === operation.id) {
      return { operation: stored, claimed: true };
    }
    const reclaimed = await this.db
      .update(this.t.memoryOperations)
      .set({
        leaseExpiresAt: operation.leaseExpiresAt ?? null,
        attempts: sql`${this.t.memoryOperations.attempts} + 1`,
        updatedAt: operation.createdAt,
      })
      .where(
        and(
          eq(this.t.memoryOperations.id, stored.id),
          eq(this.t.memoryOperations.status, "pending"),
          or(
            isNull(this.t.memoryOperations.leaseExpiresAt),
            lte(this.t.memoryOperations.leaseExpiresAt, operation.createdAt),
          ),
        ),
      )
      .returning();
    return reclaimed.length
      ? { operation: rowToOperation(reclaimed[0]), claimed: true }
      : { operation: stored, claimed: false };
  }

  async planOperation(
    operationId: string,
    command: Record<string, unknown>,
    memoryIds: string[],
  ): Promise<MemoryOperation> {
    const rows = await this.db
      .update(this.t.memoryOperations)
      .set({
        command,
        memoryIds,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(this.t.memoryOperations.id, operationId),
          eq(this.t.memoryOperations.status, "pending"),
        ),
      )
      .returning();
    if (rows.length !== 1) {
      throw new Error(`pending operation not found: ${operationId}`);
    }
    return rowToOperation(rows[0]);
  }

  async getOperation(operationId: string): Promise<MemoryOperation | null> {
    const rows = await this.db
      .select()
      .from(this.t.memoryOperations)
      .where(eq(this.t.memoryOperations.id, operationId))
      .limit(1);
    return rows[0] ? rowToOperation(rows[0]) : null;
  }

  async listOperations(
    namespaceId: string,
    limit = 100,
  ): Promise<MemoryOperation[]> {
    const rows = await this.db
      .select()
      .from(this.t.memoryOperations)
      .where(eq(this.t.memoryOperations.namespaceId, namespaceId))
      .orderBy(desc(this.t.memoryOperations.createdAt))
      .limit(limit);
    return rows.map(rowToOperation);
  }

  async summarizeOperations(namespaceId: string): Promise<OperationSummary> {
    const [counts] = await this.db
      .select({
        pending: sql<number>`sum(case when ${this.t.memoryOperations.status} = 'pending' then 1 else 0 end)`,
        failed: sql<number>`sum(case when ${this.t.memoryOperations.status} = 'failed' then 1 else 0 end)`,
        vectorPending: sql<number>`sum(case when ${this.t.memoryOperations.vectorStatus} = 'pending' then 1 else 0 end)`,
        derivedPending: sql<number>`sum(case when ${this.t.memoryOperations.derivedStatus} = 'pending' then 1 else 0 end)`,
      })
      .from(this.t.memoryOperations)
      .where(eq(this.t.memoryOperations.namespaceId, namespaceId));
    const [oldest] = await this.db
      .select({ createdAt: this.t.memoryOperations.createdAt })
      .from(this.t.memoryOperations)
      .where(
        and(
          eq(this.t.memoryOperations.namespaceId, namespaceId),
          or(
            eq(this.t.memoryOperations.status, "pending"),
            eq(this.t.memoryOperations.vectorStatus, "pending"),
            eq(this.t.memoryOperations.derivedStatus, "pending"),
          ),
        ),
      )
      .orderBy(this.t.memoryOperations.createdAt)
      .limit(1);
    return {
      pending: Number(counts?.pending ?? 0),
      failed: Number(counts?.failed ?? 0),
      vectorPending: Number(counts?.vectorPending ?? 0),
      derivedPending: Number(counts?.derivedPending ?? 0),
      ...(oldest?.createdAt
        ? { oldestPendingAt: new Date(oldest.createdAt) }
        : {}),
    };
  }

  async markProjectionReady(
    namespaceId: string,
    projection: "vector" | "derived",
  ): Promise<number> {
    const column =
      projection === "vector"
        ? this.t.memoryOperations.vectorStatus
        : this.t.memoryOperations.derivedStatus;
    const set =
      projection === "vector"
        ? { vectorStatus: "ready", updatedAt: new Date() }
        : { derivedStatus: "ready", updatedAt: new Date() };
    const rows = await this.db
      .update(this.t.memoryOperations)
      .set(set)
      .where(
        and(
          eq(this.t.memoryOperations.namespaceId, namespaceId),
          eq(column, "pending"),
        ),
      )
      .returning({ id: this.t.memoryOperations.id });
    return rows.length;
  }

  async retryOperation(
    operationId: string,
    leaseExpiresAt: Date,
  ): Promise<boolean> {
    const rows = await this.db
      .update(this.t.memoryOperations)
      .set({
        status: "pending",
        error: null,
        leaseExpiresAt,
        attempts: sql`${this.t.memoryOperations.attempts} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(this.t.memoryOperations.id, operationId),
          eq(this.t.memoryOperations.status, "failed"),
        ),
      )
      .returning({ id: this.t.memoryOperations.id });
    return rows.length === 1;
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
    if (events.length) {
      await this.db
        .insert(this.t.memoryEvents)
        .values(events.map(journalEventToRow))
        .onConflictDoNothing({ target: this.t.memoryEvents.id });
    }
    await this.db
      .update(this.t.memoryOperations)
      .set({
        status: "committed",
        rawStatus: projections.raw,
        vectorStatus: projections.vector,
        derivedStatus: projections.derived,
        result,
        error: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(eq(this.t.memoryOperations.id, operationId));
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
    await this.db
      .update(this.t.memoryOperations)
      .set({
        status: "failed",
        error,
        leaseExpiresAt: null,
        ...(projections
          ? {
              rawStatus: projections.raw,
              vectorStatus: projections.vector,
              derivedStatus: projections.derived,
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(this.t.memoryOperations.id, operationId));
  }

  async listEvents(namespaceId: string): Promise<MemoryJournalEvent[]> {
    const rows = await this.db
      .select()
      .from(this.t.memoryEvents)
      .where(eq(this.t.memoryEvents.namespaceId, namespaceId))
      .orderBy(this.t.memoryEvents.occurredAt);
    return rows.map(rowToJournalEvent);
  }

  async deleteAll(filters: MemoryFilters): Promise<string[]> {
    const targets = await this.listMemories(filters, { limit: 1_000_000 });
    const ids = targets.map((m) => m.id);
    await this.deleteMemories(ids);
    return ids;
  }

  async purgeNamespace(namespaceId: string): Promise<string[]> {
    const snapshot = await this.exportNamespace(namespaceId);
    const memoryIds = snapshot.memories.map((memory) => memory.id);
    const entityIds = snapshot.entities.map((entity) => entity.id);
    const deletes = (db: any) => {
      const statements: any[] = [];
      if (memoryIds.length) {
        statements.push(
          db
            .delete(this.t.associations)
            .where(
              or(
                inArray(this.t.associations.sourceId, memoryIds),
                inArray(this.t.associations.targetId, memoryIds),
              ),
            ),
          db
            .delete(this.t.history)
            .where(inArray(this.t.history.memoryId, memoryIds)),
          db
            .delete(this.t.memoryEntities)
            .where(inArray(this.t.memoryEntities.memoryId, memoryIds)),
        );
      }
      if (entityIds.length) {
        statements.push(
          db
            .delete(this.t.memoryEntities)
            .where(inArray(this.t.memoryEntities.entityId, entityIds)),
        );
      }
      statements.push(
        db
          .delete(this.t.documentChunks)
          .where(eq(this.t.documentChunks.namespaceId, namespaceId)),
        db
          .delete(this.t.documentHeads)
          .where(eq(this.t.documentHeads.namespaceId, namespaceId)),
        db
          .delete(this.t.documents)
          .where(eq(this.t.documents.namespaceId, namespaceId)),
        db
          .delete(this.t.memoryEvents)
          .where(eq(this.t.memoryEvents.namespaceId, namespaceId)),
        db
          .delete(this.t.memoryOperations)
          .where(eq(this.t.memoryOperations.namespaceId, namespaceId)),
        db
          .delete(this.t.episodes)
          .where(eq(this.t.episodes.namespaceId, namespaceId)),
        db
          .delete(this.t.entities)
          .where(eq(this.t.entities.namespaceId, namespaceId)),
        db
          .delete(this.t.memories)
          .where(eq(this.t.memories.namespaceId, namespaceId)),
      );
      return statements;
    };
    if (typeof this.db.batch === "function") {
      await this.db.batch(deletes(this.db));
    } else if (typeof this.db.transaction === "function") {
      await this.db.transaction(async (transaction: any) => {
        for (const statement of deletes(transaction)) await statement;
      });
    } else {
      throw new Error("graph adapter does not support atomic namespace purge");
    }
    return memoryIds;
  }

  async reset(): Promise<void> {
    await this.db.delete(this.t.documentChunks);
    await this.db.delete(this.t.documentHeads);
    await this.db.delete(this.t.documents);
    await this.db.delete(this.t.memoryEvents);
    await this.db.delete(this.t.memoryOperations);
    await this.db.delete(this.t.associations);
    await this.db.delete(this.t.history);
    await this.db.delete(this.t.memoryEntities);
    await this.db.delete(this.t.entities);
    await this.db.delete(this.t.episodes);
    await this.db.delete(this.t.memories);
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private async insertSnapshotRows(
    table: any,
    rows: Array<Record<string, unknown>>,
  ): Promise<void> {
    if (rows.length === 0) return;
    const boundParametersPerRow = Math.max(
      ...rows.map((row) => Object.keys(row).length),
    );
    const rowsPerInsert = Math.max(
      1,
      Math.floor(MAX_SNAPSHOT_INSERT_BOUND_PARAMETERS / boundParametersPerRow),
    );
    for (const batch of chunkArray(rows, rowsPerInsert)) {
      await this.db.insert(table).values(batch).onConflictDoNothing();
    }
  }

  private scopeConds(filters: MemoryFilters): any[] {
    const conds: any[] = [];
    if (filters.namespaceId !== undefined)
      conds.push(eq(this.t.memories.namespaceId, filters.namespaceId));
    if (filters.userId !== undefined)
      conds.push(eq(this.t.memories.userId, filters.userId));
    if (filters.agentId !== undefined)
      conds.push(eq(this.t.memories.agentId, filters.agentId));
    if (filters.runId !== undefined)
      conds.push(eq(this.t.memories.runId, filters.runId));
    if (filters.memoryType !== undefined)
      conds.push(eq(this.t.memories.memoryType, filters.memoryType));
    if (filters.eventDateFrom !== undefined)
      conds.push(gte(this.t.memories.eventDate, filters.eventDateFrom));
    if (filters.eventDateTo !== undefined)
      conds.push(lte(this.t.memories.eventDate, filters.eventDateTo));
    if (filters.createdAtFrom !== undefined)
      conds.push(gte(this.t.memories.createdAt, filters.createdAtFrom));
    if (filters.createdAtTo !== undefined)
      conds.push(lte(this.t.memories.createdAt, filters.createdAtTo));
    if (filters.lastAccessedAtFrom !== undefined)
      conds.push(
        gte(this.t.memories.lastAccessedAt, filters.lastAccessedAtFrom),
      );
    if (filters.lastAccessedAtTo !== undefined)
      conds.push(lte(this.t.memories.lastAccessedAt, filters.lastAccessedAtTo));
    if (filters.accessed === true)
      conds.push(gt(this.t.memories.accessCount, 0));
    if (filters.accessed === false)
      conds.push(eq(this.t.memories.accessCount, 0));
    if (filters.subject !== undefined)
      conds.push(
        sql`lower(${this.t.memories.subject}) = ${filters.subject.toLowerCase()}`,
      );
    if (filters.attribute !== undefined)
      conds.push(
        sql`lower(${this.t.memories.attribute}) = ${filters.attribute.toLowerCase()}`,
      );
    return conds;
  }

  private scopeWhere(filters: MemoryFilters, includeForgotten: boolean): any {
    const conds = this.scopeConds(filters);
    if (!includeForgotten) conds.unshift(eq(this.t.memories.forgotten, false));
    return conds.length ? and(...conds) : undefined;
  }

  private orderBy(sortKey: string): any[] {
    switch (sortKey) {
      case "importance":
        return [
          desc(this.t.memories.importance),
          desc(this.t.memories.createdAt),
        ];
      case "most_accessed":
        return [
          desc(this.t.memories.accessCount),
          desc(this.t.memories.createdAt),
        ];
      case "last_accessed":
        return [
          desc(this.t.memories.lastAccessedAt),
          desc(this.t.memories.createdAt),
        ];
      default:
        return [desc(this.t.memories.createdAt), desc(this.t.memories.id)];
    }
  }
}

function assertSnapshotRows(
  expected: GraphSnapshotData,
  actual: GraphSnapshotData,
): void {
  const normalize = (data: GraphSnapshotData) => {
    const sortById = <T extends { id: string }>(rows: T[]) =>
      rows
        .map((row) => ({
          ...row,
          ...("namespaceId" in row ? { namespaceId: "_" } : {}),
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
    return {
      memories: sortById(data.memories),
      documents: sortById(data.documents),
      documentHeads: sortById(data.documentHeads),
      documentChunks: sortById(data.documentChunks),
      associations: sortById(data.associations),
      history: sortById(data.history),
      entities: sortById(data.entities),
      memoryEntities: [...data.memoryEntities].sort(
        (a, b) =>
          a.memoryId.localeCompare(b.memoryId) ||
          a.entityId.localeCompare(b.entityId),
      ),
      episodes: sortById(data.episodes),
      operations: sortById(data.operations),
      events: sortById(data.events),
    };
  };
  const normalizedActual = normalize(actual);
  const normalizedExpected = normalize(expected);
  const canonical = (value: unknown): unknown => {
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, canonical(entry)]),
      );
    }
    return value;
  };
  for (const key of Object.keys(normalizedExpected) as Array<
    keyof typeof normalizedExpected
  >) {
    const actualRows = JSON.stringify(canonical(normalizedActual[key]));
    const expectedRows = JSON.stringify(canonical(normalizedExpected[key]));
    if (actualRows !== expectedRows) {
      throw new Error(
        `staged snapshot verification failed for ${key}: expected ${expectedRows}, received ${actualRows}`,
      );
    }
  }
}

function chunkArray<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    chunks.push(values.slice(offset, offset + size));
  }
  return chunks;
}

function memoryToRow(m: Memory): Record<string, unknown> {
  return {
    id: m.id,
    content: m.content,
    memoryType: m.memoryType,
    importance: m.importance,
    hash: m.hash ?? null,
    namespaceId: m.namespaceId ?? null,
    userId: m.userId ?? null,
    agentId: m.agentId ?? null,
    runId: m.runId ?? null,
    source: m.source ?? null,
    metadata: m.metadata ?? null,
    projectionHints: m.projectionHints ?? null,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    lastAccessedAt: m.lastAccessedAt,
    accessCount: m.accessCount,
    forgotten: m.forgotten,
    tier: m.tier ?? "graph",
    demotedAt: m.demotedAt ?? null,
    eventDate: m.eventDate ?? null,
    validFrom: m.validFrom ?? null,
    validTo: m.validTo ?? null,
    supersededBy: m.supersededBy ?? null,
    subject: m.subject ?? null,
    attribute: m.attribute ?? null,
    episodeId: m.episodeId ?? null,
  };
}

function entityToRow(e: Entity): Record<string, unknown> {
  return {
    id: e.id,
    name: e.name,
    normalized: e.normalized,
    namespaceId: e.namespaceId ?? null,
    userId: e.userId ?? null,
    agentId: e.agentId ?? null,
    runId: e.runId ?? null,
    embedding: e.embedding ?? null,
    mentionCount: e.mentionCount,
    createdAt: e.createdAt,
  };
}

function rowToEntity(r: any): Entity {
  return {
    id: r.id,
    name: r.name,
    normalized: r.normalized,
    namespaceId: r.namespaceId ?? undefined,
    userId: r.userId ?? undefined,
    agentId: r.agentId ?? undefined,
    runId: r.runId ?? undefined,
    embedding: (r.embedding ?? undefined) as number[] | undefined,
    mentionCount: Number(r.mentionCount ?? 0),
    createdAt: toDate(r.createdAt),
  };
}

function documentSourceToRow(source: DocumentSource) {
  return {
    id: source.id,
    namespaceId: source.namespaceId,
    sourceKey: source.sourceKey,
    contentHash: source.contentHash,
    versionHash: source.versionHash,
    content: source.content,
    title: source.title ?? null,
    mimeType: source.mimeType,
    sourceUri: source.sourceUri ?? null,
    userId: source.userId ?? null,
    agentId: source.agentId ?? null,
    runId: source.runId ?? null,
    metadata: source.metadata ?? null,
    sizeBytes: source.sizeBytes,
    createdAt: source.createdAt,
  };
}

function rowToDocumentSource(row: any): DocumentSource {
  return {
    id: row.id,
    namespaceId: row.namespaceId,
    sourceKey: row.sourceKey,
    contentHash: row.contentHash,
    versionHash: row.versionHash,
    content: row.content,
    title: row.title ?? undefined,
    mimeType: row.mimeType,
    sourceUri: row.sourceUri ?? undefined,
    userId: row.userId ?? undefined,
    agentId: row.agentId ?? undefined,
    runId: row.runId ?? undefined,
    metadata: (row.metadata ?? undefined) as
      | Record<string, unknown>
      | undefined,
    sizeBytes: Number(row.sizeBytes),
    createdAt: toDate(row.createdAt),
  };
}

function documentHeadToRow(head: DocumentHead) {
  return {
    id: head.id,
    namespaceId: head.namespaceId,
    sourceKey: head.sourceKey,
    documentId: head.documentId,
    updatedAt: head.updatedAt,
  };
}

function rowToDocumentHead(row: any): DocumentHead {
  return {
    id: row.id,
    namespaceId: row.namespaceId,
    sourceKey: row.sourceKey,
    documentId: row.documentId,
    updatedAt: toDate(row.updatedAt),
  };
}

function documentChunkToRow(chunk: DocumentChunk) {
  return {
    id: chunk.id,
    namespaceId: chunk.namespaceId,
    documentId: chunk.documentId,
    sourceKey: chunk.sourceKey,
    index: chunk.index,
    content: chunk.content,
    startOffset: chunk.startOffset,
    endOffset: chunk.endOffset,
    contentHash: chunk.contentHash,
    userId: chunk.userId ?? null,
    agentId: chunk.agentId ?? null,
    runId: chunk.runId ?? null,
    createdAt: chunk.createdAt,
  };
}

function rowToDocumentChunk(row: any): DocumentChunk {
  return {
    id: row.id,
    namespaceId: row.namespaceId,
    documentId: row.documentId,
    sourceKey: row.sourceKey,
    index: Number(row.index),
    content: row.content,
    startOffset: Number(row.startOffset),
    endOffset: Number(row.endOffset),
    contentHash: row.contentHash,
    userId: row.userId ?? undefined,
    agentId: row.agentId ?? undefined,
    runId: row.runId ?? undefined,
    createdAt: toDate(row.createdAt),
  };
}

function rowToMemory(r: any): Memory {
  return {
    id: r.id,
    content: r.content,
    memoryType: r.memoryType as MemoryType,
    importance: Number(r.importance),
    hash: r.hash ?? undefined,
    namespaceId: r.namespaceId ?? undefined,
    userId: r.userId ?? undefined,
    agentId: r.agentId ?? undefined,
    runId: r.runId ?? undefined,
    source: r.source ?? undefined,
    metadata: (r.metadata ?? undefined) as Record<string, unknown> | undefined,
    projectionHints: r.projectionHints ?? undefined,
    createdAt: toDate(r.createdAt),
    updatedAt: toDate(r.updatedAt),
    lastAccessedAt: toDate(r.lastAccessedAt),
    accessCount: Number(r.accessCount),
    forgotten: Boolean(r.forgotten),
    tier: (r.tier ?? "graph") as Memory["tier"],
    demotedAt: r.demotedAt == null ? undefined : toDate(r.demotedAt),
    eventDate: r.eventDate == null ? undefined : toDate(r.eventDate),
    validFrom: r.validFrom == null ? undefined : toDate(r.validFrom),
    validTo: r.validTo == null ? undefined : toDate(r.validTo),
    supersededBy: r.supersededBy ?? undefined,
    subject: r.subject ?? undefined,
    attribute: r.attribute ?? undefined,
    episodeId: r.episodeId ?? undefined,
  };
}

function rowToAssociation(r: any): Association {
  return {
    id: r.id,
    sourceId: r.sourceId,
    targetId: r.targetId,
    relationType: r.relationType as RelationType,
    weight: Number(r.weight),
    createdAt: toDate(r.createdAt),
  };
}

function rowToHistory(r: any): HistoryEntry {
  return {
    id: r.id,
    memoryId: r.memoryId,
    event: r.event as MemoryEvent,
    previousValue: r.previousValue ?? null,
    newValue: r.newValue ?? null,
    createdAt: toDate(r.createdAt),
  };
}

function operationToRow(operation: MemoryOperation): Record<string, unknown> {
  return {
    id: operation.id,
    namespaceId: operation.namespaceId,
    idempotencyKey: operation.idempotencyKey,
    kind: operation.kind,
    requestHash: operation.requestHash,
    command: operation.command,
    memoryIds: operation.memoryIds,
    episodeId: operation.episodeId ?? null,
    status: operation.status,
    rawStatus: operation.rawStatus,
    vectorStatus: operation.vectorStatus,
    derivedStatus: operation.derivedStatus,
    result: operation.result ?? null,
    error: operation.error ?? null,
    leaseExpiresAt: operation.leaseExpiresAt ?? null,
    attempts: operation.attempts,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
  };
}

function rowToOperation(row: any): MemoryOperation {
  if (!row) throw new Error("operation claim did not return a row");
  return {
    id: row.id,
    namespaceId: row.namespaceId,
    idempotencyKey: row.idempotencyKey,
    kind: row.kind,
    requestHash: row.requestHash,
    command: (row.command ?? {}) as Record<string, unknown>,
    memoryIds: (row.memoryIds ?? []) as string[],
    episodeId: row.episodeId ?? undefined,
    status: row.status,
    rawStatus: row.rawStatus,
    vectorStatus: row.vectorStatus,
    derivedStatus: row.derivedStatus,
    result: row.result ?? undefined,
    error: row.error ?? undefined,
    leaseExpiresAt: row.leaseExpiresAt ? toDate(row.leaseExpiresAt) : undefined,
    attempts: Number(row.attempts ?? 1),
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
  } as MemoryOperation;
}

function journalEventToRow(event: MemoryJournalEvent) {
  return {
    id: event.id,
    namespaceId: event.namespaceId,
    operationId: event.operationId,
    memoryId: event.memoryId,
    eventType: event.eventType,
    payload: event.payload,
    occurredAt: event.occurredAt,
  };
}

function rowToJournalEvent(row: any): MemoryJournalEvent {
  return {
    id: row.id,
    namespaceId: row.namespaceId,
    operationId: row.operationId,
    memoryId: row.memoryId,
    eventType: row.eventType,
    payload: row.payload ?? {},
    occurredAt: toDate(row.occurredAt),
  } as MemoryJournalEvent;
}

/** Normalise a timestamp value (Date | epoch ms | ISO string) to a Date. */
function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === "number") return new Date(value);
  if (typeof value === "string") return new Date(value);
  return new Date();
}
