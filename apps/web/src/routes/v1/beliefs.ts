import { createFileRoute } from "@tanstack/react-router";
import { getMemoryBeliefs } from "@/lib/server/memory-api";

export const Route = createFileRoute("/v1/beliefs")({
  server: { handlers: { GET: ({ request }) => getMemoryBeliefs(request) } },
});
