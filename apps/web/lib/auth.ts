import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { getRequest } from "@tanstack/react-start/server";
import { user } from "@/db/schema";
import { baseAuthOptions } from "@/lib/auth-shared";
import { getRuntimeEnv } from "@/lib/cloudflare";
import { getAppDb } from "@/lib/platform";
import { sendResetPasswordEmail } from "@/lib/server/email";
import { firstUserSetupAuthorized } from "@/lib/server/bootstrap-policy";
import { consumeInviteForEmail, findValidInvite } from "@/lib/server/invites";

/**
 * OSS auth: a closed, invite-only control plane. The first account (created via
 * the setup wizard) becomes the admin; everyone else needs a valid invite for
 * their email address. There is NO "cloud vs self-host" flag here — an
 * open-signup deployment (FishMem Cloud) supplies its own `lib/auth.ts` that omits
 * the gate, reusing `lib/auth-shared.ts`.
 */
export async function getAuth() {
  const env = await getRuntimeEnv();
  const db = await getAppDb(env);

  return betterAuth({
    ...baseAuthOptions(env, db),
    emailAndPassword: {
      enabled: true,
      // Forgot-password recovery. Like magic-link, the link is delivered by
      // email when a provider is configured, otherwise printed to the server
      // console (Node self-host / local dev). `redirectTo` lands the user on
      // /reset-password?token=… after better-auth validates the token.
      resetPasswordTokenExpiresIn: 60 * 60, // 1 hour
      sendResetPassword: async ({ user, url }) => {
        await sendResetPasswordEmail({ email: user.email, env, url });
      },
    },
    hooks: {
      before: createAuthMiddleware(async (context) => {
        if (context.path !== "/sign-up/email") return;
        const [existing] = await db
          .select({ id: user.id })
          .from(user)
          .limit(1);
        if (existing) return;

        const authorized = await firstUserSetupAuthorized({
          configuredToken:
            env.FISHMEM_SETUP_TOKEN ?? process.env.FISHMEM_SETUP_TOKEN,
          providedToken:
            context.headers?.get("x-fishmem-setup-token") ?? undefined,
          production: process.env.NODE_ENV === "production",
        });
        if (!authorized) {
          throw new APIError("FORBIDDEN", {
            message:
              "A valid deployment setup token is required to create the first admin.",
          });
        }
      }),
    },
    user: {
      // Self-service account deletion. Deleting the user cascades to their
      // workspaces (workspaces.ownerId → user.id onDelete cascade) and from
      // there to every project setting, memory, request log, and API key.
      deleteUser: { enabled: true },
      additionalFields: {
        // "admin" | "member" — set by the gate below, never by client input.
        role: {
          type: "string",
          required: false,
          defaultValue: "member",
          input: false,
        },
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (newUser) => {
            const [existing] = await db
              .select({ id: user.id })
              .from(user)
              .limit(1);
            if (!existing) {
              // First account ever → the admin.
              return { data: { ...newUser, role: "admin" } };
            }
            const invite = await findValidInvite(db, newUser.email);
            if (invite) {
              return { data: { ...newUser, role: invite.role } };
            }
            throw new APIError("FORBIDDEN", {
              message:
                "This dashboard is invite-only. Ask an admin for an invite.",
            });
          },
          after: async (createdUser) => {
            // Mark the matching invite consumed (no-op for the admin).
            await consumeInviteForEmail(db, createdUser.email, createdUser.id);
          },
        },
      },
    },
  });
}

export async function auth() {
  const authInstance = await getAuth();
  const result = await authInstance.api.getSession({
    headers: getRequest().headers,
  });

  if (!result) {
    return null;
  }

  return {
    user: {
      id: result.user.id,
      email: result.user.email,
      name: result.user.name,
      image: result.user.image ?? undefined,
      jwt: result.session.token,
      isNew: false,
    },
    expires: new Date(result.session.expiresAt).toISOString(),
  };
}

export async function authHandler(request: Request) {
  const authInstance = await getAuth();
  return authInstance.handler(request);
}
