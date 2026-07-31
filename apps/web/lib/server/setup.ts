import { user } from "@/db/schema";
import { getRuntimeEnv } from "@/lib/cloudflare";
import { getAppDb } from "@/lib/platform";

/**
 * Whether any account exists yet. `false` means a fresh install — the UI should
 * route to the first-run admin setup wizard (`/setup`) instead of `/login`.
 */
export async function hasAnyUser(): Promise<boolean> {
  const env = await getRuntimeEnv();
  const db = await getAppDb(env);
  const [row] = await db.select({ id: user.id }).from(user).limit(1);
  return Boolean(row);
}
