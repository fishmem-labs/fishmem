import { Navigate } from "@tanstack/react-router";

export function HomePage() {
  return <Navigate to="/dashboard" replace />;
}
