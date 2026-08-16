/** Persistent relational adapters for BeliefReconciler. */
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { ensureSqliteSchemaColumns, PG_DDL, SQLITE_DDL } from "../graph/ddl.js";
import { pgSchema } from "../graph/schema-pg.js";
import { sqliteSchema } from "../graph/schema-sqlite.js";
import type { Scope } from "../memory.js";
import {
  type ApplicabilityKind,
  type BeliefEvidence,
  type BeliefEvidenceStore,
  type BeliefPolicy,
  BeliefReconciler,
} from "./belief-reconciler.js";

export class DrizzleBeliefEvidenceStore implements BeliefEvidenceStore {
  constructor(
    private readonly db: any,
    private readonly table: any,
    private readonly onClose?: () => Promise<void>,
  ) {}

  async put(evidence: BeliefEvidence): Promise<void> {
    const row = evidenceToRow(evidence);
    const { id: _ignored, ...set } = row;
    await this.db
      .insert(this.table)
      .values(row)
      .onConflictDoUpdate({ target: this.table.id, set });
  }

  async listSlot(
    scope: Scope,
    subjectKey: string,
    attributeKey: string,
  ): Promise<BeliefEvidence[]> {
    const rows = await this.db
      .select()
      .from(this.table)
      .where(
        and(
          ...this.exactScope(scope),
          eq(this.table.subjectKey, subjectKey),
          eq(this.table.attributeKey, attributeKey),
        ),
      );
    return rows.map(rowToEvidence);
  }

  async invalidateSource(sourceId: string, validTo: Date): Promise<void> {
    await this.db
      .update(this.table)
      .set({ validTo })
      .where(
        and(
          eq(this.table.sourceId, sourceId),
          or(isNull(this.table.validTo), gt(this.table.validTo, validTo)),
        ),
      );
  }

  async removeSource(sourceId: string): Promise<void> {
    await this.db.delete(this.table).where(eq(this.table.sourceId, sourceId));
  }

  async clear(scope?: Scope): Promise<void> {
    if (!scope) {
      await this.db.delete(this.table);
      return;
    }
    const conditions = this.partialScope(scope);
    if (!conditions.length) {
      await this.db.delete(this.table);
      return;
    }
    await this.db.delete(this.table).where(and(...conditions));
  }

  async close(): Promise<void> {
    await this.onClose?.();
  }

  private exactScope(scope: Scope) {
    return scopeFields(this.table).map(([field, value]) =>
      value(scope) === undefined
        ? isNull(field)
        : eq(field, value(scope) as string),
    );
  }

  private partialScope(scope: Scope) {
    return scopeFields(this.table).flatMap(([field, value]) => {
      const resolved = value(scope);
      return resolved === undefined ? [] : [eq(field, resolved)];
    });
  }
}

export interface SqliteBeliefReconcilerConfig {
  url?: string;
  authToken?: string;
  client?: any;
  autoMigrate?: boolean;
  policy?: Partial<BeliefPolicy>;
}

export async function createSqliteBeliefReconciler(
  config: SqliteBeliefReconcilerConfig = {},
): Promise<BeliefReconciler> {
  let libsql: any;
  try {
    libsql = await import("@libsql/client");
  } catch {
    throw new Error(
      "The '@libsql/client' package is required for the SQLite belief projection.",
    );
  }
  let drizzleMod: any;
  try {
    drizzleMod = await import("drizzle-orm/libsql");
  } catch {
    throw new Error("drizzle-orm/libsql is required for SQLite.");
  }
  const client =
    config.client ??
    libsql.createClient({
      url: config.url ?? ":memory:",
      authToken: config.authToken,
    });
  const db = drizzleMod.drizzle(client, { schema: sqliteSchema });
  if (config.autoMigrate ?? true) {
    for (const statement of SQLITE_DDL) await client.execute(statement);
    await ensureSqliteSchemaColumns({
      columns: async (table) => {
        const result = await client.execute(`PRAGMA table_info(${table})`);
        return new Set(result.rows.map((row: any) => String(row.name)));
      },
      execute: (sql) => client.execute(sql),
    });
  }
  return new BeliefReconciler({
    store: new DrizzleBeliefEvidenceStore(
      db,
      sqliteSchema.beliefEvidence,
      config.client ? undefined : async () => client.close?.(),
    ),
    policy: config.policy,
  });
}

export interface PostgresBeliefReconcilerConfig {
  connectionString?: string;
  pool?: any;
  autoMigrate?: boolean;
  policy?: Partial<BeliefPolicy>;
}

