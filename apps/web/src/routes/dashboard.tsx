import { Outlet, createFileRoute } from "@tanstack/react-router";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { requireDashboardSession } from "@/src/server/route-state.functions";

export const Route = createFileRoute("/dashboard")({
  beforeLoad: () => requireDashboardSession(),
  head: () => ({
    meta: [{ name: "robots", content: "noindex,nofollow" }],
  }),
  component: () => (
    <DashboardShell>
      <Outlet />
    </DashboardShell>
  ),
});
