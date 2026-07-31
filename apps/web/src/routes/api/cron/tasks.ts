import { createFileRoute } from "@tanstack/react-router";
import { runPendingOperationTasks } from "@/lib/server/maintenance-route";

export const Route = createFileRoute("/api/cron/tasks")({
  server: {
    handlers: {
      POST: ({ request }) => runPendingOperationTasks(request),
    },
  },
});
