ALTER TABLE "api_tokens" ADD COLUMN "permissions" text NOT NULL
  DEFAULT '["memory:read","memory:write","operations:read"]';
