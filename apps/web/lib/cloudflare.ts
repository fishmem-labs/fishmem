import { IS_CLOUDFLARE } from "@/lib/platform";
import { env as workerEnv } from "cloudflare:workers";

/**
 * Bindings and variables consumed by the runtime-independent application.
 *
 * Keep this type source-controlled instead of extending Wrangler's generated
 * `CloudflareEnv`: generated declarations are deployment-specific and are not
 * present in a fresh self-hosted checkout or SDK consumer build.
 */
export type RuntimeEnv = {
  D1: D1Database;
  R2: R2Bucket;
  ASSETS?: Fetcher;
  WORKER_SELF_REFERENCE?: Fetcher;
  DOCUMENT_TASKS?: Queue<{ task_id: string }>;
  DOCUMENT_EXTRACTOR?: DurableObjectNamespace;
  EMAIL?: SendEmail;
  /** Required Vectorize index for Cloudflare memory embeddings. */
  VECTORIZE: unknown;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  FISHMEM_EMBEDDER_MODEL?: string;
  FISHMEM_LLM_MODEL?: string;
  BETTER_AUTH_SECRET?: string;
  FISHMEM_SETUP_TOKEN?: string;
  BETTER_AUTH_URL?: string;
  NEXT_PUBLIC_SITE_URL?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  AUTH_EMAIL_FROM?: string;
  AUTH_EMAIL_FROM_NAME?: string;
  VITE_SITE_URL?: string;
  /** Email provider selector + Resend key (magic links + invites). */
  FISHMEM_EMAIL?: string;
  /** Comma-separated headers trusted for auth IP/rate-limit identity. */
  FISHMEM_TRUSTED_IP_HEADERS?: string;
  RESEND_API_KEY?: string;
  FISHMEM_ASSET_DIR?: string;
  FISHMEM_EXTRACTOR_URL?: string;
};

export async function getRuntimeEnv() {
  // Node (self-host / Vercel): no Cloudflare context — env from the process.
  if (!IS_CLOUDFLARE) {
    return process.env as unknown as RuntimeEnv;
  }
  return workerEnv as RuntimeEnv;
}
