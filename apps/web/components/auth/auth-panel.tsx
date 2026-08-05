"use client";

import { Loader2, MailCheck } from "lucide-react";
import { useSearch } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { BrandMark } from "@/components/site/brand-logo";
import { syncAttributionFromLocation } from "@/lib/client-attribution";
import { BRAND_NAME } from "@/lib/config";

const inputClass =
  "auth-email-input h-10 w-full rounded-md border border-border bg-white px-3 text-[14px] outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/30";

function resolveCallbackUrl(value?: string | null) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return "/dashboard";
  }
  return value;
}

function resolveAuthError(value?: string | null) {
  switch (value) {
    case "INVALID_TOKEN":
      return "That sign-in link is invalid or expired. Please request a new one.";
    case "session_expired":
      return "Your session expired. Please sign in again.";
    default:
      return value ? "Sign-in failed. Please try again." : null;
  }
}

async function readErrorMessage(response: Response) {
  const text = await response.text().catch(() => "");
  if (!text) return "Sign-in failed. Please try again.";
  try {
    const payload = JSON.parse(text) as {
      message?: string;
      error?: { message?: string };
    };
    return (
      payload.error?.message ??
      payload.message ??
      "Sign-in failed. Please try again."
    );
  } catch {
    return text;
  }
}

