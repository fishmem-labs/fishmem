import { createFileRoute } from "@tanstack/react-router";
import { PrivacyPage } from "@/components/site/privacy-page";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: "Privacy Policy | FishMem" },
      {
        name: "description",
        content:
          "Privacy and data-boundary notice for self-hosted FishMem deployments.",
      },
    ],
  }),
  component: PrivacyPage,
});
