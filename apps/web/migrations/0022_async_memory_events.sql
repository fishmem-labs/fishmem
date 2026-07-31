ALTER TABLE "operation_tasks" ADD COLUMN "started_at" integer;
ALTER TABLE "operation_tasks" ADD COLUMN "completed_at" integer;

CREATE INDEX IF NOT EXISTS "operation_tasks_workspace_created_idx"
  ON "operation_tasks" ("workspace_id", "created_at", "document_id");
