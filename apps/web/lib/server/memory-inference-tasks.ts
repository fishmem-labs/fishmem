import {
  AddMemoryCommandSchema,
  type AddMemoryCommand,
} from "@fishmem/contracts";
import { MemoryApplication } from "@fishmem/application";
import type { Memory } from "fishmem";
import type { AppDb } from "@/db";
import {
  completeOperationTask,
  enqueueOperationTask,
  enqueueProfileDerivation,
  type OperationTask,
} from "@/lib/server/operation-tasks";
import { enqueueWebhookEvent } from "@/lib/server/webhook-outbox";

export type MemoryInferenceUsageAuthorization = {
  version: 1;
  api_token_id: string;
  credits: number;
  reservation?: Record<string, unknown>;
};

export type MemoryInferenceEventScope = {
  user_id?: string;
  agent_id?: string;
  run_id?: string;
};

export type MemoryInferenceTaskPayload = {
  version: 1;
  command: AddMemoryCommand;
  command_fingerprint: string;
  event_scope: MemoryInferenceEventScope;
  idempotency_key: string;
  derivation_enabled: boolean;
  usage?: MemoryInferenceUsageAuthorization;
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function parseMemoryInferenceIdentity(payload: Record<string, unknown>) {
  if (
    payload.version !== 1 ||
    typeof payload.command_fingerprint !== "string" ||
    typeof payload.idempotency_key !== "string" ||
    typeof payload.derivation_enabled !== "boolean"
  ) {
    throw new Error("Invalid memory inference task payload");
  }
  return {
    version: 1 as const,
    command_fingerprint: payload.command_fingerprint,
    event_scope: readMemoryInferenceEventScope(payload),
    idempotency_key: payload.idempotency_key,
    derivation_enabled: payload.derivation_enabled,
  };
}

export function readMemoryInferenceEventScope(
  payload: Record<string, unknown>,
): MemoryInferenceEventScope {
  if (
    !payload.event_scope ||
    typeof payload.event_scope !== "object" ||
    Array.isArray(payload.event_scope)
  ) {
    return {};
  }
  const scope = payload.event_scope as Record<string, unknown>;
  return {
    ...(typeof scope.user_id === "string" ? { user_id: scope.user_id } : {}),
    ...(typeof scope.agent_id === "string" ? { agent_id: scope.agent_id } : {}),
    ...(typeof scope.run_id === "string" ? { run_id: scope.run_id } : {}),
  };
}

export function parseMemoryInferenceTaskPayload(
  payload: Record<string, unknown>,
): MemoryInferenceTaskPayload {
  const identity = parseMemoryInferenceIdentity(payload);
  const command = AddMemoryCommandSchema.parse(payload.command);
  if (!command.infer) {
    throw new Error("Memory inference task requires infer=true");
  }
  const usage =
    payload.usage &&
    typeof payload.usage === "object" &&
    !Array.isArray(payload.usage)
      ? (payload.usage as MemoryInferenceUsageAuthorization)
      : undefined;
  return {
    ...identity,
    command,
    ...(usage ? { usage } : {}),
  };
}

function equivalentMemoryInferencePayload(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
) {
  try {
    const left = parseMemoryInferenceIdentity(existing);
    const right = parseMemoryInferenceIdentity(incoming);
    return (
      left.idempotency_key === right.idempotency_key &&
      left.command_fingerprint === right.command_fingerprint
    );
  } catch {
    return false;
  }
}

export async function enqueueMemoryInferenceTask(
  db: AppDb,
  input: {
    workspaceId: string;
    command: unknown;
    idempotencyKey: string;
    derivationEnabled: boolean;
    usage?: MemoryInferenceUsageAuthorization;
  },
) {
  const command = AddMemoryCommandSchema.parse(input.command);
  if (!command.infer) {
    throw new TypeError("Memory inference task requires infer=true");
  }
  const commandFingerprint = await sha256(stableJson(command));
  const eventScope = {
    ...(command.user_id ? { user_id: command.user_id } : {}),
    ...(command.agent_id ? { agent_id: command.agent_id } : {}),
    ...(command.run_id ? { run_id: command.run_id } : {}),
  };
  return enqueueOperationTask(db, {
    workspaceId: input.workspaceId,
    operationId: `memory-infer:${input.idempotencyKey}`,
    kind: "memory_infer",
    payload: {
      version: 1,
      command,
      command_fingerprint: commandFingerprint,
      event_scope: eventScope,
      idempotency_key: input.idempotencyKey,
      derivation_enabled: input.derivationEnabled,
      ...(input.usage ? { usage: input.usage } : {}),
    } satisfies MemoryInferenceTaskPayload,
    payloadEquivalent: equivalentMemoryInferencePayload,
  });
}

export type MemoryInferenceTaskDependencies = {
  enqueueDerivation: typeof enqueueProfileDerivation;
  enqueueWebhook: typeof enqueueWebhookEvent;
};

export type MemoryInferenceAccounting = {
  authorize(task: OperationTask): Promise<void>;
};

export async function processMemoryInferenceTask(
  db: AppDb,
  memory: Memory,
  task: OperationTask,
  dependencies: MemoryInferenceTaskDependencies = {
    enqueueDerivation: enqueueProfileDerivation,
    enqueueWebhook: enqueueWebhookEvent,
  },
  accounting?: MemoryInferenceAccounting,
) {
  await accounting?.authorize(task);
  const payload = parseMemoryInferenceTaskPayload(task.payload);
  const application = new MemoryApplication(memory);
  const result = await application.add(
    task.workspaceId,
    payload.command,
    payload.idempotency_key,
  );
  if (payload.derivation_enabled) {
    await dependencies.enqueueDerivation(db, {
      workspaceId: task.workspaceId,
      operationId: `derive:${task.documentId}`,
      userId: payload.command.user_id,
      agentId: payload.command.agent_id,
      runId: payload.command.run_id,
    });
  }
  await dependencies.enqueueWebhook(
    db,
    task.workspaceId,
    "memory_add",
    {
      operation_id: task.documentId,
      memory_ids: result.results.map((item) => item.id),
      results: result.results.length,
      ...(payload.command.user_id
        ? { user_id: payload.command.user_id }
        : {}),
      ...(payload.command.agent_id
        ? { agent_id: payload.command.agent_id }
        : {}),
      ...(payload.command.run_id ? { run_id: payload.command.run_id } : {}),
    },
    new Date(),
    { eventId: `memory_add:${task.documentId}` },
  );
  return completeOperationTask(
    {
      version: 1,
      command_fingerprint: payload.command_fingerprint,
      event_scope: payload.event_scope,
      idempotency_key: payload.idempotency_key,
      derivation_enabled: payload.derivation_enabled,
      ...(payload.usage ? { usage: payload.usage } : {}),
    },
    result,
  );
}
