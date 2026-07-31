CREATE TABLE IF NOT EXISTS "request_logs" (
  "id" text PRIMARY KEY NOT NULL,
  "document_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "api_token_id" text,
  "api_token_name" text,
  "endpoint" text NOT NULL,
  "method" text NOT NULL,
  "path" text NOT NULL,
  "operation" text NOT NULL,
  "status" text NOT NULL,
  "http_status" integer NOT NULL,
  "latency_ms" integer,
  "credits" integer DEFAULT 0 NOT NULL,
  "error_code" text,
  "error_message" text,
  "metadata" text,
  "created_at" integer NOT NULL,
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces" ("document_id") ON DELETE cascade,
  FOREIGN KEY ("api_token_id") REFERENCES "api_tokens" ("document_id") ON DELETE set null
);

CREATE UNIQUE INDEX IF NOT EXISTS "request_logs_document_id_unique" ON "request_logs" ("document_id");
CREATE INDEX IF NOT EXISTS "request_logs_workspace_created_idx" ON "request_logs" ("workspace_id", "created_at");
CREATE INDEX IF NOT EXISTS "request_logs_token_created_idx" ON "request_logs" ("api_token_id", "created_at");
CREATE INDEX IF NOT EXISTS "request_logs_operation_created_idx" ON "request_logs" ("operation", "created_at");
