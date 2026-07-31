import { createFileRoute } from "@tanstack/react-router";
import { retryMemoryOperation } from "@/lib/server/memory-api";

export const Route = createFileRoute("/v1/operations/$id/retry")({
  server: {
    handlers: {
      POST: ({ request, params }) =>
        retryMemoryOperation(request, params.id),
    },
  },
});
