"use client";

const ATTRIBUTION_COOKIE_NAME = "sv_attribution";
const ATTRIBUTION_COOKIE_MAX_AGE = 60 * 60 * 24 * 90;
const ATTRIBUTION_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "wbraid",
  "gbraid",
  "fbclid",
  "msclkid",
  "ref",
  "ga_client_id",
  "ga_session_id"
] as const;

export function syncAttributionFromLocation(search = window.location.search) {
  const params = new URLSearchParams(search);
  const attribution: Record<string, string> = {};
  for (const key of ATTRIBUTION_KEYS) {
    const value = params.get(key);
    if (value?.trim()) {
      attribution[key] = value.trim().slice(0, 500);
    }
  }

  if (!Object.keys(attribution).length) {
    return null;
  }

  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  const serialized = encodeURIComponent(JSON.stringify(attribution));
  document.cookie = `${ATTRIBUTION_COOKIE_NAME}=${serialized}; Path=/; Max-Age=${ATTRIBUTION_COOKIE_MAX_AGE}; SameSite=Lax${secure}`;
  return attribution;
}
