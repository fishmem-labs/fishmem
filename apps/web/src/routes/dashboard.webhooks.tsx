import { createFileRoute } from "@tanstack/react-router";
import { WebhooksPage } from "@/components/dashboard/webhooks-page";

export const Route = createFileRoute("/dashboard/webhooks")({
  component: WebhooksPage,
});
