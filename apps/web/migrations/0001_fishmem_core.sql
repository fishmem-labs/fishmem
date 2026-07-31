CREATE TABLE IF NOT EXISTS "user" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "email" text NOT NULL,
  "emailVerified" integer DEFAULT 0 NOT NULL,
  "image" text,
  "createdAt" integer NOT NULL,
  "updatedAt" integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "user_email_unique" ON "user" ("email");

CREATE TABLE IF NOT EXISTS "session" (
  "id" text PRIMARY KEY NOT NULL,
  "userId" text NOT NULL,
  "token" text NOT NULL,
  "expiresAt" integer NOT NULL,
  "ipAddress" text,
  "userAgent" text,
  "createdAt" integer NOT NULL,
  "updatedAt" integer NOT NULL,
  FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE cascade
);
CREATE UNIQUE INDEX IF NOT EXISTS "session_token_unique" ON "session" ("token");
CREATE INDEX IF NOT EXISTS "session_user_id_idx" ON "session" ("userId");

CREATE TABLE IF NOT EXISTS "account" (
  "id" text PRIMARY KEY NOT NULL,
  "userId" text NOT NULL,
  "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "accessToken" text,
  "refreshToken" text,
  "accessTokenExpiresAt" integer,
  "refreshTokenExpiresAt" integer,
  "scope" text,
  "idToken" text,
  "password" text,
  "createdAt" integer NOT NULL,
  "updatedAt" integer NOT NULL,
  FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE cascade
);
CREATE INDEX IF NOT EXISTS "account_user_id_idx" ON "account" ("userId");
CREATE UNIQUE INDEX IF NOT EXISTS "account_provider_account_unique" ON "account" ("providerId", "accountId");

CREATE TABLE IF NOT EXISTS "verification" (
  "id" text PRIMARY KEY NOT NULL,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expiresAt" integer NOT NULL,
  "createdAt" integer,
  "updatedAt" integer
);

CREATE TABLE IF NOT EXISTS "workspaces" (
  "id" text PRIMARY KEY NOT NULL,
  "document_id" text NOT NULL,
  "owner_id" text NOT NULL,
  "name" text NOT NULL,
  "kind" text DEFAULT 'business' NOT NULL,
  "created_at" integer NOT NULL,
  "updated_at" integer NOT NULL,
  FOREIGN KEY ("owner_id") REFERENCES "user" ("id") ON DELETE cascade
);
CREATE UNIQUE INDEX IF NOT EXISTS "workspaces_document_id_unique" ON "workspaces" ("document_id");
CREATE INDEX IF NOT EXISTS "workspaces_owner_kind_idx" ON "workspaces" ("owner_id", "kind");

CREATE TABLE IF NOT EXISTS "api_tokens" (
  "id" text PRIMARY KEY NOT NULL,
  "document_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "user_id" text NOT NULL,
  "name" text NOT NULL,
  "token_hash" text NOT NULL,
  "masked_token" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "last_used_at" integer,
  "expires_at" integer,
  "revoked_at" integer,
  "created_at" integer NOT NULL,
  "updated_at" integer NOT NULL,
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces" ("document_id") ON DELETE cascade,
  FOREIGN KEY ("user_id") REFERENCES "user" ("id") ON DELETE cascade
);
CREATE UNIQUE INDEX IF NOT EXISTS "api_tokens_document_id_unique" ON "api_tokens" ("document_id");
CREATE UNIQUE INDEX IF NOT EXISTS "api_tokens_token_hash_unique" ON "api_tokens" ("token_hash");
CREATE INDEX IF NOT EXISTS "api_tokens_workspace_idx" ON "api_tokens" ("workspace_id");

CREATE TABLE IF NOT EXISTS "webhook_endpoints" (
  "id" text PRIMARY KEY NOT NULL,
  "document_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "url" text NOT NULL,
  "description" text,
  "enabled" integer DEFAULT 1 NOT NULL,
  "events" text DEFAULT '["task.completed","task.failed"]' NOT NULL,
  "secret" text NOT NULL,
  "created_at" integer NOT NULL,
  "updated_at" integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "webhook_endpoints_document_id_unique" ON "webhook_endpoints" ("document_id");
CREATE INDEX IF NOT EXISTS "webhook_endpoints_workspace_idx" ON "webhook_endpoints" ("workspace_id");

CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
  "id" text PRIMARY KEY NOT NULL,
  "document_id" text NOT NULL,
  "endpoint_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "event_id" text NOT NULL,
  "event_type" text NOT NULL,
  "task_id" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "http_status" integer,
  "error" text,
  "created_at" integer NOT NULL,
  FOREIGN KEY ("endpoint_id") REFERENCES "webhook_endpoints" ("document_id") ON DELETE cascade
);
CREATE UNIQUE INDEX IF NOT EXISTS "webhook_deliveries_document_id_unique" ON "webhook_deliveries" ("document_id");
CREATE INDEX IF NOT EXISTS "webhook_deliveries_endpoint_created_idx" ON "webhook_deliveries" ("endpoint_id", "created_at");
