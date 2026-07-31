CREATE TABLE IF NOT EXISTS "fishmem_operations" (
  "id" text PRIMARY KEY NOT NULL,
  "namespace_id" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "kind" text NOT NULL,
  "request_hash" text NOT NULL,
  "command" text NOT NULL,
  "memory_ids" text NOT NULL,
  "episode_id" text,
  "status" text NOT NULL,
  "raw_status" text NOT NULL,
  "vector_status" text NOT NULL,
  "derived_status" text NOT NULL,
  "result" text,
  "error" text,
  "lease_expires_at" integer,
  "attempts" integer DEFAULT 1 NOT NULL,
  "created_at" integer NOT NULL,
  "updated_at" integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "fishmem_operation_idempotency_uniq"
  ON "fishmem_operations" ("namespace_id", "idempotency_key");

CREATE TABLE IF NOT EXISTS "fishmem_events" (
  "id" text PRIMARY KEY NOT NULL,
  "namespace_id" text NOT NULL,
  "operation_id" text NOT NULL,
  "memory_id" text NOT NULL,
  "event_type" text NOT NULL,
  "payload" text NOT NULL,
  "occurred_at" integer NOT NULL
);
CREATE INDEX IF NOT EXISTS "fishmem_event_namespace_time_idx"
  ON "fishmem_events" ("namespace_id", "occurred_at");
CREATE INDEX IF NOT EXISTS "fishmem_event_operation_idx"
  ON "fishmem_events" ("operation_id");
