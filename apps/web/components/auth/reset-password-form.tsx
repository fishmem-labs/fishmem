"use client";

import { CircleCheck, Loader2 } from "lucide-react";
import { useSearch } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { BrandMark } from "@/components/site/brand-logo";
import { BRAND_NAME } from "@/lib/config";

const inputClass =
  "h-10 w-full rounded-md border border-border bg-background px-3 text-[14px] text-foreground outline-none transition placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/30";

const MIN_PASSWORD_LENGTH = 8;

async function readErrorMessage(response: Response) {
  const text = await response.text().catch(() => "");
  if (!text) return "Could not reset your password. Please try again.";
  try {
    const payload = JSON.parse(text) as {
      message?: string;
      error?: { message?: string };
    };
    return (
      payload.error?.message ??
      payload.message ??
      "Could not reset your password. Please try again."
    );
  } catch {
    return text;
  }
}

export function ResetPasswordForm() {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const token = typeof search.token === "string" ? search.token : null;
  const linkError = typeof search.error === "string" ? search.error : null;
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const invalidLink = !token || linkError === "INVALID_TOKEN";

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!token) return;
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ newPassword: password, token }),
      });
      if (!response.ok) {
        throw new Error(await readErrorMessage(response));
      }
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="w-full max-w-[420px] rounded-xl border border-border bg-card p-8 shadow-[0_24px_56px_rgba(24,24,21,0.06)]">
      <div className="mb-7 flex flex-col items-center text-center">
        <BrandMark className="h-7 w-7" />
        <h1 className="mt-4 text-[1.6rem] font-medium leading-tight tracking-[-0.03em] text-foreground">
          {done ? "Password updated" : "Set a new password"}
        </h1>
        <p className="mt-2 text-[13px] text-muted-foreground">
          {done
            ? `You can now sign in to ${BRAND_NAME} with your new password.`
            : invalidLink
              ? "This reset link is invalid or has expired."
              : "Choose a new password for your account."}
        </p>
      </div>

      {done ? (
        <div className="rounded-lg border border-border bg-muted px-4 py-5 text-center">
          <CircleCheck className="mx-auto h-5 w-5 text-success" />
          <a
            className="mt-4 inline-flex h-10 items-center justify-center rounded-md bg-primary px-5 text-[14px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            href="/login"
          >
            Continue to sign in
          </a>
        </div>
      ) : invalidLink ? (
        <a
          className="flex h-10 w-full items-center justify-center rounded-md border border-border bg-background text-[14px] font-medium text-foreground transition-colors hover:bg-accent"
          href="/login"
        >
          Request a new link
        </a>
      ) : (
        <form className="space-y-3" onSubmit={handleSubmit}>
          <label
            className="block text-[12px] font-medium text-muted-foreground"
            htmlFor="new-password"
          >
            New password
          </label>
          <input
            autoComplete="new-password"
            autoFocus
            className={inputClass}
            id="new-password"
            onChange={(event) => setPassword(event.target.value)}
            placeholder="At least 8 characters"
            type="password"
            value={password}
          />
          <label
            className="block text-[12px] font-medium text-muted-foreground"
            htmlFor="confirm-password"
          >
            Confirm password
          </label>
          <input
            autoComplete="new-password"
            className={inputClass}
            id="confirm-password"
            onChange={(event) => setConfirm(event.target.value)}
            placeholder="Re-enter your new password"
            type="password"
            value={confirm}
          />
          <button
            className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-primary text-[14px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={pending}
            type="submit"
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {pending ? "Updating..." : "Update password"}
          </button>
        </form>
      )}

      {error ? (
        <p className="mt-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
