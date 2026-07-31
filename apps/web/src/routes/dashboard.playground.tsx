import { createFileRoute } from "@tanstack/react-router";
import { PlaygroundPage } from "@/components/dashboard/playground-page";

export const Route = createFileRoute("/dashboard/playground")({
  component: PlaygroundPage,
});
