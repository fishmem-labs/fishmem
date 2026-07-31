import { and, eq, inArray, isNull, lte, or } from "drizzle-orm";
import {
  observabilityEvents,
  operationTasks,
  sourceAssets,
} from "@/db/schema";
import type { AppDb } from "@/db";

export type OperationTaskKind =
  | "batch_delete"
  | "batch_update"
  | "derive"
  | "document_extract"
  | "export"
  | "import"
  | "maintenance"
  | "memory_infer"
  | "purge"
  | "rebuild";

export type OperationTask = typeof operationTasks.$inferSelect;
export type OperationTaskContinuation = {
  __operationTaskContinuation: true;
  payload: Record<string, unknown>;
  result: unknown;
};
export type OperationTaskCompletion = {
  __operationTaskCompletion: true;
  payload: Record<string, unknown>;
  result: unknown;
};
export type OperationTaskHandler = (
  task: OperationTask,
) => Promise<
  unknown | OperationTaskContinuation | OperationTaskCompletion
>;
export type OperationTaskHandlers = Partial<
  Record<OperationTaskKind, OperationTaskHandler>
>;

export function continueOperationTask(
  payload: Record<string, unknown>,
  result: unknown,
): OperationTaskContinuation {
  return { __operationTaskContinuation: true, payload, result };
}

export function completeOperationTask(
  payload: Record<string, unknown>,
  result: unknown,
): OperationTaskCompletion {
  return { __operationTaskCompletion: true, payload, result };
}

function isOperationTaskContinuation(
  value: unknown,
): value is OperationTaskContinuation {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Partial<OperationTaskContinuation>).__operationTaskContinuation ===
      true
  );
}

function isOperationTaskCompletion(
  value: unknown,
): value is OperationTaskCompletion {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Partial<OperationTaskCompletion>).__operationTaskCompletion ===
      true
  );
}

export async function enqueueProfileDerivation(
  db: AppDb,
  input: {
    workspaceId: string;
    operationId: string;
    userId?: string;
    agentId?: string;
    runId?: string;
  },
) {
  return enqueueOperationTask(db, {
    workspaceId: input.workspaceId,
    operationId: input.operationId,
    kind: "derive",
    payload: {
      userId: input.userId,
      agentId: input.agentId,
      runId: input.runId,
    },
  });
}

const LEASE_MS = 5 * 60_000;
const QUEUE_DELIVERY_EXHAUSTED = "[QUEUE_DELIVERY_EXHAUSTED]";

