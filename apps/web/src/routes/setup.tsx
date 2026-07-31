import { createFileRoute } from "@tanstack/react-router";
import { SetupForm } from "@/components/auth/setup-form";
import { getSetupState } from "@/src/server/route-state.functions";

export const Route = createFileRoute("/setup")({
  loader: () => getSetupState(),
  head: () => ({
    meta: [
      { title: "Set up admin | FishMem" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: SetupPage,
});

function SetupPage() {
  return (
    <div className="marketing-shell flex min-h-screen flex-col bg-white text-[#181815]">
      <main className="flex min-h-screen flex-1 items-center justify-center px-4 py-16 md:py-24">
        <SetupForm />
      </main>
    </div>
  );
}
