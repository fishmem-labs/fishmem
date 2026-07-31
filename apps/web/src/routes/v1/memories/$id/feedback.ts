import { createFileRoute } from "@tanstack/react-router";
import {
  clearMemoryFeedback,
  getMemoryFeedback,
  setMemoryFeedback,
} from "@/lib/server/memory-api";

export const Route = createFileRoute("/v1/memories/$id/feedback")({
  server: {
    handlers: {
      GET: ({ request, params }) => getMemoryFeedback(request, params.id),
      POST: ({ request, params }) => setMemoryFeedback(request, params.id),
      DELETE: ({ request, params }) => clearMemoryFeedback(request, params.id),
    },
  },
});
