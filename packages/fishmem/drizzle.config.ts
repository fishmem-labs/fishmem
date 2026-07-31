import { defineConfig } from "drizzle-kit";

/**
 * Optional: generate SQL migrations with drizzle-kit instead of relying on the
 * built-in `autoMigrate` DDL bootstrap.
 *
 *   SQLite/libSQL:  npx drizzle-kit generate
 *   Postgres:       point `schema` at ./src/graph/schema-pg.ts and set dialect
 *                   to "postgresql", then `npx drizzle-kit generate`.
 *
 * The migrations land in ./drizzle and can be applied with `drizzle-kit migrate`
 * or, for Cloudflare D1, `wrangler d1 migrations apply`.
 */
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/graph/schema-sqlite.ts",
  out: "./drizzle",
});
