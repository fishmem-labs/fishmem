import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { invites } from "@/db/schema";
import type { AppDatabase } from "@/lib/platform";

/**
 * Invitations for the closed-signup (self-host) model. An admin mints an
 * email-pinned invite; the invitee registers with that email (via /invite/<token>
 * with a password, or by OAuth/magic-link using the invited address). The auth
 * gate (lib/auth.ts) allows a signup only when a valid invite exists for the
 * email, then this marks it consumed.
 */

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export type InviteRole = "admin" | "member";

function genToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export async function createInvite(
  db: AppDatabase,
  opts: { email: string; role?: InviteRole; invitedBy?: string | null },
) {
  const now = new Date();
  const row = {
    id: `inv_${crypto.randomUUID().replace(/-/g, "")}`,
    token: genToken(),
    email: normalizeEmail(opts.email),
    role: opts.role ?? "member",
    invitedBy: opts.invitedBy ?? null,
    createdAt: now,
    expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
    acceptedAt: null,
    acceptedUserId: null,
  };
  await db.insert(invites).values(row);
  return row;
}

export async function findInviteByToken(db: AppDatabase, token: string) {
  const [row] = await db
    .select()
    .from(invites)
    .where(eq(invites.token, token))
    .limit(1);
  return row ?? null;
}

/** A still-usable (unaccepted, unexpired) invite for this email, or null. */
export async function findValidInvite(db: AppDatabase, email: string) {
  const [row] = await db
    .select()
    .from(invites)
    .where(
      and(
        eq(invites.email, normalizeEmail(email)),
        isNull(invites.acceptedAt),
        gt(invites.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return row ?? null;
}

export function inviteUsable(invite: {
  acceptedAt: Date | null;
  expiresAt: Date;
}) {
  return !invite.acceptedAt && invite.expiresAt.getTime() > Date.now();
}

/** Mark the valid invite for this email as accepted (no-op if none). */
export async function consumeInviteForEmail(
  db: AppDatabase,
  email: string,
  userId: string,
) {
  const invite = await findValidInvite(db, email);
  if (!invite) return;
  await db
    .update(invites)
    .set({ acceptedAt: new Date(), acceptedUserId: userId })
    .where(eq(invites.id, invite.id));
}

export async function listInvites(db: AppDatabase) {
  return db.select().from(invites).orderBy(desc(invites.createdAt));
}

export async function revokeInvite(db: AppDatabase, id: string) {
  await db
    .delete(invites)
    .where(and(eq(invites.id, id), isNull(invites.acceptedAt)));
}

/** Change the role of a still-pending invite (no-op once accepted). */
export async function setInviteRole(
  db: AppDatabase,
  id: string,
  role: InviteRole,
) {
  await db
    .update(invites)
    .set({ role })
    .where(and(eq(invites.id, id), isNull(invites.acceptedAt)));
}
