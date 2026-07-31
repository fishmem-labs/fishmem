"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { fetchAppUser, resolveCurrentWorkspace } from "@/lib/user";

const PROJECT_STORAGE_KEY = "fishmem:selected-project";
const PROJECT_CHANGE_EVENT = "fishmem:project-change";

export function useCurrentUser() {
  const sessionState = authClient.useSession();
  const session = sessionState.data;
  const jwt = session?.session?.token ?? session?.user?.id ?? null;
  const [selectedWorkspaceId, setSelectedWorkspaceIdState] = useState<
    string | null
  >(null);

  useEffect(() => {
    const read = () => {
      setSelectedWorkspaceIdState(localStorage.getItem(PROJECT_STORAGE_KEY));
    };
    read();
    window.addEventListener(PROJECT_CHANGE_EVENT, read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener(PROJECT_CHANGE_EVENT, read);
      window.removeEventListener("storage", read);
    };
  }, []);

  const query = useQuery({
    queryKey: ["current-user", jwt],
    queryFn: () => fetchAppUser(),
    enabled: Boolean(jwt),
    staleTime: 30_000
  });

  const user = query.data ?? null;
  const workspace = resolveCurrentWorkspace(user, selectedWorkspaceId);
  const projects = user?.workspaces ?? [];

  const setWorkspaceId = (workspaceId: string) => {
    localStorage.setItem(PROJECT_STORAGE_KEY, workspaceId);
    setSelectedWorkspaceIdState(workspaceId);
    window.dispatchEvent(new Event(PROJECT_CHANGE_EVENT));
  };

  return {
    session,
    jwt,
    user,
    workspace,
    workspaceId: workspace?.documentId ?? null,
    projects,
    selectedWorkspaceId,
    setWorkspaceId,
    isAuthenticated: Boolean(jwt),
    isLoading: sessionState.isPending || query.isLoading,
    refetch: query.refetch
  };
}
