ALTER TABLE "webhook_deliveries" ADD COLUMN "payload" text NOT NULL DEFAULT '{}';
ALTER TABLE "webhook_deliveries" ADD COLUMN "next_attempt_at" integer;
ALTER TABLE "webhook_deliveries" ADD COLUMN "last_attempt_at" integer;
ALTER TABLE "webhook_deliveries" ADD COLUMN "updated_at" integer;
UPDATE "webhook_deliveries" SET "updated_at" = "created_at" WHERE "updated_at" IS NULL;

CREATE TABLE IF NOT EXISTS "operation_tasks" (
  "id" text PRIMARY KEY NOT NULL,
  "document_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "operation_id" text,
  "kind" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "payload" text NOT NULL,
  "attempts" integer NOT NULL DEFAULT 0,
  "max_attempts" integer NOT NULL DEFAULT 5,
  "next_attempt_at" integer,
  "error" text,
  "created_at" integer NOT NULL,
  "updated_at" integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "operation_tasks_document_id_unique"
  ON "operation_tasks" ("document_id");
CREATE INDEX IF NOT EXISTS "operation_tasks_workspace_status_idx"
  ON "operation_tasks" ("workspace_id", "status", "next_attempt_at");

CREATE TABLE IF NOT EXISTS "observability_events" (
  "id" text PRIMARY KEY NOT NULL,
  "document_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "request_id" text,
  "operation_id" text,
  "kind" text NOT NULL,
  "provider" text,
  "model" text,
  "input_tokens" integer,
  "output_tokens" integer,
  "cost_micros" integer,
  "latency_ms" integer,
  "retry_count" integer NOT NULL DEFAULT 0,
  "warning_code" text,
  "metadata" text,
  "created_at" integer NOT NULL
);
CREATE INDEX IF NOT EXISTS "observability_workspace_created_idx"
  ON "observability_events" ("workspace_id", "created_at");
