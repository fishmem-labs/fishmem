import { BRAND_CONTACT_EMAIL, BRAND_NAME } from "@/lib/config";
import type { RuntimeEnv } from "@/lib/cloudflare";
import { IS_CLOUDFLARE } from "@/lib/platform";

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
}

function resolveFrom(env: RuntimeEnv) {
  return {
    email:
      env.AUTH_EMAIL_FROM ??
      process.env.AUTH_EMAIL_FROM ??
      BRAND_CONTACT_EMAIL,
    name:
      env.AUTH_EMAIL_FROM_NAME ??
      process.env.AUTH_EMAIL_FROM_NAME ??
      BRAND_NAME,
  };
}

type OutboundEmail = { to: string; subject: string; text: string; html: string };

/**
 * Deliver one email through the configured provider:
 *   - Resend (`FISHMEM_EMAIL=resend` or `RESEND_API_KEY` set) — any runtime
 *   - Cloudflare `EMAIL` send binding (the Cloud default)
 *   - none → `{ sent: false }` so the caller can fall back (e.g. show a link to
 *     copy). A missing provider is never an error here; the caller decides.
 */
async function deliver(
  env: RuntimeEnv,
  msg: OutboundEmail,
): Promise<{ sent: boolean }> {
  const from = resolveFrom(env);
  const provider = env.FISHMEM_EMAIL ?? process.env.FISHMEM_EMAIL;
  const resendKey = env.RESEND_API_KEY ?? process.env.RESEND_API_KEY;

  if (provider === "resend" || (resendKey && provider !== "cloudflare")) {
    if (!resendKey) {
      throw new Error("FISHMEM_EMAIL=resend but RESEND_API_KEY is not set");
    }
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `${from.name} <${from.email}>`,
        to: [msg.to],
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
      }),
    });
    if (!res.ok) {
      throw new Error(
        `Resend send failed (${res.status}): ${await res.text().catch(() => "")}`,
      );
    }
    return { sent: true };
  }

  if (env.EMAIL?.send) {
    await env.EMAIL.send({
      from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
    });
    return { sent: true };
  }

  return { sent: false };
}

export async function sendMagicLinkEmail({
  email,
  env,
  url,
}: {
  email: string;
  env: RuntimeEnv;
  url: string;
}) {
  const safeBrand = escapeHtml(BRAND_NAME);
  const safeUrl = escapeHtml(url);
  const { sent } = await deliver(env, {
    to: email,
    subject: `Sign in to ${BRAND_NAME}`,
    text: [
      `Sign in to ${BRAND_NAME}`,
      "",
      "Open this link to finish signing in:",
      url,
      "",
      "This link expires soon. If you did not request it, you can ignore this email.",
    ].join("\n"),
    html: `
      <div style="font-family:Inter,Arial,sans-serif;line-height:1.55;color:#181815">
        <h1 style="font-size:20px;font-weight:600;margin:0 0 12px">Sign in to ${safeBrand}</h1>
        <p style="margin:0 0 18px;color:#514837">Open this secure link to finish signing in.</p>
        <p style="margin:0 0 22px">
          <a href="${safeUrl}" style="display:inline-block;background:#181815;color:#fff;text-decoration:none;border-radius:4px;padding:10px 14px;font-size:14px;font-weight:600">Open ${safeBrand}</a>
        </p>
        <p style="margin:0 0 8px;color:#6F6B64;font-size:13px">If the button does not work, paste this URL into your browser:</p>
        <p style="word-break:break-all;color:#514837;font-size:13px">${safeUrl}</p>
        <p style="margin-top:20px;color:#8C8880;font-size:12px">If you did not request this email, you can ignore it.</p>
      </div>
    `,
  });
  if (!sent) {
    // No provider: on Node self-host OR any local dev (no email infra), print
    // the link so login still works. Only a real production deployment with no
    // provider is treated as an error.
    if (!IS_CLOUDFLARE || process.env.NODE_ENV !== "production") {
      console.log(`[fishmem] magic-link sign-in for ${email}: ${url}`);
      return;
    }
    throw new Error(
      "No email provider configured (set RESEND_API_KEY or the Cloudflare EMAIL binding)",
    );
  }
}

/**
 * Email an invite link. Returns `{ sent }` — when no provider is configured the
 * caller surfaces the link for the admin to copy instead. On Node the link is
 * also logged for convenience.
 */
