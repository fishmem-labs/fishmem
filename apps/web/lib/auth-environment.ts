import type { RuntimeEnv } from "@/lib/cloudflare";

const LOCAL_AUTH_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "[::1]",
]);

/**
 * Detect a real local auth runtime from its public URL. Cloudflare development
 * exposes production-shaped bindings, so NODE_ENV alone cannot tell whether an
 * EMAIL binding is the local emulator or the deployed service.
 */
export function isLocalAuthEnvironment(env: RuntimeEnv): boolean {
  const configuredUrl =
    env.BETTER_AUTH_URL ??
    process.env.BETTER_AUTH_URL ??
    env.NEXT_PUBLIC_SITE_URL ??
    process.env.NEXT_PUBLIC_SITE_URL ??
    env.VITE_SITE_URL ??
    process.env.VITE_SITE_URL;

  if (configuredUrl) {
    try {
      return LOCAL_AUTH_HOSTS.has(new URL(configuredUrl).hostname);
    } catch {
      // Invalid URLs are handled by the auth configuration. Fall through to
      // the conventional development signal here.
    }
  }

  return process.env.NODE_ENV !== "production";
}
