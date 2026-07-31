import { openApiDocument } from "@fishmem/contracts";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/v1/openapi.json")({
  server: { handlers: { GET: () => Response.json(openApiDocument) } },
});
