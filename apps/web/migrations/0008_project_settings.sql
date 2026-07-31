CREATE TABLE IF NOT EXISTS "project_settings" (
  "id" text PRIMARY KEY NOT NULL,
  "document_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "instructions" text DEFAULT '' NOT NULL,
  "categories" text DEFAULT '["User preferences","Profile facts","Long-term context","Agent instructions"]' NOT NULL,
  "created_at" integer NOT NULL,
  "updated_at" integer NOT NULL,
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces" ("document_id") ON DELETE cascade
);

CREATE UNIQUE INDEX IF NOT EXISTS "project_settings_document_id_unique" ON "project_settings" ("document_id");
CREATE UNIQUE INDEX IF NOT EXISTS "project_settings_workspace_unique" ON "project_settings" ("workspace_id");
