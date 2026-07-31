CREATE TABLE IF NOT EXISTS "source_assets" (
  "id" text PRIMARY KEY NOT NULL,
  "document_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "operation_task_id" text,
  "idempotency_key" text NOT NULL,
  "source_key" text NOT NULL,
  "filename" text NOT NULL,
  "mime_type" text NOT NULL,
  "size_bytes" integer NOT NULL,
  "expected_checksum_sha256" text,
  "checksum_sha256" text,
  "storage_key" text NOT NULL,
  "status" text NOT NULL DEFAULT 'awaiting_upload',
  "title" text,
  "source_uri" text,
  "metadata" text,
  "user_id" text,
  "agent_id" text,
  "run_id" text,
  "artifact_id" text,
  "ingested_document_id" text,
  "error" text,
  "uploaded_at" integer,
  "created_at" integer NOT NULL,
  "updated_at" integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "source_assets_document_id_unique"
  ON "source_assets" ("document_id");
CREATE UNIQUE INDEX IF NOT EXISTS "source_assets_workspace_idempotency_unique"
  ON "source_assets" ("workspace_id", "idempotency_key");
CREATE INDEX IF NOT EXISTS "source_assets_workspace_status_idx"
  ON "source_assets" ("workspace_id", "status", "created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "source_assets_operation_task_unique"
  ON "source_assets" ("operation_task_id");

CREATE TABLE IF NOT EXISTS "extraction_artifacts" (
  "id" text PRIMARY KEY NOT NULL,
  "document_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "source_asset_id" text NOT NULL,
  "extractor" text NOT NULL,
  "extractor_version" text NOT NULL,
  "content_key" text NOT NULL,
  "structure_key" text NOT NULL,
  "content_hash" text NOT NULL,
  "size_bytes" integer NOT NULL,
  "page_count" integer NOT NULL,
  "ingested_document_id" text,
  "created_at" integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "extraction_artifacts_document_id_unique"
  ON "extraction_artifacts" ("document_id");
CREATE UNIQUE INDEX IF NOT EXISTS "extraction_artifacts_source_version_unique"
  ON "extraction_artifacts" (
    "source_asset_id",
    "extractor",
    "extractor_version"
  );
CREATE INDEX IF NOT EXISTS "extraction_artifacts_workspace_created_idx"
  ON "extraction_artifacts" ("workspace_id", "created_at");
