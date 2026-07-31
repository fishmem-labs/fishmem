import { createFileRoute } from "@tanstack/react-router";
import { OperationsPage } from "@/components/dashboard/operations-page";

export const Route = createFileRoute("/dashboard/operations")({
  component: OperationsPage,
});
