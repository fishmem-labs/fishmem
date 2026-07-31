ALTER TABLE "webhook_deliveries" ADD COLUMN "lease_expires_at" integer;
ALTER TABLE "operation_tasks" ADD COLUMN "lease_expires_at" integer;
ALTER TABLE "operation_tasks" ADD COLUMN "result" text;
CREATE UNIQUE INDEX IF NOT EXISTS "operation_tasks_workspace_operation_unique"
  ON "operation_tasks" ("workspace_id", "kind", "operation_id");

CREATE TABLE IF NOT EXISTS "provider_price_snapshots" (
  "id" text PRIMARY KEY NOT NULL,
  "document_id" text NOT NULL,
  "workspace_id" text,
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "kind" text NOT NULL,
  "input_micros_per_million" integer NOT NULL,
  "output_micros_per_million" integer NOT NULL,
  "source" text NOT NULL,
  "effective_at" integer NOT NULL,
  "created_at" integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "provider_price_snapshots_document_id_unique"
  ON "provider_price_snapshots" ("document_id");
CREATE INDEX IF NOT EXISTS "provider_prices_lookup_idx"
  ON "provider_price_snapshots" (
    "workspace_id", "provider", "model", "kind", "effective_at"
  );
