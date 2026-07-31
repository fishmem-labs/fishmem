CREATE TABLE IF NOT EXISTS "engine_config" (
  "id" text PRIMARY KEY DEFAULT 'default' NOT NULL,
  "embedder_model" text,
  "embedder_base_url" text,
  "embedder_api_key" text,
  "llm_provider" text,
  "llm_model" text,
  "llm_base_url" text,
  "llm_api_key" text,
  "default_mode" text,
  "updated_at" integer
);

-- D1 rejects TEMP tables with SQLITE_AUTH. This short-lived ordinary table
-- keeps the same fail-fast validation inside Wrangler's atomic migration.
CREATE TABLE "__engine_config_mode_guard" (
  "legacy_mode" text CHECK (legacy_mode IS NULL OR legacy_mode IN ('raw', 'hybrid'))
);
INSERT INTO "__engine_config_mode_guard" ("legacy_mode")
SELECT "default_mode" FROM "engine_config";

CREATE TABLE "engine_config_v2" (
  "id" text PRIMARY KEY DEFAULT 'default' NOT NULL,
  "embedder_model" text,
  "embedder_base_url" text,
  "embedder_api_key" text,
  "llm_provider" text,
  "llm_model" text,
  "llm_base_url" text,
  "llm_api_key" text,
  "derivation_enabled" integer DEFAULT 0 NOT NULL,
  "updated_at" integer
);
INSERT INTO "engine_config_v2" (
  "id", "embedder_model", "embedder_base_url", "embedder_api_key",
  "llm_provider", "llm_model", "llm_base_url", "llm_api_key",
  "derivation_enabled", "updated_at"
)
SELECT
  "id", "embedder_model", "embedder_base_url", "embedder_api_key",
  "llm_provider", "llm_model", "llm_base_url", "llm_api_key",
  CASE WHEN default_mode = 'hybrid' THEN 1 ELSE 0 END, "updated_at"
FROM "engine_config";

DROP TABLE "engine_config";
ALTER TABLE "engine_config_v2" RENAME TO "engine_config";
DROP TABLE "__engine_config_mode_guard";

ALTER TABLE "request_logs" DROP COLUMN "credits";
