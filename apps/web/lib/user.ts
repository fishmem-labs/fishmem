import { appApiPath } from "@/lib/config";

export type AppWorkspace = {
  id?: number | string;
  documentId: string;
  name: string;
  description?: string;
  kind?: "personal" | "team" | "business" | string | null;
  owner?: number | string;
};

export type AppUser = {
  id: number | string;
  email: string;
  name?: string | null;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  avatar?: string | number | null;
  /** "admin" | "member" — closed-signup self-host role; null/undefined elsewhere. */
  role?: string | null;
  workspaces?: AppWorkspace[];
  defaultWorkspace?: string | null;
};

export async function fetchAppUser(): Promise<AppUser | null> {
  const response = await fetch(appApiPath("/users/me"), {
    credentials: "include",
    cache: "no-store",
  }).catch(() => null);

  if (!response?.ok) {
    return null;
  }

  const payload = (await response.json()) as { data?: AppUser };
  return payload.data ?? null;
}

export function resolveCurrentWorkspace(
  user?: AppUser | null,
  preferredWorkspaceId?: string | null,
) {
  if (!user?.workspaces?.length) {
    return null;
  }
  if (preferredWorkspaceId) {
    const preferredWorkspace = user.workspaces.find(
      (workspace) => workspace.documentId === preferredWorkspaceId,
    );
    if (preferredWorkspace) {
      return preferredWorkspace;
    }
  }
  const defaultWorkspace = user.workspaces.find(
    (workspace) => workspace.documentId === user.defaultWorkspace,
  );
  if (defaultWorkspace?.kind === "business") {
    return defaultWorkspace;
  }
  return (
    user.workspaces.find((workspace) => workspace.kind === "business") ??
    defaultWorkspace ??
    user.workspaces[0]
  );
}
