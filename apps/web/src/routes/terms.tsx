import { createFileRoute } from "@tanstack/react-router";
import { TermsPage } from "@/components/site/terms-page";
import { TERMS_DESCRIPTION } from "@/lib/config";
import { marketingPageHead } from "@/lib/seo";

export const Route = createFileRoute("/terms")({
  head: () =>
    marketingPageHead({
      title: "Terms of Service | FishMem",
      description: TERMS_DESCRIPTION,
      path: "/terms",
    }),
  component: TermsPage,
});
