import { createFileRoute } from "@tanstack/react-router";
import { TermsPage } from "@/components/site/terms-page";

export const Route = createFileRoute("/terms")({
  head: () => ({
    meta: [
      { title: "Terms of Service | FishMem" },
      {
        name: "description",
        content:
          "Open-source license and operator responsibilities for self-hosted FishMem.",
      },
    ],
  }),
  component: TermsPage,
});
