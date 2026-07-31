import { createFileRoute } from "@tanstack/react-router";
import { DashboardOverview } from "@/components/dashboard/dashboard-overview";

export const Route = createFileRoute("/dashboard/")({
  component: DashboardOverview,
});
