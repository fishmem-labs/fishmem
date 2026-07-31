import { createFileRoute } from "@tanstack/react-router";
import { SourcesPage } from "@/components/dashboard/sources-page";

export const Route = createFileRoute("/dashboard/sources")({
  component: SourcesPage,
});