function taskId() {
  return `task_${crypto.randomUUID().replaceAll("-", "")}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function enqueueOperationTask(
  db: AppDb,
  input: {
    workspaceId: string;
    operationId?: string;
    kind: OperationTaskKind;
    payload: Record<string, unknown>;
    maxAttempts?: number;
    status?: "awaiting_upload" | "pending";
    payloadEquivalent?: (
      existing: Record<string, unknown>,
      incoming: Record<string, unknown>,
    ) => boolean;
  },
  now = new Date(),
) {
  const id = taskId();
  const [task] = await db
    .insert(operationTasks)
    .values({
      id,
      documentId: id,
      workspaceId: input.workspaceId,
      operationId: input.operationId,
      kind: input.kind,
      status: input.status ?? "pending",
      payload: input.payload,
      attempts: 0,
      maxAttempts: input.maxAttempts ?? 5,
      nextAttemptAt: input.status === "awaiting_upload" ? null : now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning();
  if (task) return task;
  if (!input.operationId) {
    throw new Error("operation task insert conflicted without an operation id");
  }
  const existing = await db
    .select()
    .from(operationTasks)
    .where(
      and(
        eq(operationTasks.workspaceId, input.workspaceId),
        eq(operationTasks.kind, input.kind),
        eq(operationTasks.operationId, input.operationId),
      ),
    )
    .get();
  if (!existing) throw new Error("operation task conflict could not be resolved");
  const payloadMatches = input.payloadEquivalent
    ? input.payloadEquivalent(existing.payload, input.payload)
    : stableJson(existing.payload) === stableJson(input.payload);
  if (!payloadMatches) {
    throw new Error(
      `idempotency key conflict: ${input.operationId} was used for a different task payload`,
    );
  }
  return existing;
}

export async function processOperationTasks(
  db: AppDb,
  handlers: OperationTaskHandlers,
  now = new Date(),
) {
  const due = await db
    .select()
    .from(operationTasks)
    .where(
      or(
        and(
          inArray(operationTasks.status, ["pending", "retry"]),
          or(
            isNull(operationTasks.nextAttemptAt),
            lte(operationTasks.nextAttemptAt, now),
          ),
        ),
        and(
          eq(operationTasks.status, "processing"),
          lte(operationTasks.leaseExpiresAt, now),
        ),
      ),
    )
    .limit(50);
  const summary = {
    claimed: 0,
    succeeded: 0,
    continued: 0,
    retried: 0,
    dead: 0,
  };
  for (const task of due) {
    const outcome = await processSelectedOperationTask(
      db,
      handlers,
      task,
      now,
    );
    summary.claimed += outcome.claimed;
    summary.succeeded += outcome.succeeded;
    summary.continued += outcome.continued;
    summary.retried += outcome.retried;
    summary.dead += outcome.dead;
  }
  return summary;
}

export async function processOperationTaskById(
  db: AppDb,
  handlers: OperationTaskHandlers,
  documentId: string,
  now = new Date(),
) {
  const task = await db
    .select()
    .from(operationTasks)
    .where(eq(operationTasks.documentId, documentId))
    .get();
  if (
    !task ||
    !(
      (["pending", "retry"].includes(task.status) &&
        (!task.nextAttemptAt || task.nextAttemptAt <= now)) ||
      (task.status === "processing" &&
        task.leaseExpiresAt !== null &&
        task.leaseExpiresAt <= now)
    )
  ) {
    return {
      claimed: 0,
      succeeded: 0,
      continued: 0,
      retried: 0,
      dead: 0,
    };
  }
  return processSelectedOperationTask(db, handlers, task, now);
}

async function processSelectedOperationTask(
  db: AppDb,
  handlers: OperationTaskHandlers,
  task: OperationTask,
  now: Date,
) {
  const summary = {
    claimed: 0,
    succeeded: 0,
    continued: 0,
    retried: 0,
    dead: 0,
  };
  const [claimed] = await db
    .update(operationTasks)
    .set({
      status: "processing",
      attempts: task.attempts + 1,
      leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
      startedAt: task.startedAt ?? now,
      completedAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(operationTasks.documentId, task.documentId),
        eq(operationTasks.status, task.status),
        eq(operationTasks.updatedAt, task.updatedAt),
      ),
    )
    .returning();
  if (!claimed) return summary;
  summary.claimed = 1;
  await recordOperationTaskLifecycleEvent(
    db,
    claimed,
    "task_started",
    now,
  );
  const handler = handlers[claimed.kind as OperationTaskKind];
  let error: string | null = null;
  let result: unknown;
  const executionStartedAt = Date.now();
  if (!handler) error = `No handler registered for task kind ${claimed.kind}`;
  else {
    try {
      result = await handler(claimed);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }
  const finishedAt = new Date(
    now.getTime() + Math.max(0, Date.now() - executionStartedAt),
  );
  if (!error && isOperationTaskContinuation(result)) {
    await db
      .update(operationTasks)
      .set({
        status: "pending",
        payload: result.payload,
        result: result.result,
        attempts: 0,
        error: null,
        leaseExpiresAt: null,
        nextAttemptAt: now,
        completedAt: null,
        updatedAt: finishedAt,
      })
      .where(eq(operationTasks.documentId, claimed.documentId));
    await recordOperationTaskLifecycleEvent(
      db,
      claimed,
      "task_continued",
      finishedAt,
      { latencyMs: Math.max(0, finishedAt.getTime() - now.getTime()) },
    );
    summary.continued = 1;
    return summary;
  }
  if (!error) {
    const completion = isOperationTaskCompletion(result) ? result : null;
    await db
      .update(operationTasks)
      .set({
        status: "success",
        error: null,
        result: completion?.result ?? result,
        ...(completion ? { payload: completion.payload } : {}),
        leaseExpiresAt: null,
        nextAttemptAt: null,
        completedAt: finishedAt,
        updatedAt: finishedAt,
      })
      .where(eq(operationTasks.documentId, claimed.documentId));
    await recordOperationTaskLifecycleEvent(
      db,
      claimed,
      "task_succeeded",
      finishedAt,
      { latencyMs: Math.max(0, finishedAt.getTime() - now.getTime()) },
    );
    summary.succeeded = 1;
    return summary;
  }
  const exhausted = claimed.attempts >= claimed.maxAttempts;
  const delayMs = Math.min(60_000 * 2 ** (claimed.attempts - 1), 3_600_000);
  await db
    .update(operationTasks)
    .set({
      status: exhausted ? "dead" : "retry",
      error,
      leaseExpiresAt: null,
      nextAttemptAt: exhausted
        ? null
        : new Date(now.getTime() + delayMs),
      completedAt: exhausted ? finishedAt : null,
      updatedAt: finishedAt,
    })
    .where(eq(operationTasks.documentId, claimed.documentId));
  await recordOperationTaskLifecycleEvent(
    db,
    claimed,
    exhausted ? "task_dead" : "task_retry",
    finishedAt,
    {
      error,
      latencyMs: Math.max(0, finishedAt.getTime() - now.getTime()),
      warningCode: `task_${claimed.kind}_failed`,
    },
  );
  if (exhausted) summary.dead = 1;
  else summary.retried = 1;
  return summary;
}

async function recordOperationTaskLifecycleEvent(
  db: AppDb,
  task: OperationTask,
  kind: string,
  createdAt: Date,
  input: {
    error?: string;
    latencyMs?: number;
    warningCode?: string;
  } = {},
) {
  const evidenceId = `obs_${crypto.randomUUID().replaceAll("-", "")}`;
  await db
    .insert(observabilityEvents)
    .values({
      id: evidenceId,
      documentId: evidenceId,
      workspaceId: task.workspaceId,
      operationId: task.operationId ?? task.documentId,
      kind,
      latencyMs: input.latencyMs,
      retryCount: task.attempts,
      warningCode: input.warningCode,
      metadata: {
        task_id: task.documentId,
        task_kind: task.kind,
        ...(input.error ? { error: input.error } : {}),
      },
      createdAt,
    })
    .onConflictDoNothing();
}

export async function retryOperationTask(
  db: AppDb,
  workspaceId: string,
  documentId: string,
  now = new Date(),
) {
  const [task] = await db
    .update(operationTasks)
    .set({
      status: "pending",
      attempts: 0,
      error: null,
      result: null,
      nextAttemptAt: now,
      leaseExpiresAt: null,
      startedAt: null,
      completedAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(operationTasks.documentId, documentId),
        eq(operationTasks.workspaceId, workspaceId),
        inArray(operationTasks.status, ["retry", "dead"]),
      ),
    )
    .returning();
  if (!task) {
    const current = await db
      .select()
      .from(operationTasks)
      .where(
        and(
          eq(operationTasks.documentId, documentId),
          eq(operationTasks.workspaceId, workspaceId),
        ),
      )
      .get();
    return current &&
      ["pending", "processing"].includes(current.status)
      ? current
      : null;
  }
  if (task.kind === "document_extract") {
    await db
      .update(sourceAssets)
      .set({ status: "queued", error: null, updatedAt: now })
      .where(
        and(
          eq(sourceAssets.workspaceId, workspaceId),
          eq(sourceAssets.operationTaskId, documentId),
        ),
      );
  }
  const evidenceId = `obs_redrive_${documentId}_${now.getTime()}`;
  await db
    .insert(observabilityEvents)
    .values({
      id: evidenceId,
      documentId: evidenceId,
      workspaceId,
      operationId: task.operationId ?? documentId,
      kind: "task_redriven",
      retryCount: task.attempts,
      metadata: { task_id: documentId, task_kind: task.kind },
      createdAt: now,
    })
    .onConflictDoNothing();
  return task;
}

/**
 * Persist the terminal state of a message that Cloudflare Queues moved to the
 * DLQ. Queue delivery is only a wakeup, but exhausting infrastructure delivery
 * must still become visible in the canonical D1 task and source-asset state.
 *
 * Repeated DLQ delivery is intentionally idempotent so a partial D1 failure can
 * converge on the next delivery attempt.
 */
export async function markOperationTaskDeliveryExhausted(
  db: AppDb,
  documentId: string,
  input: { queueName: string; messageId?: string },
  now = new Date(),
) {
  let task = await db
    .select()
    .from(operationTasks)
    .where(eq(operationTasks.documentId, documentId))
    .get();
  if (!task) return null;

  const deliveryError = `${QUEUE_DELIVERY_EXHAUSTED} Delivery retries were exhausted in ${input.queueName}`;
  if (["awaiting_upload", "pending", "processing", "retry"].includes(task.status)) {
    const [updated] = await db
      .update(operationTasks)
      .set({
        status: "dead",
        error: deliveryError,
        nextAttemptAt: null,
        leaseExpiresAt: null,
        completedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(operationTasks.documentId, documentId),
          inArray(operationTasks.status, [
            "awaiting_upload",
            "pending",
            "processing",
            "retry",
          ]),
        ),
      )
      .returning();
    task = updated ?? task;
  } else if (
    task.status !== "dead" ||
    !task.error?.startsWith(QUEUE_DELIVERY_EXHAUSTED)
  ) {
    // A delayed duplicate must never overwrite an independently completed or
    // terminal application outcome.
    return task;
  }

  if (task.kind === "document_extract") {
    await db
      .update(sourceAssets)
      .set({ status: "failed", error: deliveryError, updatedAt: now })
      .where(
        and(
          eq(sourceAssets.workspaceId, task.workspaceId),
          eq(sourceAssets.operationTaskId, documentId),
        ),
      );
  }

  const evidenceId = `obs_queue_delivery_exhausted_${documentId}`;
  await db
    .insert(observabilityEvents)
    .values({
      id: evidenceId,
      documentId: evidenceId,
      workspaceId: task.workspaceId,
      operationId: task.operationId ?? documentId,
      kind: "task_queue_delivery_exhausted",
      retryCount: task.attempts,
      warningCode: "task_queue_delivery_exhausted",
      metadata: {
        task_id: documentId,
        task_kind: task.kind,
        queue: input.queueName,
        ...(input.messageId ? { message_id: input.messageId } : {}),
      },
      createdAt: now,
    })
    .onConflictDoNothing();
  return task;
}
