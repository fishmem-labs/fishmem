import { createFileRoute } from "@tanstack/react-router";
import { createMemoryExport } from "@/lib/server/memory-api";

export const Route = createFileRoute("/v1/exports")({
  server: { handlers: { POST: ({ request }) => createMemoryExport(request) } },
});
