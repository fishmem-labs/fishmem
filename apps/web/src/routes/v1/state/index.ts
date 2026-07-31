import { createFileRoute } from "@tanstack/react-router";
import { getMemoryState } from "@/lib/server/memory-api";

export const Route = createFileRoute("/v1/state/")({
  server: { handlers: { GET: ({ request }) => getMemoryState(request) } },
});
