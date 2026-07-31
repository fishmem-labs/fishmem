import { drizzle } from "drizzle-orm/d1";
import type { AppDatabase } from "@/lib/platform";
import * as schema from "@/db/schema";

/** Cloudflare D1 drizzle (used when running on Workers). */
export function createDb(binding: D1Database) {
  return drizzle(binding, { schema });
}

/**
 * The app database type, runtime-agnostic: D1 (Cloudflare) and libSQL (Node)
 * share the SQLite-dialect schema, so both satisfy this base type. Obtain an
 * instance via `getAppDb(env)` from `@/lib/platform`.
 */
export type AppDb = AppDatabase;
export { schema };
