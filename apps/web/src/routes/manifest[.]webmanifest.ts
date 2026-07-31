import { createFileRoute } from "@tanstack/react-router";
import {
  APP_DESCRIPTION,
  APP_NAME,
  BRAND_SHORT_NAME,
} from "@/lib/config";

export const Route = createFileRoute("/manifest.webmanifest")({
  server: {
    handlers: {
      GET: () =>
        Response.json({
          name: APP_NAME,
          short_name: BRAND_SHORT_NAME,
          description: APP_DESCRIPTION,
          start_url: "/",
          scope: "/",
          display: "standalone",
          background_color: "#ffffff",
          theme_color: "#ffffff",
          icons: [
            {
              src: "/web-app-manifest-192x192.png",
              sizes: "192x192",
              type: "image/png",
            },
            {
              src: "/web-app-manifest-512x512.png",
              sizes: "512x512",
              type: "image/png",
            },
          ],
        }),
    },
  },
});
