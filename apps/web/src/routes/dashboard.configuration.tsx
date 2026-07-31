import { createFileRoute } from "@tanstack/react-router";
import { EngineConfigForm } from "@/components/dashboard/engine-config-form";
import { PageShell } from "@fishmem/dashboard/page-shell";

export const Route = createFileRoute("/dashboard/configuration")({
  component: () => (
    <PageShell
      title="Configuration"
      description="Instance-level engine setup for providers, derived state, and stores. Admin-only; changes hot-reload the engine."
    >
      <EngineConfigForm />
    </PageShell>
  ),
});
