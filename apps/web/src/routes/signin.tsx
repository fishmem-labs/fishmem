import { createFileRoute } from "@tanstack/react-router";
import { LoginRouteView } from "@/src/routes/views/-login-route-view";

export const Route = createFileRoute("/signin")({
  component: LoginRouteView,
});
