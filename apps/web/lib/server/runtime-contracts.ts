import type { BeliefReconciler, StateSidecar } from "fishmem";

type ApiTokenAuthState = {
  status: string;
  expiresAt: Date | null;
};

export type ApiTokenAuthFailure = "inactive" | "expired";

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