export async function sendInviteEmail({
  email,
  env,
  url,
  invitedByName,
}: {
  email: string;
  env: RuntimeEnv;
  url: string;
  invitedByName?: string | null;
}): Promise<{ sent: boolean }> {
  const safeBrand = escapeHtml(BRAND_NAME);
  const safeUrl = escapeHtml(url);
  const lede = invitedByName
    ? `${escapeHtml(invitedByName)} invited you to ${safeBrand}`
    : `You have been invited to ${safeBrand}`;
  const result = await deliver(env, {
    to: email,
    subject: `You're invited to ${BRAND_NAME}`,
    text: [
      invitedByName
        ? `${invitedByName} invited you to ${BRAND_NAME}.`
        : `You have been invited to ${BRAND_NAME}.`,
      "",
      "Accept your invitation and set a password:",
      url,
      "",
      "This invite expires in 7 days. If you did not expect it, you can ignore this email.",
    ].join("\n"),
    html: `
      <div style="font-family:Inter,Arial,sans-serif;line-height:1.55;color:#181815">
        <h1 style="font-size:20px;font-weight:600;margin:0 0 12px">${lede}</h1>
        <p style="margin:0 0 18px;color:#514837">Accept your invitation and set a password to get started.</p>
        <p style="margin:0 0 22px">
          <a href="${safeUrl}" style="display:inline-block;background:#181815;color:#fff;text-decoration:none;border-radius:4px;padding:10px 14px;font-size:14px;font-weight:600">Accept invitation</a>
        </p>
        <p style="margin:0 0 8px;color:#6F6B64;font-size:13px">If the button does not work, paste this URL into your browser:</p>
        <p style="word-break:break-all;color:#514837;font-size:13px">${safeUrl}</p>
        <p style="margin-top:20px;color:#8C8880;font-size:12px">This invite expires in 7 days.</p>
      </div>
    `,
  });
  if (!result.sent && !IS_CLOUDFLARE) {
    console.log(`[fishmem] invite for ${email}: ${url}`);
  }
  return result;
}

/**
 * Email a password-reset link. Same delivery contract as the magic link: when
 * no provider is configured we print the URL to the server console (Node
 * self-host or any local dev) so the reset still works; only a real Cloudflare
 * production deployment with no provider is treated as an error.
 */
export async function sendResetPasswordEmail({
  email,
  env,
  url,
}: {
  email: string;
  env: RuntimeEnv;
  url: string;
}) {
  const safeBrand = escapeHtml(BRAND_NAME);
  const safeUrl = escapeHtml(url);
  const { sent } = await deliver(env, {
    to: email,
    subject: `Reset your ${BRAND_NAME} password`,
    text: [
      `Reset your ${BRAND_NAME} password`,
      "",
      "Open this link to choose a new password:",
      url,
      "",
      "This link expires soon. If you did not request it, you can ignore this email — your password will not change.",
    ].join("\n"),
    html: `
      <div style="font-family:Inter,Arial,sans-serif;line-height:1.55;color:#181815">
        <h1 style="font-size:20px;font-weight:600;margin:0 0 12px">Reset your ${safeBrand} password</h1>
        <p style="margin:0 0 18px;color:#514837">Open this secure link to choose a new password.</p>
        <p style="margin:0 0 22px">
          <a href="${safeUrl}" style="display:inline-block;background:#181815;color:#fff;text-decoration:none;border-radius:4px;padding:10px 14px;font-size:14px;font-weight:600">Reset password</a>
        </p>
        <p style="margin:0 0 8px;color:#6F6B64;font-size:13px">If the button does not work, paste this URL into your browser:</p>
        <p style="word-break:break-all;color:#514837;font-size:13px">${safeUrl}</p>
        <p style="margin-top:20px;color:#8C8880;font-size:12px">If you did not request this, you can ignore this email — your password will not change.</p>
      </div>
    `,
  });
  if (!sent) {
    if (!IS_CLOUDFLARE || process.env.NODE_ENV !== "production") {
      console.log(`[fishmem] password reset for ${email}: ${url}`);
      return;
    }
    throw new Error(
      "No email provider configured (set RESEND_API_KEY or the Cloudflare EMAIL binding)",
    );
  }
}
