import { createFileRoute } from "@tanstack/react-router";
import { SITE_URL } from "@/lib/config";

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: () =>
        new Response(
          `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${["", "/login", "/privacy", "/terms"].map((path) => `<url><loc>${SITE_URL}${path}</loc></url>`).join("")}</urlset>`,
          { headers: { "content-type": "application/xml; charset=utf-8" } },
        ),
    },
  },
});
