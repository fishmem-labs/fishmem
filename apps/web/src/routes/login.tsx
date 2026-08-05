import { createFileRoute } from "@tanstack/react-router";
import { Suspense } from "react";
import { AuthPanel } from "@/components/auth/auth-panel";
import { getLoginState } from "@/src/server/route-state.functions";

export const Route = createFileRoute("/login")({
  loader: () => getLoginState(),
  head: () => ({
    meta: [
      { title: "Sign in | FishMem" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: LoginPage,
});

function LoginPage() {
  const { githubAuthEnabled, googleAuthEnabled, magicLinkEnabled } =
    Route.useLoaderData();
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <main className="flex min-h-screen flex-1 items-center justify-center px-4 py-16 md:py-24">
        <Suspense fallback={null}>
          <AuthPanel
            githubAuthEnabled={githubAuthEnabled}
            googleAuthEnabled={googleAuthEnabled}
            magicLinkEnabled={magicLinkEnabled}
          />
        </Suspense>
      </main>
    </div>
  );
}
