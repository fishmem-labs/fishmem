import { createFileRoute } from "@tanstack/react-router";
import { RequestsPage } from "@/components/dashboard/requests-page";

export const Route = createFileRoute("/dashboard/requests")({
  component: RequestsPage,
});
