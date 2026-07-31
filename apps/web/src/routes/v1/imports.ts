import { createFileRoute } from "@tanstack/react-router";
import { createMemoryImport } from "@/lib/server/memory-api";

export const Route = createFileRoute("/v1/imports")({
  server: { handlers: { POST: ({ request }) => createMemoryImport(request) } },
});
