import { createFileRoute } from "@tanstack/react-router";
import { getMemoryInferenceEventById } from "@/lib/server/memory-api";

export const Route = createFileRoute("/v1/events/$id")({
  server: {
    handlers: {
      GET: ({ request, params }) =>
        getMemoryInferenceEventById(request, params.id),
    },
  },
});
