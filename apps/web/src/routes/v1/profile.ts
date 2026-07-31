import { createFileRoute } from "@tanstack/react-router";
import { getMemoryProfile } from "@/lib/server/memory-api";

export const Route = createFileRoute("/v1/profile")({
  server: { handlers: { GET: ({ request }) => getMemoryProfile(request) } },
});
