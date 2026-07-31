import { createFileRoute } from "@tanstack/react-router";
import { runScheduledMaintenance } from "@/lib/server/maintenance-route";

export const Route = createFileRoute("/api/cron/maintenance")({
  server: {
    handlers: {
      POST: ({ request }) => runScheduledMaintenance(request),
    },
  },
});
