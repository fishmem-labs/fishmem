"use client";

import { useNavigate, useRouter } from "@tanstack/react-router";
import { authClient } from "@/lib/auth-client";

export function SignOutButton() {
  const router = useRouter();
  const navigate = useNavigate();

  return (
    <button
      type="button"
      onClick={() =>
        authClient.signOut({
          fetchOptions: {
            onSuccess: () => {
              void navigate({ to: "/" });
              void router.invalidate();
            },
          },
        })
      }
      className="hidden h-10 items-center rounded-full bg-zinc-950 px-5 text-sm font-semibold text-white transition hover:bg-zinc-800 sm:inline-flex"
    >
      Sign out
    </button>
  );
}
