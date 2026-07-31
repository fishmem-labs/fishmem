/**
 * Persistent state sidecar over Drizzle (SQLite / libSQL / Cloudflare D1; the
 * Postgres table mirrors it). Same `StateSidecar` interface as the in-memory
 * one — separate `fishmem_state_slots` table, never in the recall index.
 *
 * The query/upsert logic is dialect-agnostic (drizzle-orm operators), so one
 * class serves every backend; factories wire the dialect-specific client.
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import { ensureSqliteSchemaColumns, PG_DDL, SQLITE_DDL } from "../graph/ddl.js";
import { pgSchema } from "../graph/schema-pg.js";
import { sqliteSchema } from "../graph/schema-sqlite.js";
import type { Scope } from "../memory.js";
import type { StateSidecar, StateSlot, StateUpsert } from "./sidecar.js";

const norm = (v: string) => v.trim().toLowerCase().replace(/\s+/g, " ");
let counter = 0;
const newId = () =>
  `slot_${Date.now().toString(36)}_${(counter++).toString(36)}`;

export class DrizzleStateSidecar implements StateSidecar {
  constructor(
    private readonly db: any,
    private readonly t: any,
    private readonly onClose?: () => Promise<void>,
  ) {}

  private scopeWhere(s: Scope) {
    const t = this.t;
    return [
      s.namespaceId !== undefined
        ? eq(t.namespaceId, s.namespaceId)
        : isNull(t.namespaceId),
      s.userId !== undefined ? eq(t.userId, s.userId) : isNull(t.userId),
      s.agentId !== undefined ? eq(t.agentId, s.agentId) : isNull(t.agentId),
      s.runId !== undefined ? eq(t.runId, s.runId) : isNull(t.runId),
    ];
  }

  private toSlot(r: any): StateSlot {
    return {
      id: r.id,
      scope: {
        namespaceId: r.namespaceId ?? undefined,
        userId: r.userId ?? undefined,
        agentId: r.agentId ?? undefined,
        runId: r.runId ?? undefined,
      },
      subject: r.subject,
      attribute: r.attribute,
      value: r.value,
      validFrom: r.validFrom,
      validTo: r.validTo ?? undefined,
      supersededBy: r.supersededBy ?? undefined,
      sources: Array.isArray(r.sources) ? r.sources : [],
    };
  }

  async upsert(input: StateUpsert): Promise<void> {
    const t = this.t;
    const sk = norm(input.subject);
    const ak = norm(input.attribute);
    const open = await this.db
      .select()
      .from(t)
      .where(
        and(
          ...this.scopeWhere(input.scope),
          eq(t.subjectKey, sk),
          eq(t.attributeKey, ak),
          isNull(t.validTo),
        ),
      );
    const same = open.find((s: any) => norm(s.value) === norm(input.value));
    if (same) {
      const merged = [...new Set([...(same.sources ?? []), ...input.sources])];
      await this.db.update(t).set({ sources: merged }).where(eq(t.id, same.id));
      return;
    }
    const id = newId();
    // Single-valued (default): supersede the current open value(s). Multi-valued
    // (pet, hobby): coexist — leave the existing open values untouched.
    if (input.cardinality !== "multi") {
      for (const s of open) {
        await this.db
          .update(t)
          .set({ validTo: input.validFrom, supersededBy: id })
          .where(eq(t.id, s.id));
      }
    }
    await this.db.insert(t).values({
      id,
      namespaceId: input.scope.namespaceId ?? null,
      userId: input.scope.userId ?? null,
      agentId: input.scope.agentId ?? null,
      runId: input.scope.runId ?? null,
      subject: input.subject,
      attribute: input.attribute,
      subjectKey: sk,
      attributeKey: ak,
      value: input.value,
      validFrom: input.validFrom,
      validTo: null,
      supersededBy: null,
      sources: input.sources,
    });
  }

  private async slotsFor(
    scope: Scope,
    subject: string,
    attribute: string,
  ): Promise<StateSlot[]> {
    const t = this.t;
    const rows = await this.db
      .select()
      .from(t)
      .where(
        and(
          ...this.scopeWhere(scope),
          eq(t.subjectKey, norm(subject)),
          eq(t.attributeKey, norm(attribute)),
        ),
      )
      .orderBy(asc(t.validFrom));
    return rows.map((r: any) => this.toSlot(r));
  }

  async getState(
    scope: Scope,
    subject: string,
    attribute: string,
    opts?: { asOf?: Date },
  ): Promise<StateSlot | undefined> {
    const slots = await this.slotsFor(scope, subject, attribute);
    if (opts?.asOf) {
      const ts = opts.asOf.getTime();
      return slots.find(
        (s) =>
          s.validFrom.getTime() <= ts &&
          (s.validTo === undefined || ts < s.validTo.getTime()),
      );
    }
    return slots.find((s) => s.validTo === undefined);
  }

  async getStateHistory(
    scope: Scope,
    subject: string,
    attribute: string,
  ): Promise<StateSlot[]> {
    return this.slotsFor(scope, subject, attribute);
  }

  async clear(scope?: Scope): Promise<void> {
    if (!scope) {
      await this.db.delete(this.t);
      return;
    }
    await this.db.delete(this.t).where(and(...this.scopeWhere(scope)));
  }

  async close(): Promise<void> {
    await this.onClose?.();
  }
}

export interface SqliteStateSidecarConfig {
  /** libSQL url: ":memory:", "file:fishmem.db", or a Turso "libsql://..." url. */
  url?: string;
  authToken?: string;
  client?: any;
  autoMigrate?: boolean;
}

