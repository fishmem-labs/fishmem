import { Link, createFileRoute } from "@tanstack/react-router";
import { AcceptInviteForm } from "@/components/auth/accept-invite-form";
import { BRAND_NAME } from "@/lib/config";
import { getInviteState } from "@/src/server/route-state.functions";

export const Route = createFileRoute("/invite/$token")({
  loader: ({ params }) => getInviteState({ data: { token: params.token } }),
  head: () => ({
    meta: [
      { title: "Accept invitation | FishMem" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: InvitePage,
});

function InvitePage() {
  const { email } = Route.useLoaderData();
  return (
    <div className="marketing-shell flex min-h-screen flex-col bg-white text-[#181815]">
      <main className="flex min-h-screen flex-1 items-center justify-center px-4 py-16 md:py-24">
        {email ? (
          <AcceptInviteForm email={email} />
        ) : (
          <div className="w-full max-w-[400px] rounded-[10px] border border-[#E7E7E7] bg-white p-6 text-center md:p-8">
            <h1 className="text-[1.2rem] font-medium tracking-[-0.02em] text-[#1F1F1F]">
              Invitation not valid
            </h1>
            <p className="mt-2 text-sm text-[#6F6B64]">
              This {BRAND_NAME} invite has expired, was already used, or the
              link is incorrect. Ask an admin to send a new one.
            </p>
            <Link
              className="mt-5 inline-block rounded-[6px] border border-[#DADADA] px-4 py-2 text-sm font-medium text-[#181815]"
              to="/login"
            >
              Go to sign in
            </Link>
          </div>
        )}
      </main>
    </div>
  );
}
