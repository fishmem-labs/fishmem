import { Container } from "@cloudflare/containers";
import startWorker from "@tanstack/react-start/server-entry";
import { createDb, type AppDb } from "../db";
import { getMemoryEngine } from "../lib/server/memory-api";
import {
  markMemoryTaskDeliveryExhausted,
  processMemoryTaskById,
} from "../lib/server/memory-task-worker";
import { handleOperationQueueBatch } from "../lib/server/operation-queue";
import {
  enforcePublicApiRateLimit,
  withPublicApiRateHeaders,
} from "../lib/server/rate-limit";

type Env = {
  D1: D1Database;
  DOCUMENT_TASKS: Queue<{ task_id: string }>;
  DOCUMENT_EXTRACTOR: DurableObjectNamespace;
  MEMORY_RATE_LIMITER: RateLimit;
  WORKER_SELF_REFERENCE: Fetcher;
  CRON_SECRET?: string;
  VITE_SITE_URL?: string;
};

/**
 * Same pinned Docling service image used by Docker self-hosting. The Durable
 * Object owns only lifecycle/routing; R2 and D1 remain the durable state.
 */
export class FishMemExtractorContainer extends Container {
  defaultPort = 5001;
  sleepAfter = "2m";
  enableInternet = false;
  envVars = {
    DOCLING_DEVICE: "cpu",
    DOCLING_SERVE_ENABLE_UI: "false",
    DOCLING_SERVE_ENABLE_REMOTE_SERVICES: "false",
    DOCLING_SERVE_ENG_KIND: "local",
    DOCLING_SERVE_ENG_LOC_NUM_WORKERS: "1",
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (new URL(request.url).pathname.startsWith("/v1/")) {
      const limited = await enforcePublicApiRateLimit(
        request,
        env.MEMORY_RATE_LIMITER,
      );
      if (limited) return limited;
      return withPublicApiRateHeaders(await startWorker.fetch(request));
    }
    return startWorker.fetch(request);
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    const base = env.VITE_SITE_URL ?? "http://localhost:3000";
    const route =
      event.cron === "0 4 * * *"
        ? "/api/cron/maintenance"
        : "/api/cron/tasks";
    ctx.waitUntil(
      env.WORKER_SELF_REFERENCE.fetch(`${base}${route}`, {
        method: "POST",
        headers: { authorization: `Bearer ${env.CRON_SECRET ?? ""}` },
      }).then(async (response) => {
        console.log("memory tasks:", response.status, await response.text());
      }),
    );
  },

  async queue(
    batch: MessageBatch<{ task_id: string }>,
    env: Env,
    _ctx: ExecutionContext,
  ) {
    const db = createDb(env.D1) as unknown as AppDb;
    let memory: Awaited<ReturnType<typeof getMemoryEngine>> | undefined;
    await handleOperationQueueBatch({
      batch,
      mainQueue: {
        send: async (body, options) => {
          await env.DOCUMENT_TASKS.send(body, options);
        },
      },
      processTask: async (taskId) => {
        memory ??= await getMemoryEngine();
        return processMemoryTaskById(db, memory, taskId);
      },
      markDeliveryExhausted: (taskId, input) =>
        markMemoryTaskDeliveryExhausted(db, taskId, input),
    });
  },
} satisfies ExportedHandler<Env, { task_id: string }>;
