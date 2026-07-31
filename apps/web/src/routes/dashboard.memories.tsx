import { createFileRoute } from "@tanstack/react-router";
import { MemoriesPage } from "@/components/dashboard/memories-page";

export const Route = createFileRoute("/dashboard/memories")({
  component: MemoriesPage,
});