/**
 * Build a SQLite-backed state sidecar (libSQL: local file, `:memory:`, Turso;
 * Cloudflare D1 shares this dialect). `@libsql/client` + `drizzle-orm/libsql`
 * are lazily imported.
 */
export async function createSqliteStateSidecar(
  config: SqliteStateSidecarConfig = {},
): Promise<StateSidecar> {
  let libsql: any;
  try {
    libsql = await import("@libsql/client");
  } catch {
    throw new Error(
      "The '@libsql/client' package is required for the SQLite state sidecar.",
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
    for (const stmt of SQLITE_DDL) await client.execute(stmt);
    await ensureSqliteSchemaColumns({
      columns: async (table) => {
        const result = await client.execute(`PRAGMA table_info(${table})`);
        return new Set(result.rows.map((row: any) => String(row.name)));
      },
      execute: (sql) => client.execute(sql),
    });
  }
  return new DrizzleStateSidecar(
    db,
    sqliteSchema.stateSlots,
    config.client ? undefined : async () => client.close?.(),
  );
}

export interface PostgresStateSidecarConfig {
  /** Connection string, used to build a `pg` Pool if `pool` is absent. */
  connectionString?: string;
  pool?: any;
  autoMigrate?: boolean;
}

/** Build a Postgres-backed state sidecar (Drizzle + node-postgres). `pg` and
 * `drizzle-orm/node-postgres` are lazily imported. */
export async function createPostgresStateSidecar(
  config: PostgresStateSidecarConfig,
): Promise<StateSidecar> {
  let pg: any;
  try {
    pg = await import("pg");
  } catch {
    throw new Error(
      "The 'pg' package is required for the Postgres state sidecar.",
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
    for (const stmt of PG_DDL) await pool.query(stmt);
  }
  return new DrizzleStateSidecar(
    db,
    pgSchema.stateSlots,
    config.pool ? undefined : async () => pool.end(),
  );
}

export interface D1StateSidecarConfig {
  binding: any;
  /** Run CREATE TABLE IF NOT EXISTS on init (default false; prefer wrangler
   * migrations in production). */
  autoMigrate?: boolean;
}

/** Build a Cloudflare D1-backed state sidecar (Drizzle + drizzle-orm/d1) — the
 * recommended sidecar for Workers (pair with the D1 graph + Vectorize). */
export async function createD1StateSidecar(
  config: D1StateSidecarConfig,
): Promise<StateSidecar> {
  if (!config?.binding) {
    throw new Error("createD1StateSidecar requires a D1 binding.");
  }
  let drizzleMod: any;
  try {
    drizzleMod = await import("drizzle-orm/d1");
  } catch {
    throw new Error("drizzle-orm/d1 is required for Cloudflare D1.");
  }
  const db = drizzleMod.drizzle(config.binding, { schema: sqliteSchema });
  if (config.autoMigrate ?? false) {
    for (const stmt of SQLITE_DDL) await config.binding.prepare(stmt).run();
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
  return new DrizzleStateSidecar(db, sqliteSchema.stateSlots);
}
