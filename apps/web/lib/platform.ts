/**
 * Platform adapter — the single seam that makes the OSS dashboard portable.
 *
 * The app runs on three targets, selected by env (Cloudflare stays a
 * first-class option — it is NOT removed):
 *
 *   default / FISHMEM_RUNTIME=cloudflare → Cloudflare: D1 + Vectorize + R2
 *   FISHMEM_RUNTIME=node  (or FISHMEM_DB=libsql|postgres) → Node: libSQL/Postgres
 *
 * Default is Cloudflare so the live Cloud build is unaffected with zero env
 * changes; Node self-host (Vercel / Docker) is opted into via FISHMEM_RUNTIME
 * or FISHMEM_DB. See docs/OPEN-CORE.md for the full env contract.
 *
 * Managed-service deploy config (wrangler, production secrets, billing) lives in
 * the private FishMem Cloud application — never here.
 */
import { drizzle as drizzleD1 } from "drizzle-orm/d1";
import { drizzle as drizzleLibsql } from "drizzle-orm/libsql";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import * as schema from "@/db/schema";

export type DbKind = "d1" | "libsql" | "postgres";

const RUNTIME = process.env.FISHMEM_RUNTIME ?? "auto";
export const DB_KIND: DbKind =
  (process.env.FISHMEM_DB as DbKind) ||
  (RUNTIME === "node" ? "libsql" : "d1");

/** Cloudflare unless explicitly Node (FISHMEM_RUNTIME=node or a Node DB). */
export const IS_CLOUDFLARE =
  RUNTIME === "cloudflare" ||
  (RUNTIME === "auto" && DB_KIND === "d1" && process.env.FISHMEM_DB == null);

export const DATABASE_URL =
  process.env.DATABASE_URL || "file:.data/fishmem.db";

/** Common base of the D1 and libSQL drizzle databases (shared SQLite schema). */
// biome-ignore lint/suspicious/noExplicitAny: unify D1Result vs libSQL ResultSet
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AppDatabase = BaseSQLiteDatabase<"async", any, typeof schema>;

let libsql: Awaited<ReturnType<typeof openLibsql>> | undefined;
async function openLibsql() {
  const { createClient } = await import("@libsql/client");
  return createClient({ url: DATABASE_URL });
}

/** The app drizzle database for the active runtime. */
export async function getAppDb(env: {
  D1?: unknown;
}): Promise<AppDatabase> {
  if (DB_KIND === "postgres") {
    throw new Error(
      "FISHMEM_DB=postgres needs the pg-dialect app schema (see docs/OPEN-CORE.md, Phase A.2). " +
        "FISHMEM_DB=libsql is the supported Node default today.",
    );
  }
  if (IS_CLOUDFLARE) {
    return drizzleD1(env.D1 as never, { schema }) as AppDatabase;
  }
  return drizzleLibsql(await openLibsqlSingleton(), { schema }) as AppDatabase;
}

async function openLibsqlSingleton() {
  if (!libsql) libsql = await openLibsql();
  return libsql;
}

/** fishmem graph + vector stores for the active runtime. The backend is fixed
 * at deploy time (env) — read-only in the dashboard. */
export async function createMemoryStores(env: {
  D1?: unknown;
  VECTORIZE?: unknown;
}) {
  const fishmem = await import("fishmem");
  if (IS_CLOUDFLARE) {
    if (!env.D1) throw new Error("D1 binding is required");
    if (!env.VECTORIZE) throw new Error("VECTORIZE binding is required");
    const graphStore = await fishmem.createD1GraphStore({
      binding: env.D1 as never,
      autoMigrate: false,
    });
    const stateSidecar = await fishmem.createD1StateSidecar({
      binding: env.D1 as never,
      autoMigrate: false,
    });
    const beliefReconciler = await fishmem.createD1BeliefReconciler({
      binding: env.D1 as never,
      autoMigrate: false,
    });
    const vectorStore = new fishmem.VectorizeStore({
      index: env.VECTORIZE as never,
    });
    return { graphStore, stateSidecar, beliefReconciler, vectorStore };
  }
  const graphStore = await fishmem.createSqliteGraphStore({ url: DATABASE_URL });
  const stateSidecar = await fishmem.createSqliteStateSidecar({
    url: DATABASE_URL,
  });
  const beliefReconciler = await fishmem.createSqliteBeliefReconciler({
    url: DATABASE_URL,
  });
  const vectorStore = new fishmem.SqliteVectorStore({ url: DATABASE_URL });
  return { graphStore, stateSidecar, beliefReconciler, vectorStore };
}
