import { createFileRoute } from "@tanstack/react-router";
import { CreateApiPage } from "@/components/dashboard/create-api-page";

export const Route = createFileRoute("/dashboard/create-api")({
  component: CreateApiPage,
});
