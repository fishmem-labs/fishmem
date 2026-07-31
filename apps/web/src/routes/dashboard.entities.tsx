import { createFileRoute } from "@tanstack/react-router";
import { EntitiesPage } from "@/components/dashboard/entities-page";

export const Route = createFileRoute("/dashboard/entities")({
  component: EntitiesPage,
});
