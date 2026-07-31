import { createFileRoute } from "@tanstack/react-router";
import { handleAppApi } from "@/lib/server/app-api";

function handle(request: Request) {
  const pathname = new URL(request.url).pathname;
  const suffix = pathname.slice("/api/app/".length);
  return handleAppApi(
    request,
    suffix.split("/").filter(Boolean).map(decodeURIComponent),
  );
}

export const Route = createFileRoute("/api/app/$")({
  server: {
    handlers: {
      GET: ({ request }) => handle(request),
      POST: ({ request }) => handle(request),
      PUT: ({ request }) => handle(request),
      PATCH: ({ request }) => handle(request),
      DELETE: ({ request }) => handle(request),
    },
  },
});
