import { defineConfig } from "drizzle-kit";

// App-table migrations (better-auth + app schema). The runtime is chosen the
// same way as the app (see lib/platform.ts): libSQL/SQLite for Node self-host,
// Cloudflare D1 otherwise.
const isLibsql = process.env.FISHMEM_DB === "libsql";

export default defineConfig(
  isLibsql
    ? {
        schema: "./db/schema.ts",
        out: "./migrations",
        dialect: "turso",
        dbCredentials: {
          url: process.env.DATABASE_URL ?? "file:.data/fishmem.db",
          ...(process.env.DATABASE_AUTH_TOKEN
            ? { authToken: process.env.DATABASE_AUTH_TOKEN }
            : {}),
        },
      }
    : {
        schema: "./db/schema.ts",
        out: "./migrations",
        dialect: "sqlite",
        driver: "d1-http",
        dbCredentials: {
          accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
          databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID ?? "",
          token: process.env.CLOUDFLARE_API_TOKEN ?? "",
        },
      },
);
