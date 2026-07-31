import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/magic-link")({
  server: {
    handlers: {
      GET: ({ request }) => {
        const source = new URL(request.url);
        const target = new URL("/login", source.origin);
        target.searchParams.set("error", "magic_link_disabled");
        const callback = source.searchParams.get("callbackUrl");
        const response = Response.redirect(target, 302);
        response.headers.set(
          "x-callback-url",
          callback?.startsWith("/") && !callback.startsWith("//")
            ? callback
            : "/dashboard",
        );
        return response;
      },
    },
  },
});
