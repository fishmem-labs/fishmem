import { createFileRoute } from "@tanstack/react-router";
import { searchMemories } from "@/lib/server/memory-api";

export const Route = createFileRoute("/v1/memories/search")({
  server: { handlers: { POST: ({ request }) => searchMemories(request) } },
});
