import type { GraphStore } from "./base.js";
import { ensureSqliteSchemaColumns, SQLITE_DDL } from "./ddl.js";
import { DrizzleGraphStore } from "./drizzle-store.js";
import { sqliteSchema } from "./schema-sqlite.js";

export interface SqliteGraphStoreConfig {
  /** libSQL url: ":memory:", "file:fishmem.db", or a Turso "libsql://..." url. */
  url?: string;
  authToken?: string;
  /** An existing @libsql/client Client. */
  client?: any;
  autoMigrate?: boolean;
}

/**
 * Build a SQLite-backed `GraphStore` via libSQL (Drizzle + @libsql/client).
 * Works against local files, `:memory:`, and Turso. The graph lives in the
 * `fishmem_associations` table.
 *
 * `@libsql/client` and `drizzle-orm/libsql` are lazily imported.
 */
export async function createSqliteGraphStore(
  config: SqliteGraphStoreConfig = {},
): Promise<GraphStore> {
  let libsql: any;
  try {
    libsql = await import("@libsql/client");
  } catch {
    throw new Error(
      "The '@libsql/client' package is required for the SQLite graph store.",
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
  const autoMigrate = config.autoMigrate ?? true;

  return new DrizzleGraphStore({
    db,
    tables: sqliteSchema,
    migrate: autoMigrate
      ? async () => {
          for (const stmt of SQLITE_DDL) await client.execute(stmt);
          await ensureSqliteSchemaColumns({
            columns: async (table) => {
              const result = await client.execute(
                `PRAGMA table_info(${table})`,
              );
              return new Set(result.rows.map((row: any) => String(row.name)));
            },
            execute: (sql) => client.execute(sql),
          });
        }
      : undefined,
    onClose: config.client ? undefined : async () => client.close?.(),
  });
}
