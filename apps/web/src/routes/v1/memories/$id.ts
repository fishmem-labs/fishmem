import { createFileRoute } from "@tanstack/react-router";
import {
  deleteMemoryById,
  getMemoryById,
  updateMemoryById,
} from "@/lib/server/memory-api";

export const Route = createFileRoute("/v1/memories/$id")({
  server: {
    handlers: {
      GET: ({ request, params }) => getMemoryById(request, params.id),
      PUT: ({ request, params }) => updateMemoryById(request, params.id),
      DELETE: ({ request, params }) => deleteMemoryById(request, params.id),
    },
  },
});
