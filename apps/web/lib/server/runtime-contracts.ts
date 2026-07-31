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
) {
  return enabled
    ? ({
        derivation: { enabled: true, schedule: "inline", sidecar },
      } as const)
    : ({} as const);
}
import type { StateSidecar } from "fishmem";
