import { createFileRoute } from "@tanstack/react-router";
import { listMemoryOperations } from "@/lib/server/memory-api";

export const Route = createFileRoute("/v1/operations/")({
  server: {
    handlers: { GET: ({ request }) => listMemoryOperations(request) },
  },
});