export function AuthPanel({
  magicLinkEnabled,
}: {
  magicLinkEnabled: boolean;
  googleAuthEnabled?: boolean;
  githubAuthEnabled?: boolean;
}) {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const callbackUrl = resolveCallbackUrl(
    typeof search.callbackUrl === "string" ? search.callbackUrl : null,
  );
  const authError = resolveAuthError(
    typeof search.error === "string"
      ? search.error
      : typeof search.reason === "string"
        ? search.reason
        : null,
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordPending, setPasswordPending] = useState(false);
  const [emailPending, setEmailPending] = useState(false);
  const [magicSentEmail, setMagicSentEmail] = useState<string | null>(null);
  const [resetSent, setResetSent] = useState(false);
  const [resetPending, setResetPending] = useState(false);
  const [error, setError] = useState<string | null>(authError);

  const syncAttribution = () => {
    try {
      syncAttributionFromLocation(window.location.search);
    } catch {
      // Attribution is non-critical; never block sign-in.
    }
  };

  const signInWithPassword = async (targetEmail: string, pw: string) => {
    setPasswordPending(true);
    setError(null);
    syncAttribution();
    try {
      const response = await fetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email: targetEmail, password: pw }),
      });
      if (!response.ok) {
        throw new Error(await readErrorMessage(response));
      }
      window.location.assign(callbackUrl);
    } catch (err) {
      setError((err as Error).message);
      setPasswordPending(false);
    }
  };

  const handlePasswordSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const targetEmail = email.trim();
    if (!targetEmail) {
      setError("Enter your email.");
      return;
    }
    if (!password) {
      setError("Enter your password.");
      return;
    }
    void signInWithPassword(targetEmail, password);
  };

  const sendMagicLink = async (targetEmail: string) => {
    setEmailPending(true);
    setError(null);
    syncAttribution();
    try {
      const response = await fetch("/api/auth/sign-in/magic-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          email: targetEmail,
          callbackURL: callbackUrl,
          errorCallbackURL: "/login",
        }),
      });
      if (!response.ok) {
        throw new Error(await readErrorMessage(response));
      }
      setMagicSentEmail(targetEmail);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setEmailPending(false);
    }
  };

  const requestReset = async () => {
    const targetEmail = email.trim();
    if (!targetEmail) {
      setError("Enter your email to receive a reset link.");
      return;
    }
    setResetPending(true);
    setError(null);
    syncAttribution();
    try {
      const response = await fetch("/api/auth/request-password-reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email: targetEmail, redirectTo: "/reset-password" }),
      });
      if (!response.ok) {
        throw new Error(await readErrorMessage(response));
      }
      setResetSent(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setResetPending(false);
    }
  };

  return (
    <div className="w-full max-w-[420px] rounded-xl border border-border bg-card p-8 shadow-[0_24px_56px_rgba(24,24,21,0.06)]">
      <div className="mb-7 flex flex-col items-center text-center">
        <BrandMark className="h-7 w-7" />
        <h1 className="mt-4 text-[1.6rem] font-medium leading-tight tracking-[-0.03em] text-foreground">
          Sign in to {BRAND_NAME}
        </h1>
        <p className="mt-2 text-[13px] text-muted-foreground">
          {magicLinkEnabled
            ? "Sign in with your password or an email link."
            : "Sign in with your email and password."}
        </p>
      </div>

      {magicSentEmail ? (
        <div className="rounded-lg border border-border bg-muted px-4 py-5 text-center">
          <MailCheck className="mx-auto h-5 w-5 text-foreground" />
          <h2 className="mt-3 text-[15px] font-medium text-foreground">
            Check your email
          </h2>
          <p className="mt-1.5 text-[13px] leading-[1.5] text-muted-foreground">
            We sent a sign-in link to{" "}
            <span className="font-medium text-foreground">{magicSentEmail}</span>.
          </p>
          <div className="mt-4 flex items-center justify-center gap-3">
            <button
              className="text-[13px] font-medium text-foreground underline underline-offset-4"
              onClick={() => void sendMagicLink(magicSentEmail)}
              disabled={emailPending}
              type="button"
            >
              {emailPending ? "Sending..." : "Resend link"}
            </button>
            <button
              className="text-[13px] font-medium text-foreground underline underline-offset-4"
              onClick={() => setMagicSentEmail(null)}
              type="button"
            >
              Use password instead
            </button>
          </div>
        </div>
      ) : (
        <>
          {resetSent ? (
            <div className="mb-4 rounded-md border border-border bg-muted px-3 py-2 text-[12px] leading-[1.5] text-muted-foreground">
              If an account exists for that email, we sent a password-reset link.
              On a local or self-hosted install without email, the link is
              printed to the server console.
            </div>
          ) : null}
          <form className="space-y-3" onSubmit={handlePasswordSubmit}>
            <label
              className="block text-[12px] font-medium text-muted-foreground"
              htmlFor="email"
            >
              Email
            </label>
            <input
              autoComplete="email"
              className={inputClass}
              id="email"
              inputMode="email"
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
              type="email"
              value={email}
            />
            <div className="flex items-center justify-between">
              <label
                className="block text-[12px] font-medium text-muted-foreground"
                htmlFor="password"
              >
                Password
              </label>
              <button
                className="text-[12px] font-medium text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground disabled:opacity-60"
                disabled={resetPending}
                onClick={requestReset}
                type="button"
              >
                {resetPending ? "Sending..." : "Forgot password?"}
              </button>
            </div>
            <input
              autoComplete="current-password"
              className={inputClass}
              id="password"
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Your password"
              type="password"
              value={password}
            />
            <button
              className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-primary text-[14px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={passwordPending}
              type="submit"
            >
              {passwordPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : null}
              {passwordPending ? "Signing in..." : "Sign in"}
            </button>
          </form>

          {magicLinkEnabled ? (
            <>
              <div className="my-5 flex items-center gap-3">
                <div className="h-px flex-1 bg-border" />
                <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                  or
                </span>
                <div className="h-px flex-1 bg-border" />
              </div>
              <button
                className="flex h-10 w-full items-center justify-center gap-2 rounded-md border border-border bg-background text-[14px] font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
                disabled={emailPending}
                onClick={() => {
                  const targetEmail = email.trim();
                  if (!targetEmail) {
                    setError("Enter your email to receive a sign-in link.");
                    return;
                  }
                  void sendMagicLink(targetEmail);
                }}
                type="button"
              >
                {emailPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : null}
                {emailPending ? "Sending link..." : "Email me a sign-in link"}
              </button>
            </>
          ) : null}
        </>
      )}

      {error ? (
        <p className="mt-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
