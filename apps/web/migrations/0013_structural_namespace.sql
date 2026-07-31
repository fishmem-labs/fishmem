-- Promote the legacy metadata.__ws tenant tag into a structural namespace.
-- Entity links and state slots were previously scoped without workspace, so
-- their ownership cannot be proven. They are derived projections and are
-- cleared rather than guessed; raw memories remain authoritative/rebuildable.

CREATE TABLE IF NOT EXISTS "fishmem_memories" (
  "id" text PRIMARY KEY NOT NULL,
  "content" text NOT NULL,
  "memory_type" text NOT NULL,
  "importance" real DEFAULT 0.5 NOT NULL,
  "hash" text,
  "user_id" text,
  "agent_id" text,
  "run_id" text,
  "source" text,
  "metadata" text,
  "created_at" integer NOT NULL,
  "updated_at" integer NOT NULL,
  "last_accessed_at" integer NOT NULL,
  "access_count" integer DEFAULT 0 NOT NULL,
  "forgotten" integer DEFAULT 0 NOT NULL,
  "tier" text DEFAULT 'graph' NOT NULL,
  "demoted_at" integer,
  "event_date" integer,
  "valid_from" integer,
  "valid_to" integer,
  "superseded_by" text,
  "subject" text,
  "attribute" text,
  "episode_id" text
);
CREATE TABLE IF NOT EXISTS "fishmem_associations" (
  "id" text PRIMARY KEY NOT NULL,
  "source_id" text NOT NULL,
  "target_id" text NOT NULL,
  "relation_type" text NOT NULL,
  "weight" real DEFAULT 0.5 NOT NULL,
  "created_at" integer NOT NULL
);
CREATE TABLE IF NOT EXISTS "fishmem_history" (
  "id" text PRIMARY KEY NOT NULL,
  "memory_id" text NOT NULL,
  "event" text NOT NULL,
  "previous_value" text,
  "new_value" text,
  "created_at" integer NOT NULL
);
CREATE TABLE IF NOT EXISTS "fishmem_entities" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "normalized" text NOT NULL,
  "user_id" text,
  "agent_id" text,
  "run_id" text,
  "embedding" text,
  "mention_count" integer DEFAULT 0 NOT NULL,
  "created_at" integer NOT NULL
);
CREATE TABLE IF NOT EXISTS "fishmem_memory_entities" (
  "memory_id" text NOT NULL,
  "entity_id" text NOT NULL
);
CREATE TABLE IF NOT EXISTS "fishmem_episodes" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text,
  "agent_id" text,
  "run_id" text,
  "messages" text NOT NULL,
  "source" text,
  "created_at" integer NOT NULL
);
CREATE TABLE IF NOT EXISTS "fishmem_state_slots" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text,
  "agent_id" text,
  "run_id" text,
  "subject" text NOT NULL,
  "attribute" text NOT NULL,
  "subject_key" text NOT NULL,
  "attribute_key" text NOT NULL,
  "value" text NOT NULL,
  "valid_from" integer NOT NULL,
  "valid_to" integer,
  "superseded_by" text,
  "sources" text NOT NULL
);

ALTER TABLE "fishmem_memories" ADD COLUMN "namespace_id" text;
ALTER TABLE "fishmem_entities" ADD COLUMN "namespace_id" text;
ALTER TABLE "fishmem_episodes" ADD COLUMN "namespace_id" text;
ALTER TABLE "fishmem_state_slots" ADD COLUMN "namespace_id" text;

UPDATE "fishmem_memories"
SET "namespace_id" = json_extract("metadata", '$.__ws'),
    "metadata" = json_remove("metadata", '$.__ws')
WHERE json_valid("metadata") AND json_type("metadata", '$.__ws') = 'text';

UPDATE "fishmem_episodes"
SET "namespace_id" = (
  SELECT min("namespace_id")
  FROM "fishmem_memories"
  WHERE "episode_id" = "fishmem_episodes"."id"
)
WHERE 1 = (
  SELECT count(DISTINCT "namespace_id")
  FROM "fishmem_memories"
  WHERE "episode_id" = "fishmem_episodes"."id"
);

DELETE FROM "fishmem_associations"
WHERE EXISTS (
  SELECT 1
  FROM "fishmem_memories" AS source
  JOIN "fishmem_memories" AS target
    ON target."id" = "fishmem_associations"."target_id"
  WHERE source."id" = "fishmem_associations"."source_id"
    AND source."namespace_id" IS NOT target."namespace_id"
);

DELETE FROM "fishmem_memory_entities";
DELETE FROM "fishmem_entities";
DELETE FROM "fishmem_state_slots";

CREATE INDEX IF NOT EXISTS "fishmem_mem_namespace_scope_idx"
  ON "fishmem_memories" ("namespace_id", "user_id", "agent_id", "run_id");
CREATE INDEX IF NOT EXISTS "fishmem_ent_namespace_scope_idx"
  ON "fishmem_entities" ("namespace_id", "user_id", "agent_id", "run_id");
CREATE INDEX IF NOT EXISTS "fishmem_slot_namespace_key_idx"
  ON "fishmem_state_slots" (
    "namespace_id", "user_id", "agent_id", "run_id", "subject_key", "attribute_key"
  );
