"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  MemoryInspectorDrawer,
  type DashboardMemoryPatch,
} from "@fishmem/dashboard/memory-workspace";
import { toast } from "sonner";
import {
  toDashboardMemory,
  toDashboardMemoryHistory,
} from "@/components/dashboard/memory-view";
import { useCurrentUser } from "@/hooks/use-user";
import {
  fetchMemoryHistory,
  type MemoryRow,
  updateMemory,
} from "@/lib/memories-api";

/**
 * Web adapter for the shared FishMem memory inspector.
 *
 * Authentication, workspace scoping, cache invalidation, and HTTP transport
 * remain Web concerns; the information architecture is shared with Desktop.
 */
export function MemoryDetailDrawer({
  open,
  memory,
  onClose,
  onPrev,
  onNext,
  hasPrev,
  hasNext,
}: {
  open: boolean;
  memory?: MemoryRow;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  hasPrev: boolean;
  hasNext: boolean;
}) {
  const { jwt, workspaceId } = useCurrentUser();
  const queryClient = useQueryClient();

  const history = useQuery({
    queryKey: ["memory-history", memory?.id, workspaceId],
    queryFn: () =>
      fetchMemoryHistory(jwt ?? "", memory?.id ?? "", workspaceId),
    enabled: Boolean(open && memory?.id && jwt && workspaceId),
  });

  const save = useMutation({
    mutationFn: (patch: DashboardMemoryPatch) =>
      updateMemory(
        jwt ?? "",
        memory?.id ?? "",
        { memory: patch.content, metadata: patch.metadata },
        workspaceId,
      ),
    onSuccess: () => {
      toast.success("Memory updated");
      void queryClient.invalidateQueries({ queryKey: ["memories"] });
      void queryClient.invalidateQueries({ queryKey: ["entity-memories"] });
      void queryClient.invalidateQueries({ queryKey: ["memory-history"] });
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : "Could not update memory",
      );
    },
  });

  return (
    <MemoryInspectorDrawer
      hasNext={hasNext}
      hasPrevious={hasPrev}
      history={(history.data ?? []).map(toDashboardMemoryHistory)}
      historyLoading={history.isLoading}
      memory={memory ? toDashboardMemory(memory) : undefined}
      onClose={onClose}
      onNext={onNext}
      onPrevious={onPrev}
      onSave={async (patch) => {
        await save.mutateAsync(patch);
      }}
      open={open}
    />
  );
}
