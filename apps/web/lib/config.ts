export const BRAND_NAME = "FishMem";
export const BRAND_TAGLINE = "Memory infrastructure for AI agents.";
export const BRAND_SHORT_NAME = "FishMem";
export const BRAND_CONTACT_EMAIL = "support@fishmem.com";
export const BRAND_CHANNEL = "fishmem";
export const BRAND_DOMAIN = "fishmem.com";

export const APP_NAME = BRAND_NAME;
export const APP_DESCRIPTION =
  "The memory platform for AI agents — refined or verbatim writes, hybrid graph + vector recall, and explicit tenant boundaries.";
export const SITE_URL =
  import.meta.env.VITE_SITE_URL?.replace(/\/+$/, "") ||
  (import.meta.env.DEV
    ? "http://localhost:3000"
    : "https://fishmem.com");

export const PUBLIC_API_BASE_URL =
  import.meta.env.VITE_PUBLIC_API_BASE_URL?.replace(/\/+$/, "") || SITE_URL;

export function appApiPath(path: string) {
  const normalized = path.replace(/^\/+/, "").replace(/^api\//, "");
  return `/api/app/${normalized}`;
}

export function serverAppApiUrl(path: string) {
  const normalized = path.replace(/^\/+/, "").replace(/^api\//, "");
  return `${SITE_URL}/api/app/${normalized}`;
}
