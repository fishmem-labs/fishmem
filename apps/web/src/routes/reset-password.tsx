import { createFileRoute } from "@tanstack/react-router";
import { Suspense } from "react";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";

export const Route = createFileRoute("/reset-password")({
  head: () => ({
    meta: [
      { title: "Reset password | FishMem" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: () => (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <main className="flex min-h-screen flex-1 items-center justify-center px-4 py-16 md:py-24">
        <Suspense fallback={null}>
          <ResetPasswordForm />
        </Suspense>
      </main>
    </div>
  ),
});
