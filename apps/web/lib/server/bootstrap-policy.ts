import { hasAnyUser } from "@/lib/server/setup";

/**
 * Self-hosted FishMem needs a first-user setup wizard. Hosted deployments
 * override this policy because their auth assembly supports open signup.
 */
export async function requiresFirstUserSetup(): Promise<boolean> {
  return !(await hasAnyUser());
}

async function constantTimeTokenMatch(
  configured: string,
  provided: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const [configuredDigest, providedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(configured)),
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
  ]);
  const configuredBytes = new Uint8Array(configuredDigest);
  const providedBytes = new Uint8Array(providedDigest);
  let difference = 0;
  for (let index = 0; index < configuredBytes.length; index += 1) {
    difference |= configuredBytes[index] ^ providedBytes[index];
  }
  return difference === 0;
}

/**
 * Production self-hosts must prove possession of a deploy-time bootstrap
 * token before creating the first admin. Local development remains convenient
 * when no token is configured.
 */
export async function firstUserSetupAuthorized({
  configuredToken,
  providedToken,
  production,
}: {
  configuredToken?: string;
  providedToken?: string;
  production: boolean;
}): Promise<boolean> {
  if (!configuredToken) return !production;
  return constantTimeTokenMatch(configuredToken, providedToken ?? "");
}
