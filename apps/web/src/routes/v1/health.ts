import { createFileRoute } from "@tanstack/react-router";
import { getMemoryHealth } from "@/lib/server/memory-api";

export const Route = createFileRoute("/v1/health")({
  server: {
    handlers: { GET: ({ request }) => getMemoryHealth(request) },
  },
});
