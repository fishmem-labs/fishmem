import { createFileRoute } from "@tanstack/react-router";
import { listMemoryInferenceEvents } from "@/lib/server/memory-api";

export const Route = createFileRoute("/v1/events/")({
  server: {
    handlers: {
      GET: ({ request }) => listMemoryInferenceEvents(request),
    },
  },
});
