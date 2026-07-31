import { and, eq, inArray, isNull, lte, or } from "drizzle-orm";
import {
  observabilityEvents,
  webhookDeliveries,
  webhookEndpoints,
} from "@/db/schema";
import type { AppDb } from "@/db";

const MAX_ATTEMPTS = 5;
const LEASE_MS = 60_000;

function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

async function stableDeliveryId(endpointId: string, eventId: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${endpointId}\0${eventId}`),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `wd_${hex.slice(0, 40)}`;
}

async function sign(secret: string, payload: string, timestamp: number) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const bytes = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${payload}`),
  );
  const hex = Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `v1=${hex}`;
}

export async function enqueueWebhookEvent(
  db: AppDb,
  workspaceId: string,
  eventType: string,
  data: Record<string, unknown>,
  now = new Date(),
  options: { eventId?: string } = {},
) {
  const endpoints = await db
    .select()
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.workspaceId, workspaceId),
        eq(webhookEndpoints.enabled, true),
      ),
    );
  const rows = await Promise.all(
    endpoints
      .filter((endpoint) => (endpoint.events as string[]).includes(eventType))
      .map(async (endpoint) => {
      const eventId = options.eventId ?? id("evt");
      const deliveryId = options.eventId
        ? await stableDeliveryId(endpoint.documentId, eventId)
        : id("wd");
      return {
        id: deliveryId,
        documentId: deliveryId,
        endpointId: endpoint.documentId,
        workspaceId,
        eventId,
        eventType,
        status: "pending",
        attempts: 0,
        payload: JSON.stringify({
          id: eventId,
          type: eventType,
          created_at: now.toISOString(),
          project_id: workspaceId,
          data,
        }),
        nextAttemptAt: now,
        updatedAt: now,
        createdAt: now,
      };
    }),
  );
  if (rows.length) {
    await db.insert(webhookDeliveries).values(rows).onConflictDoNothing();
  }
  return rows.map((row) => row.documentId);
}

export async function processWebhookOutbox(
  db: AppDb,
  fetcher: typeof fetch = fetch,
  now = new Date(),
) {
  const due = await db
    .select()
    .from(webhookDeliveries)
    .where(
      and(
        or(
          and(
            inArray(webhookDeliveries.status, ["pending", "retry"]),
            or(
              isNull(webhookDeliveries.nextAttemptAt),
              lte(webhookDeliveries.nextAttemptAt, now),
            ),
          ),
          and(
            eq(webhookDeliveries.status, "processing"),
            lte(webhookDeliveries.leaseExpiresAt, now),
          ),
        ),
      ),
    )
    .limit(50);
  const summary = { claimed: 0, succeeded: 0, retried: 0, dead: 0 };
  for (const delivery of due) {
    const [claimed] = await db
      .update(webhookDeliveries)
      .set({
        status: "processing",
        attempts: delivery.attempts + 1,
        lastAttemptAt: now,
        leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
        updatedAt: now,
      })
      .where(
        and(
          eq(webhookDeliveries.documentId, delivery.documentId),
          eq(webhookDeliveries.status, delivery.status),
          eq(webhookDeliveries.updatedAt, delivery.updatedAt),
        ),
      )
      .returning();
    if (!claimed) continue;
    summary.claimed++;
    const endpoint = await db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.documentId, claimed.endpointId))
      .get();
    let httpStatus: number | null = null;
    let error: string | null = null;
    const startedAt = Date.now();
    if (!endpoint?.enabled) {
      error = "Webhook endpoint is missing or disabled";
    } else {
      try {
        const timestamp = Math.floor(now.getTime() / 1000);
        const response = await fetcher(endpoint.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": "FishMem-Webhooks/1.0",
            "x-fishmem-delivery": claimed.documentId,
            "x-fishmem-event": claimed.eventType,
            "x-fishmem-signature": await sign(
              endpoint.secret,
              claimed.payload,
              timestamp,
            ),
            "x-fishmem-timestamp": String(timestamp),
          },
          body: claimed.payload,
        });
        httpStatus = response.status;
        if (!response.ok) error = `HTTP ${response.status}`;
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
    }
    if (!error) {
      await db
        .update(webhookDeliveries)
        .set({
          status: "success",
          httpStatus,
          error: null,
          leaseExpiresAt: null,
          updatedAt: now,
        })
        .where(eq(webhookDeliveries.documentId, claimed.documentId));
      summary.succeeded++;
      const evidenceId = id("obs");
      await db.insert(observabilityEvents).values({
        id: evidenceId,
        documentId: evidenceId,
        workspaceId: claimed.workspaceId,
        operationId: claimed.taskId,
        kind: "webhook_delivery",
        latencyMs: Math.max(0, Date.now() - startedAt),
        metadata: {
          delivery_id: claimed.documentId,
          http_status: httpStatus,
        },
        createdAt: now,
      });
      continue;
    }
    const exhausted = claimed.attempts >= MAX_ATTEMPTS;
    const delayMs = Math.min(60_000 * 2 ** (claimed.attempts - 1), 3_600_000);
    await db
      .update(webhookDeliveries)
      .set({
        status: exhausted ? "dead" : "retry",
        httpStatus,
        error,
        nextAttemptAt: exhausted ? null : new Date(now.getTime() + delayMs),
        leaseExpiresAt: null,
        updatedAt: now,
      })
      .where(eq(webhookDeliveries.documentId, claimed.documentId));
    if (exhausted) summary.dead++;
    else summary.retried++;
    const evidenceId = id("obs");
    await db.insert(observabilityEvents).values({
      id: evidenceId,
      documentId: evidenceId,
      workspaceId: claimed.workspaceId,
      operationId: claimed.taskId,
      kind: exhausted ? "webhook_dead" : "webhook_retry",
      latencyMs: Math.max(0, Date.now() - startedAt),
      retryCount: 1,
      warningCode: "webhook_delivery_failed",
      metadata: {
        delivery_id: claimed.documentId,
        error,
        http_status: httpStatus,
      },
      createdAt: now,
    });
  }
  return summary;
}

export async function retryWebhookDelivery(
  db: AppDb,
  workspaceId: string,
  deliveryId: string,
  now = new Date(),
) {
  const [delivery] = await db
    .update(webhookDeliveries)
    .set({
      status: "pending",
      attempts: 0,
      error: null,
      httpStatus: null,
      nextAttemptAt: now,
      leaseExpiresAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(webhookDeliveries.documentId, deliveryId),
        eq(webhookDeliveries.workspaceId, workspaceId),
        inArray(webhookDeliveries.status, ["dead", "failed", "retry"]),
      ),
    )
    .returning();
  return delivery ?? null;
}
