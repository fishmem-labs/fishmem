import type { GraphStore } from "./base.js";
import { PG_DDL } from "./ddl.js";
import { DrizzleGraphStore } from "./drizzle-store.js";
import { pgSchema } from "./schema-pg.js";

export interface PostgresGraphStoreConfig {
  /** Connection string, used to construct a `pg` Pool if `pool` is absent. */
  connectionString?: string;
  /** An existing `pg` Pool. */
  pool?: any;
  /** Run CREATE TABLE IF NOT EXISTS on init (default true). */
  autoMigrate?: boolean;
}

/**
 * Build a Postgres-backed `GraphStore` (Drizzle + node-postgres). The graph
 * lives in the `fishmem_associations` table — no separate graph database.
 *
 * `pg` and `drizzle-orm/node-postgres` are lazily imported.
 */
export async function createPostgresGraphStore(
  config: PostgresGraphStoreConfig,
): Promise<GraphStore> {
  let pg: any;
  try {
    pg = await import("pg");
  } catch {
    throw new Error(
      "The 'pg' package is required for the Postgres graph store.",
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
  const autoMigrate = config.autoMigrate ?? true;

  return new DrizzleGraphStore({
    db,
    tables: pgSchema,
    migrate: autoMigrate
      ? async () => {
          for (const stmt of PG_DDL) await pool.query(stmt);
        }
      : undefined,
    onClose: config.pool ? undefined : async () => pool.end(),
  });
}
