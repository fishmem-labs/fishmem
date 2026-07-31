import { and, eq } from "drizzle-orm";
import { workspaces, user as userTable } from "@/db/schema";
import { auth } from "@/lib/auth";
import { getRuntimeEnv } from "@/lib/cloudflare";
import { getAppDb } from "@/lib/platform";
import type { AppDb } from "@/db";
import type { AppUser, AppWorkspace } from "@/lib/user";

function now() {
  return new Date();
}

function workspaceId(userId: string) {
  return `ws_${userId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 24) || crypto.randomUUID()}`;
}

function projectId() {
  return `prj_${crypto.randomUUID().replace(/-/g, "")}`;
}

function toProjectName(name: string) {
  return name.replace(/\bworkspace\b/gi, "project");
}

export function toWorkspace(row: typeof workspaces.$inferSelect): AppWorkspace {
  return {
    id: row.id,
    documentId: row.documentId,
    name: toProjectName(row.name),
    kind: row.kind,
    owner: row.ownerId,
  };
}

export async function getServerDb() {
  const env = await getRuntimeEnv();
  return getAppDb(env);
}

export async function ensureDefaultWorkspace(
  db: AppDb,
  user: { id: string; email: string; name?: string | null },
  kind: "business" | "personal" = "business",
) {
  const existing = await db
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.ownerId, user.id), eq(workspaces.kind, kind)))
    .get();

  if (existing) {
    return existing;
  }

  const id = workspaceId(user.id);
  const createdAt = now();
  const [created] = await db
    .insert(workspaces)
    .values({
      id,
      documentId: id,
      ownerId: user.id,
      name: "first project",
      kind,
      createdAt,
      updatedAt: createdAt,
    })
    .returning();

  return created;
}

export async function createProjectForUser({
  db,
  name,
  userId,
  description = "",
}: {
  db: AppDb;
  name: string;
  userId: string;
  description?: string;
}) {
  const id = projectId();
  const createdAt = now();
  const [created] = await db
    .insert(workspaces)
    .values({
      id,
      documentId: id,
      ownerId: userId,
      name: name.trim().slice(0, 80) || "Untitled project",
      description: description.trim().slice(0, 280),
      kind: "business",
      createdAt,
      updatedAt: createdAt,
    })
    .returning();

  return created;
}

export async function getCurrentAppUser() {
  const session = await auth();
  if (!session?.user?.id || !session.user.email) {
    return null;
  }

  const db = await getServerDb();
  const workspace = await ensureDefaultWorkspace(db, {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
  });
  const workspaceRows = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.ownerId, session.user.id))
    .all();
  const appWorkspaces = workspaceRows.map(toWorkspace);
  const defaultWorkspace =
    appWorkspaces.find((item) => item.documentId === workspace.documentId) ??
    appWorkspaces[0];

  const [row] = await db
    .select({ role: userTable.role })
    .from(userTable)
    .where(eq(userTable.id, session.user.id))
    .limit(1);

  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    username: session.user.email.split("@")[0],
    avatar: session.user.image ?? null,
    role: row?.role ?? null,
    workspaces: appWorkspaces,
    defaultWorkspace: defaultWorkspace?.documentId ?? null,
  } satisfies AppUser;
}

export async function updateCurrentAppUser(input: { name?: string }) {
  const session = await auth();
  if (!session?.user?.id) {
    return null;
  }

  const db = await getServerDb();
  if (input.name?.trim()) {
    await db
      .update(userTable)
      .set({ name: input.name.trim(), updatedAt: now() })
      .where(eq(userTable.id, session.user.id));
  }

  return getCurrentAppUser();
}
