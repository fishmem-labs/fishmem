import { createClient } from "@libsql/client";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

const databasePath = resolve(".data/fishmem-e2e.db");
if (existsSync(resolve("dist"))) rmSync(resolve("dist"), { recursive: true });
mkdirSync(dirname(databasePath), { recursive: true });
for (const suffix of ["", "-shm", "-wal"]) {
  const path = `${databasePath}${suffix}`;
  if (existsSync(path)) rmSync(path);
}
const client = createClient({ url: `file:${databasePath}` });
for (const name of [
  "0001_fishmem_core.sql",
  "0007_request_logs.sql",
  "0008_project_settings.sql",
  "0011_user_role_and_invites.sql",
  "0012_engine_derivation.sql",
  "0013_structural_namespace.sql",
  "0014_memory_journal.sql",
  "0015_operations_observability.sql",
  "0016_api_token_permissions.sql",
  "0017_task_leases_provider_prices.sql",
  "0018_workspace_description.sql",
  "0019_request_log_credits.sql",
  "0020_document_sources.sql",
  "0021_document_extraction.sql",
  "0022_async_memory_events.sql",
]) {
  await client.executeMultiple(
    readFileSync(resolve("migrations", name), "utf8"),
  );
}
client.close();
