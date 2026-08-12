import { createFileRoute } from "@tanstack/react-router";
import { HomePage } from "@/components/site/home-page";
import { APP_DESCRIPTION, APP_NAME } from "@/lib/config";
import { marketingPageHead } from "@/lib/seo";

export const Route = createFileRoute("/")({
  head: () =>
    marketingPageHead({
      title: APP_NAME,
      description: APP_DESCRIPTION,
      path: "/",
    }),
  component: HomePage,
});
