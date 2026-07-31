import { createFileRoute } from "@tanstack/react-router";
import { startOAuth } from "@/lib/server/oauth-start";

export const Route = createFileRoute("/api/github-auth/start")({
  server: {
    handlers: { GET: ({ request }) => startOAuth(request, "github") },
  },
});
