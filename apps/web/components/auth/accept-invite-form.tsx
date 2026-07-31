"use client";

import { useNavigate, useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { BRAND_NAME } from "@/lib/config";

export function AcceptInviteForm({ email }: { email: string }) {
  const router = useRouter();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
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
    try {
      const res = await fetch("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          password,
          name: name.trim() || email,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          message?: string;
        };
        throw new Error(data.message ?? "Could not accept the invitation.");
      }
      await navigate({ to: "/dashboard" });
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setPending(false);
    }
  }

  return (
    <div className="w-full max-w-[400px] rounded-[10px] border border-[#E7E7E7] bg-white p-6 md:p-8">
      <h1 className="text-[1.35rem] font-medium tracking-[-0.02em] text-[#1F1F1F]">
        Join {BRAND_NAME}
      </h1>
      <p className="mt-2 text-sm text-[#6F6B64]">
        You were invited as <span className="font-medium">{email}</span>. Set a
        password to finish creating your account.
      </p>
      <form className="mt-6 space-y-3" onSubmit={onSubmit}>
        <label className="block">
          <span className="text-sm text-[#514837]">Email</span>
          <input
            type="email"
            value={email}
            readOnly
            className="mt-1 w-full cursor-not-allowed rounded-[6px] border border-[#EFEFEF] bg-[#FAFAFA] px-3 py-2 text-sm text-[#6F6B64]"
          />
        </label>
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
          {pending ? "Creating account..." : "Accept invitation"}
        </button>
      </form>
    </div>
  );
}
