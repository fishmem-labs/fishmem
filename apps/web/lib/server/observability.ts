import { and, desc, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import type { MemoryWarning, ProviderUsage } from "fishmem";
import {
  observabilityEvents,
  providerPriceSnapshots,
} from "@/db/schema";
import type { AppDb } from "@/db";

function eventId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export async function createProviderPriceSnapshot(
  db: AppDb,
  input: {
    workspaceId?: string;
    provider: string;
    model: string;
    kind: "chat" | "embedding";
    inputMicrosPerMillion: number;
    outputMicrosPerMillion: number;
    source: string;
    effectiveAt?: Date;
  },
  now = new Date(),
) {
  for (const amount of [
    input.inputMicrosPerMillion,
    input.outputMicrosPerMillion,
  ]) {
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new TypeError("Provider prices must be non-negative integer micros");
    }
  }
  if (!input.source.trim()) throw new TypeError("Provider price source is required");
  const id = eventId("price");
  const [row] = await db
    .insert(providerPriceSnapshots)
    .values({
      id,
      documentId: id,
      workspaceId: input.workspaceId,
      provider: input.provider,
      model: input.model,
      kind: input.kind,
      inputMicrosPerMillion: input.inputMicrosPerMillion,
      outputMicrosPerMillion: input.outputMicrosPerMillion,
      source: input.source,
      effectiveAt: input.effectiveAt ?? now,
      createdAt: now,
    })
    .returning();
  return row!;
}

async function priceFor(db: AppDb, usage: ProviderUsage, at: Date) {
  const workspaceId = usage.context?.namespaceId;
  return db
    .select()
    .from(providerPriceSnapshots)
    .where(
      and(
        eq(providerPriceSnapshots.provider, usage.provider),
        eq(providerPriceSnapshots.model, usage.model),
        eq(providerPriceSnapshots.kind, usage.kind),
        lte(providerPriceSnapshots.effectiveAt, at),
        workspaceId
          ? or(
              eq(providerPriceSnapshots.workspaceId, workspaceId),
              isNull(providerPriceSnapshots.workspaceId),
            )
          : isNull(providerPriceSnapshots.workspaceId),
      ),
    )
    .orderBy(
      desc(providerPriceSnapshots.workspaceId),
      desc(providerPriceSnapshots.effectiveAt),
    )
    .get();
}

export async function recordProviderUsage(
  db: AppDb,
  usage: ProviderUsage,
  now = new Date(),
) {
  const workspaceId = usage.context?.namespaceId;
  if (!workspaceId) {
    throw new TypeError("Provider usage requires a namespace context");
  }
  const price = await priceFor(db, usage, now);
  const costMicros = price
    ? Math.round(
        (usage.inputTokens * price.inputMicrosPerMillion +
          usage.outputTokens * price.outputMicrosPerMillion) /
          1_000_000,
      )
    : null;
  const id = eventId("obs");
  const [event] = await db
    .insert(observabilityEvents)
    .values({
      id,
      documentId: id,
      workspaceId,
      requestId: usage.context?.requestId,
      kind: "provider_usage",
      provider: usage.provider,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costMicros,
      latencyMs: usage.latencyMs,
      metadata: {
        operation: usage.context?.operation,
        provider_kind: usage.kind,
        price_snapshot_id: price?.documentId ?? null,
      },
      createdAt: now,
    })
    .returning();
  return event!;
}

export async function recordMemoryWarning(
  db: AppDb,
  workspaceId: string,
  warning: MemoryWarning,
  now = new Date(),
) {
  const id = eventId("obs");
  const [event] = await db
    .insert(observabilityEvents)
    .values({
      id,
      documentId: id,
      workspaceId,
      kind: "warning",
      warningCode: warning.code,
      metadata: {
        message: warning.message,
        recoverable: warning.recoverable,
        context: warning.context,
        error_name:
          warning.error instanceof Error ? warning.error.name : undefined,
      },
      createdAt: now,
    })
    .returning();
  return event!;
}

function percentile(sorted: number[], quantile: number) {
  if (!sorted.length) return null;
  return sorted[Math.ceil(quantile * sorted.length) - 1] ?? sorted.at(-1)!;
}

export async function getObservabilitySummary(
  db: AppDb,
  workspaceId: string,
  since?: Date,
) {
  const predicate = since
    ? and(
        eq(observabilityEvents.workspaceId, workspaceId),
        gte(observabilityEvents.createdAt, since),
      )
    : eq(observabilityEvents.workspaceId, workspaceId);
  const [totals] = await db
    .select({
      events: sql<number>`count(*)`,
      inputTokens: sql<number>`coalesce(sum(${observabilityEvents.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${observabilityEvents.outputTokens}), 0)`,
      knownCostMicros: sql<number>`coalesce(sum(${observabilityEvents.costMicros}), 0)`,
      unpricedCalls: sql<number>`sum(case when ${observabilityEvents.kind} = 'provider_usage' and ${observabilityEvents.costMicros} is null then 1 else 0 end)`,
      warnings: sql<number>`sum(case when ${observabilityEvents.kind} = 'warning' then 1 else 0 end)`,
      retries: sql<number>`coalesce(sum(${observabilityEvents.retryCount}), 0)`,
    })
    .from(observabilityEvents)
    .where(predicate);
  const latencies = (
    await db
      .select({ latencyMs: observabilityEvents.latencyMs })
      .from(observabilityEvents)
      .where(
        and(predicate, sql`${observabilityEvents.latencyMs} is not null`),
      )
  )
    .flatMap((row) => (row.latencyMs === null ? [] : [row.latencyMs]))
    .sort((a, b) => a - b);
  return {
    events: Number(totals?.events ?? 0),
    inputTokens: Number(totals?.inputTokens ?? 0),
    outputTokens: Number(totals?.outputTokens ?? 0),
    knownCostMicros: Number(totals?.knownCostMicros ?? 0),
    unpricedCalls: Number(totals?.unpricedCalls ?? 0),
    warnings: Number(totals?.warnings ?? 0),
    retries: Number(totals?.retries ?? 0),
    p50LatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
  };
}
