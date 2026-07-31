import { createFileRoute } from "@tanstack/react-router";
import { SITE_URL } from "@/lib/config";

export const Route = createFileRoute("/robots.txt")({
  server: {
    handlers: {
      GET: () =>
        new Response(
          `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api\nDisallow: /dashboard\nDisallow: /login\nDisallow: /signin\nDisallow: /magic-link\nDisallow: /profile\nDisallow: /v1\nSitemap: ${SITE_URL}/sitemap.xml\n`,
          { headers: { "content-type": "text/plain; charset=utf-8" } },
        ),
    },
  },
});
