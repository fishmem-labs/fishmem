"use client";

import { ArrowRight, Check } from "lucide-react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { EngineConfigForm } from "@/components/dashboard/engine-config-form";
import { authClient } from "@/lib/auth-client";
import { BRAND_NAME } from "@/lib/config";

type Step = "admin" | "provider";

export function SetupForm() {
  const router = useRouter();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>("admin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setError(null);
    if (password.length < 8) {
      setError("Choose a password with at least 8 characters.");
      return;
    }
    setPending(true);
    // Use the better-auth client (not a raw fetch) so the session store updates
    // reactively — the provider step needs the live session to call the API.
    const { error: signUpError } = await authClient.signUp.email({
      email: email.trim().toLowerCase(),
      password,
      name: name.trim() || email.trim(),
      fetchOptions: setupToken
        ? { headers: { "x-fishmem-setup-token": setupToken } }
        : undefined,
    });
    if (signUpError) {
      setError(signUpError.message ?? "Could not create the admin account.");
      setPending(false);
      return;
    }
    setPending(false);
    setStep("provider");
  }

  function finish() {
    void navigate({ to: "/dashboard" });
    void router.invalidate();
  }

  if (step === "provider") {
    return (
      <div className="w-full max-w-[560px] rounded-[10px] border border-[#E7E7E7] bg-white p-6 md:p-8">
        <div className="flex items-center gap-2 text-[13px] text-[#6F6B64]">
          <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-[#181815] text-white">
            <Check className="h-3 w-3" />
          </span>
          Admin account created
        </div>
        <h1 className="mt-4 text-[1.35rem] font-medium tracking-[-0.02em] text-[#1F1F1F]">
          Connect a provider
        </h1>
        <p className="mt-2 text-sm text-[#6F6B64]">
          {BRAND_NAME} needs an embedder to store and recall memories. If you set{" "}
          <code className="rounded bg-[#F3F2EF] px-1 py-0.5 text-[12px]">
            OPENAI_API_KEY
          </code>{" "}
          at deploy time it’s already wired up — review below and continue, or
          point it at any OpenAI-compatible endpoint (Ollama, Together, …).
        </p>
        <div className="mt-6">
          <EngineConfigForm onSaved={finish} />
        </div>
        <div className="mt-6 flex justify-end border-t border-[#EFEEEB] pt-4">
          <button
            className="inline-flex items-center gap-1.5 text-sm font-medium text-[#181815] hover:opacity-70"
            onClick={finish}
            type="button"
          >
            Continue to dashboard
            <ArrowRight className="h-4 w-4" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-[400px] rounded-[10px] border border-[#E7E7E7] bg-white p-6 md:p-8">
      <h1 className="text-[1.35rem] font-medium tracking-[-0.02em] text-[#1F1F1F]">
        Set up {BRAND_NAME}
      </h1>
      <p className="mt-2 text-sm text-[#6F6B64]">
        Create the admin account for this dashboard. This is the first and only
        owner — everyone else joins by invite.
      </p>
      <form className="mt-6 space-y-3" onSubmit={onSubmit}>
        <label className="block">
          <span className="text-sm text-[#514837]">Name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
            placeholder="Your name"
            className="mt-1 w-full rounded-[6px] border border-[#DADADA] px-3 py-2 text-sm outline-none focus:border-[#181815]"
          />
        </label>
        <label className="block">
          <span className="text-sm text-[#514837]">Email</span>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            placeholder="you@example.com"
            className="mt-1 w-full rounded-[6px] border border-[#DADADA] px-3 py-2 text-sm outline-none focus:border-[#181815]"
          />
        </label>
        <label className="block">
          <span className="text-sm text-[#514837]">Password</span>
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            placeholder="At least 8 characters"
            className="mt-1 w-full rounded-[6px] border border-[#DADADA] px-3 py-2 text-sm outline-none focus:border-[#181815]"
          />
        </label>
        <label className="block">
          <span className="text-sm text-[#514837]">
            Setup token{" "}
            <span className="text-[#8C8880]">(production only)</span>
          </span>
          <input
            type="password"
            value={setupToken}
            onChange={(event) => setSetupToken(event.target.value)}
            autoComplete="off"
            placeholder="FISHMEM_SETUP_TOKEN"
            className="mt-1 w-full rounded-[6px] border border-[#DADADA] px-3 py-2 text-sm outline-none focus:border-[#181815]"
          />
        </label>
        {error ? (
          <p className="text-sm text-[#B42318]" role="alert">
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={pending}
          className="w-full rounded-[6px] bg-[#181815] px-4 py-2.5 text-sm font-semibold text-white transition-opacity disabled:opacity-60"
        >
          {pending ? "Creating account..." : "Create admin account"}
        </button>
      </form>
    </div>
  );
}
