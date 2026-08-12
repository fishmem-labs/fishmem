import { createFileRoute } from "@tanstack/react-router";
import { PrivacyPage } from "@/components/site/privacy-page";
import { PRIVACY_DESCRIPTION } from "@/lib/config";
import { marketingPageHead } from "@/lib/seo";

export const Route = createFileRoute("/privacy")({
  head: () =>
    marketingPageHead({
      title: "Privacy Policy | FishMem",
      description: PRIVACY_DESCRIPTION,
      path: "/privacy",
    }),
  component: PrivacyPage,
});
