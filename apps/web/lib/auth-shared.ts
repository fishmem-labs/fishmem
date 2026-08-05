import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { magicLink } from "better-auth/plugins";
import { schema } from "@/db";
import { isLocalAuthEnvironment } from "@/lib/auth-environment";
import type { RuntimeEnv } from "@/lib/cloudflare";
import { type AppDatabase, IS_CLOUDFLARE } from "@/lib/platform";
import { sendMagicLinkEmail } from "@/lib/server/email";

/**
 * Runtime-agnostic building blocks for the better-auth instance, shared by the
 * OSS assembly (`lib/auth.ts`, closed/invite-only) and any deployment that
 * supplies its own assembly (e.g. the Cloud's open-signup build). These
 * helpers know nothing about open vs closed signup — that policy lives in the
 * assembling file, so the commercial app can replace it without duplicating this.
 */

const googleOAuthScopes = ["openid", "email", "profile"];

export function resolveSecret(env: RuntimeEnv) {
  return (
    env.BETTER_AUTH_SECRET ??
    process.env.BETTER_AUTH_SECRET ??
    process.env.AUTH_SECRET ??
    (process.env.NODE_ENV === "development"
      ? "fishmem-local-dev-secret-minimum-32-chars"
      : undefined)
  );
}

export function resolveBaseUrl(env: RuntimeEnv) {
  return (
    env.BETTER_AUTH_URL ??
    process.env.BETTER_AUTH_URL ??
    env.NEXT_PUBLIC_SITE_URL ??
    process.env.NEXT_PUBLIC_SITE_URL ??
    (process.env.NODE_ENV === "development"
      ? "http://localhost:3000"
      : undefined)
  );
}

export function resolveTrustedOrigins(env: RuntimeEnv) {
  return Array.from(
    new Set(
      [
        resolveBaseUrl(env),
        env.NEXT_PUBLIC_SITE_URL,
        process.env.NEXT_PUBLIC_SITE_URL,
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "https://fishmem.com",
      ].filter((value): value is string => Boolean(value)),
    ),
  );
}

export function resolveTrustedIpHeaders(env: RuntimeEnv): string[] {
  const configured =
    env.FISHMEM_TRUSTED_IP_HEADERS ??
    process.env.FISHMEM_TRUSTED_IP_HEADERS;
  if (configured) {
    const headers = configured
      .split(",")
      .map((header) => header.trim().toLowerCase())
      .filter((header) => /^[a-z0-9-]+$/.test(header));
    if (headers.length) return [...new Set(headers)];
  }
  // Cloudflare overwrites CF-Connecting-IP at the edge. Node deployments must
  // sit behind a reverse proxy that overwrites X-Forwarded-For.
  return IS_CLOUDFLARE ? ["cf-connecting-ip"] : ["x-forwarded-for"];
}

export function buildSocialProviders(env: RuntimeEnv) {
  const googleClientId = env.GOOGLE_CLIENT_ID ?? process.env.GOOGLE_CLIENT_ID;
  const googleClientSecret =
    env.GOOGLE_CLIENT_SECRET ?? process.env.GOOGLE_CLIENT_SECRET;
  const githubClientId = env.GITHUB_CLIENT_ID ?? process.env.GITHUB_CLIENT_ID;
  const githubClientSecret =
    env.GITHUB_CLIENT_SECRET ?? process.env.GITHUB_CLIENT_SECRET;

  return {
    ...(googleClientId && googleClientSecret
      ? {
          google: {
            clientId: googleClientId,
            clientSecret: googleClientSecret,
            disableDefaultScope: true,
            scope: googleOAuthScopes,
          },
        }
      : {}),
    ...(githubClientId && githubClientSecret
      ? {
          github: {
            clientId: githubClientId,
            clientSecret: githubClientSecret,
          },
        }
      : {}),
  };
}

/**
 * Whether magic-link email can actually be delivered — Resend (any runtime) or
 * a Cloudflare EMAIL binding. Magic-link sign-in is only offered when this is
 * true; otherwise password is the only email path.
 */
export function emailConfigured(env: RuntimeEnv): boolean {
  const provider = env.FISHMEM_EMAIL ?? process.env.FISHMEM_EMAIL;
  const resendKey = env.RESEND_API_KEY ?? process.env.RESEND_API_KEY;
  return (
    provider === "resend" || Boolean(resendKey) || Boolean(env.EMAIL?.send)
  );
}

export function loginMethodAvailability(env: RuntimeEnv) {
  const providers = buildSocialProviders(env);
  return {
    googleAuthEnabled: "google" in providers,
    githubAuthEnabled: "github" in providers,
    magicLinkEnabled: emailConfigured(env) || isLocalAuthEnvironment(env),
  };
}

/**
 * The common better-auth options every assembly shares: secret, base URL,
 * trusted origins, the drizzle database, and — only when email can be delivered
 * — the magic-link plugin. Social providers and the signup policy are added by
 * the assembling file (OSS: password + invite gate, no OAuth; Cloud: + OAuth,
 * open signup).
 */
export function baseAuthOptions(env: RuntimeEnv, db: AppDatabase) {
  return {
    secret: resolveSecret(env),
    baseURL: resolveBaseUrl(env),
    trustedOrigins: resolveTrustedOrigins(env),
    advanced: {
      ipAddress: {
        ipAddressHeaders: resolveTrustedIpHeaders(env),
      },
    },
    account: {
      storeStateStrategy: "database" as const,
      skipStateCookieCheck: true,
    },
    database: drizzleAdapter(db, { provider: "sqlite" as const, schema }),
    // Magic-link is offered when email can be delivered (Resend / CF binding),
    // OR in local dev — where there is no email infra, so the link is printed
    // to the server console (see sendMagicLinkEmail).
    plugins:
      emailConfigured(env) || isLocalAuthEnvironment(env)
        ? [
            magicLink({
              expiresIn: 10 * 60,
              sendMagicLink: async ({ email, url }) => {
                await sendMagicLinkEmail({ email, env, url });
              },
            }),
          ]
        : [],
  };
}
