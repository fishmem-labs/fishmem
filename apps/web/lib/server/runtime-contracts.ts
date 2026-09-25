import type { BeliefReconciler, StateSidecar } from "fishmem";

type ApiTokenAuthState = {
  status: string;
  expiresAt: Date | null;
};

export type ApiTokenAuthFailure = "inactive" | "expired";

export function apiPermissionForRequest(request: Request) {
  const path = new URL(request.url).pathname.replace(/\/+$/, "");
  const method = request.method.toUpperCase();
  if ((method === "GET" || method === "HEAD") &&
    (path.startsWith("/v1/operations/") || path === "/v1/operations" || path.startsWith("/v1/events/") || path === "/v1/health")) {
    return "operations:read";
  }
  if (method === "POST" && (path === "/v1/memories/search" || path === "/v1/documents/search")) return "memory:read";
  return ["POST", "PUT", "PATCH", "DELETE"].includes(method) ? "memory:write" : "memory:read";
}

export function apiTokenAuthFailure(
  token: ApiTokenAuthState,
  now = new Date(),
): ApiTokenAuthFailure | null {
  if (token.status !== "active") return "inactive";
  if (token.expiresAt && token.expiresAt.getTime() <= now.getTime()) {
    return "expired";
  }
  return null;
}

export function memoryDerivationConfig(
  enabled: boolean,
  sidecar?: StateSidecar,
  beliefReconciler?: BeliefReconciler,
) {
  const beliefEnabled =
    process.env.FISHMEM_BELIEF_RECONCILIATION_ENABLED === "1";
  const namespaceAllowlist = (
    process.env.FISHMEM_BELIEF_RECONCILIATION_ALLOWLIST ?? ""
  )
    .split(",")
    .map((namespaceId) => namespaceId.trim())
    .filter(Boolean);
  return enabled
    ? ({
        derivation: {
          enabled: true,
          schedule: "inline",
          sidecar,
          ...(beliefEnabled
            ? {
                beliefs: {
                  enabled: true,
                  namespaceAllowlist,
                  ...(beliefReconciler
                    ? { reconciler: beliefReconciler }
                    : {}),
                  killSwitch: () =>
                    process.env.FISHMEM_BELIEF_RECONCILIATION_DISABLED === "1",
                },
              }
            : {}),
        },
      } as const)
    : ({} as const);
}

type EnvLookup = Record<string, string | undefined>;

function optionalNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  // Malformed values are passed through as NaN so the engine's config
  // validation fails the boot loudly instead of silently using a default.
  return Number(value);
}

/**
 * Deployment-level write features that are default-off in the engine and are
 * deliberately NOT public request fields. Every flag must be exactly "1".
 *
 * - `FISHMEM_RECONCILE=1`: opt-in write-time reconcile (one extra embedding
 *   per inferred add; decisions ride in the same single extraction call).
 *   `FISHMEM_RECONCILE_CANDIDATES` / `FISHMEM_RECONCILE_MIN_SCORE` tune it.
 * - `FISHMEM_EPISODES_ARCHIVE=1`: retain the raw role-preserving transcript
 *   of each add as an Episode (different privacy/retention contract).
 * - `FISHMEM_EPISODES_SEARCHABLE=1`: additionally index Episodes for
 *   search; implies archiving. Together these reproduce the configuration
 *   used by the published benchmark runs.
 *
 * Returns `{}` when nothing is enabled so the default engine config is
 * unchanged.
 */
export function memoryWriteFeatureConfig(env: EnvLookup = {}) {
  const read = (key: string) => env[key] ?? process.env[key];
  const flag = (key: string) => read(key) === "1";
  const reconcileEnabled = flag("FISHMEM_RECONCILE");
  const searchable = flag("FISHMEM_EPISODES_SEARCHABLE");
  const archive = searchable || flag("FISHMEM_EPISODES_ARCHIVE");
  const candidates = optionalNumber(read("FISHMEM_RECONCILE_CANDIDATES"));
  const minScore = optionalNumber(read("FISHMEM_RECONCILE_MIN_SCORE"));
  return {
    ...(reconcileEnabled
      ? {
          reconcile: {
            enabled: true,
            ...(candidates !== undefined ? { candidates } : {}),
            ...(minScore !== undefined ? { minScore } : {}),
          },
        }
      : {}),
    ...(archive ? { episodes: { archive: true, searchable } } : {}),
  };
}
