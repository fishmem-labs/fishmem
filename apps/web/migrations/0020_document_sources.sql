CREATE TABLE IF NOT EXISTS "fishmem_documents" (
  "id" text PRIMARY KEY NOT NULL,
  "namespace_id" text NOT NULL,
  "source_key" text NOT NULL,
  "content_hash" text NOT NULL,
  "version_hash" text NOT NULL,
  "content" text NOT NULL,
  "title" text,
  "mime_type" text NOT NULL,
  "source_uri" text,
  "user_id" text,
  "agent_id" text,
  "run_id" text,
  "metadata" text,
  "size_bytes" integer NOT NULL,
  "created_at" integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "fishmem_document_source_version_uniq"
  ON "fishmem_documents" ("namespace_id", "source_key", "version_hash");
CREATE INDEX IF NOT EXISTS "fishmem_document_scope_idx"
  ON "fishmem_documents" (
    "namespace_id",
    "user_id",
    "agent_id",
    "run_id",
    "created_at"
  );

CREATE TABLE IF NOT EXISTS "fishmem_document_heads" (
  "id" text PRIMARY KEY NOT NULL,
  "namespace_id" text NOT NULL,
  "source_key" text NOT NULL,
  "document_id" text NOT NULL,
  "updated_at" integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "fishmem_document_head_source_uniq"
  ON "fishmem_document_heads" ("namespace_id", "source_key");
CREATE INDEX IF NOT EXISTS "fishmem_document_head_document_idx"
  ON "fishmem_document_heads" ("document_id");

CREATE TABLE IF NOT EXISTS "fishmem_document_chunks" (
  "id" text PRIMARY KEY NOT NULL,
  "namespace_id" text NOT NULL,
  "document_id" text NOT NULL,
  "source_key" text NOT NULL,
  "chunk_index" integer NOT NULL,
  "content" text NOT NULL,
  "start_offset" integer NOT NULL,
  "end_offset" integer NOT NULL,
  "content_hash" text NOT NULL,
  "user_id" text,
  "agent_id" text,
  "run_id" text,
  "created_at" integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "fishmem_document_chunk_index_uniq"
  ON "fishmem_document_chunks" ("document_id", "chunk_index");
CREATE INDEX IF NOT EXISTS "fishmem_document_chunk_namespace_idx"
  ON "fishmem_document_chunks" ("namespace_id", "document_id");
