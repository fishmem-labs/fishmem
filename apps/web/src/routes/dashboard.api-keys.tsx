import { createFileRoute } from "@tanstack/react-router";
import { ApiKeysPage } from "@/components/dashboard/api-keys-page";

export const Route = createFileRoute("/dashboard/api-keys")({
  component: ApiKeysPage,
});