export async function createPostgresBeliefReconciler(
  config: PostgresBeliefReconcilerConfig,
): Promise<BeliefReconciler> {
  let pg: any;
  try {
    pg = await import("pg");
  } catch {
    throw new Error(
      "The 'pg' package is required for the Postgres belief projection.",
    );
  }
  let drizzleMod: any;
  try {
    drizzleMod = await import("drizzle-orm/node-postgres");
  } catch {
    throw new Error("drizzle-orm/node-postgres is required for Postgres.");
  }
  const Pool = pg.default?.Pool ?? pg.Pool;
  const pool =
    config.pool ?? new Pool({ connectionString: config.connectionString });
  const db = drizzleMod.drizzle(pool, { schema: pgSchema });
  if (config.autoMigrate ?? true) {
    for (const statement of PG_DDL) await pool.query(statement);
  }
  return new BeliefReconciler({
    store: new DrizzleBeliefEvidenceStore(
      db,
      pgSchema.beliefEvidence,
      config.pool ? undefined : async () => pool.end(),
    ),
    policy: config.policy,
  });
}

export interface D1BeliefReconcilerConfig {
  binding: any;
  autoMigrate?: boolean;
  policy?: Partial<BeliefPolicy>;
}

export async function createD1BeliefReconciler(
  config: D1BeliefReconcilerConfig,
): Promise<BeliefReconciler> {
  if (!config?.binding) {
    throw new Error("createD1BeliefReconciler requires a D1 binding.");
  }
  let drizzleMod: any;
  try {
    drizzleMod = await import("drizzle-orm/d1");
  } catch {
    throw new Error("drizzle-orm/d1 is required for Cloudflare D1.");
  }
  const db = drizzleMod.drizzle(config.binding, { schema: sqliteSchema });
  if (config.autoMigrate ?? false) {
    for (const statement of SQLITE_DDL) {
      await config.binding.prepare(statement).run();
    }
    await ensureSqliteSchemaColumns({
      columns: async (table) => {
        const result = await config.binding
          .prepare(`PRAGMA table_info(${table})`)
          .all();
        return new Set(
          (result.results ?? []).map((row: any) => String(row.name)),
        );
      },
      execute: (sql) => config.binding.prepare(sql).run(),
    });
  }
  return new BeliefReconciler({
    store: new DrizzleBeliefEvidenceStore(db, sqliteSchema.beliefEvidence),
    policy: config.policy,
  });
}

function scopeFields(table: any) {
  return [
    [table.namespaceId, (scope: Scope) => scope.namespaceId],
    [table.userId, (scope: Scope) => scope.userId],
    [table.agentId, (scope: Scope) => scope.agentId],
    [table.runId, (scope: Scope) => scope.runId],
  ] as const;
}

function evidenceToRow(evidence: BeliefEvidence) {
  return {
    id: evidence.id,
    namespaceId: evidence.scope.namespaceId ?? null,
    userId: evidence.scope.userId ?? null,
    agentId: evidence.scope.agentId ?? null,
    runId: evidence.scope.runId ?? null,
    subject: evidence.subject,
    attribute: evidence.attribute,
    subjectKey: evidence.subjectKey,
    attributeKey: evidence.attributeKey,
    value: evidence.value,
    valueKey: evidence.valueKey,
    sourceId: evidence.sourceId,
    evidenceKey: evidence.evidenceKey,
    contextId: evidence.contextId,
    applicabilityKind: evidence.applicability.kind,
    applicabilityKey: evidence.applicability.key ?? null,
    applicabilityValidFrom: evidence.applicability.validFrom ?? null,
    applicabilityValidTo: evidence.applicability.validTo ?? null,
    clusterKey: evidence.clusterKey,
    candidateKey: evidence.candidateKey,
    observedAt: evidence.observedAt,
    validFrom: evidence.validFrom,
    validTo: evidence.validTo ?? null,
    weight: evidence.weight,
  };
}

function rowToEvidence(row: any): BeliefEvidence {
  return {
    id: String(row.id),
    scope: {
      ...(row.namespaceId != null
        ? { namespaceId: String(row.namespaceId) }
        : {}),
      ...(row.userId != null ? { userId: String(row.userId) } : {}),
      ...(row.agentId != null ? { agentId: String(row.agentId) } : {}),
      ...(row.runId != null ? { runId: String(row.runId) } : {}),
    },
    subject: String(row.subject),
    attribute: String(row.attribute),
    subjectKey: String(row.subjectKey),
    attributeKey: String(row.attributeKey),
    value: String(row.value),
    valueKey: String(row.valueKey),
    sourceId: String(row.sourceId),
    evidenceKey: String(row.evidenceKey),
    contextId: String(row.contextId),
    applicability: {
      kind: row.applicabilityKind as ApplicabilityKind,
      ...(row.applicabilityKey != null
        ? { key: String(row.applicabilityKey) }
        : {}),
      ...(row.applicabilityValidFrom != null
        ? { validFrom: toDate(row.applicabilityValidFrom) }
        : {}),
      ...(row.applicabilityValidTo != null
        ? { validTo: toDate(row.applicabilityValidTo) }
        : {}),
    },
    clusterKey: String(row.clusterKey),
    candidateKey: String(row.candidateKey),
    observedAt: toDate(row.observedAt),
    validFrom: toDate(row.validFrom),
    ...(row.validTo != null ? { validTo: toDate(row.validTo) } : {}),
    weight: Number(row.weight),
  };
}

function toDate(value: unknown): Date {
  return value instanceof Date ? new Date(value) : new Date(value as any);
}
