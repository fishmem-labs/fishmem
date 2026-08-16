-- Rebuildable governed-belief projection. Canonical memory content remains in
-- fishmem_memories; projection_hints is the frozen, JSON-safe input needed to
-- rebuild evidence rows without another LLM call.

ALTER TABLE "fishmem_memories" ADD COLUMN "projection_hints" text;

CREATE TABLE "fishmem_belief_evidence" (
  "id" text PRIMARY KEY NOT NULL,
  "namespace_id" text,
  "user_id" text,
  "agent_id" text,
  "run_id" text,
  "subject" text NOT NULL,
  "attribute" text NOT NULL,
  "subject_key" text NOT NULL,
  "attribute_key" text NOT NULL,
  "value" text NOT NULL,
  "value_key" text NOT NULL,
  "source_id" text NOT NULL,
  "evidence_key" text NOT NULL,
  "context_id" text NOT NULL,
  "applicability_kind" text NOT NULL,
  "applicability_key" text,
  "applicability_valid_from" integer,
  "applicability_valid_to" integer,
  "cluster_key" text NOT NULL,
  "candidate_key" text NOT NULL,
  "observed_at" integer NOT NULL,
  "valid_from" integer NOT NULL,
  "valid_to" integer,
  "weight" real DEFAULT 1 NOT NULL
);

CREATE INDEX "fishmem_belief_slot_idx"
  ON "fishmem_belief_evidence" (
    "namespace_id", "user_id", "agent_id", "run_id",
    "subject_key", "attribute_key"
  );
CREATE INDEX "fishmem_belief_source_idx"
  ON "fishmem_belief_evidence" ("source_id");
CREATE INDEX "fishmem_belief_cluster_idx"
  ON "fishmem_belief_evidence" ("cluster_key");
