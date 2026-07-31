ALTER TABLE "user" ADD COLUMN "role" text DEFAULT 'member' NOT NULL;
CREATE TABLE IF NOT EXISTS "invites" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"email" text,
	"role" text DEFAULT 'member' NOT NULL,
	"invited_by" text,
	"created_at" integer NOT NULL,
	"expires_at" integer NOT NULL,
	"accepted_at" integer,
	"accepted_user_id" text
);
CREATE UNIQUE INDEX IF NOT EXISTS "invites_token_unique" ON "invites" ("token");
