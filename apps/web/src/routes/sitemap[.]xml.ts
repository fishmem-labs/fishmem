import { createFileRoute } from "@tanstack/react-router";
import { getSitemapEntries } from "@/lib/cloud-sitemap";
import { SITE_URL } from "@/lib/config";

function renderSitemap(entries: Array<{ path: string; lastModified?: string }>) {
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries
    .map(
      ({ path, lastModified }) =>
        `<url><loc>${SITE_URL}${path}</loc>${lastModified ? `<lastmod>${lastModified.slice(0, 10)}</lastmod>` : ""}</url>`,
    )
    .join("")}</urlset>`;
}

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: async () => {
        const entries = await getSitemapEntries();
        return new Response(renderSitemap(entries), {
          headers: { "content-type": "application/xml; charset=utf-8" },
        });
      },
    },
  },
});
