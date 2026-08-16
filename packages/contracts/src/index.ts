import { z } from "zod";

export const IdempotencyKeySchema = z.string().trim().min(1).max(200);

const NonBlankTextSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "Text must not be blank");

export const MAX_MEMORY_ADD_BYTES = 250_000;
export const MAX_MEMORY_MESSAGES = 500;

const ScopeFields = {
  user_id: z.string().trim().min(1).max(512).optional(),
  agent_id: z.string().trim().min(1).max(512).optional(),
  run_id: z.string().trim().min(1).max(512).optional(),
};

export const ScopeSchema = z
  .object(ScopeFields)
  .refine((scope) => scope.user_id || scope.agent_id || scope.run_id, {
    message: "One of user_id, agent_id, run_id is required",
  });

export const ScopeEntityTypeSchema = z.enum(["user", "agent", "run"]);
export const ScopeEntityIdSchema = z.string().trim().min(1).max(512);
export const ListScopeEntitiesQuerySchema = z.object({
  type: ScopeEntityTypeSchema.optional(),
  cursor: z.string().trim().min(1).max(2_048).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const MessageSchema = z.object({
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: NonBlankTextSchema,
});

export const MemoryTypeSchema = z.enum([
  "fact",
  "preference",
  "decision",
  "identity",
  "event",
  "observation",
  "goal",
  "todo",
]);

export const ApplicabilityKindSchema = z.enum([
  "global",
  "project",
  "task",
  "conversation",
  "channel",
  "custom",
]);

export const ApplicabilityContextSchema = z
  .object({
    kind: ApplicabilityKindSchema,
    key: z.string().trim().min(1).max(1_024).optional(),
    valid_from: z.string().datetime().optional(),
    valid_to: z.string().datetime().optional(),
  })
  .superRefine((context, refinement) => {
    if (context.kind === "global" && context.key) {
      refinement.addIssue({
        code: "custom",
        path: ["key"],
        message: "global applicability must not include a key",
      });
    }
    if (context.kind !== "global" && !context.key) {
      refinement.addIssue({
        code: "custom",
        path: ["key"],
        message: `${context.kind} applicability requires a key`,
      });
    }
    if (
      context.valid_from &&
      context.valid_to &&
      Date.parse(context.valid_to) <= Date.parse(context.valid_from)
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["valid_to"],
        message: "valid_to must be after valid_from",
      });
    }
  });

/**
 * Public search modes deliberately omit `deep`: it performs an additional LLM
 * call, so Hosted must price and authorize that lane before it becomes part of
 * the stable API contract.
 */
export const SearchModeSchema = z.enum([
  "hybrid",
  "recent",
  "important",
  "typed",
]);

export const SearchStrategySchema = z.enum([
  "balanced",
  "precision",
  "recall",
  "auto",
]);

export const SearchSortSchema = z.enum([
  "recent",
  "importance",
  "most_accessed",
  "last_accessed",
]);

const MetadataFilterValueSchema = z.union([
  z.string().max(1_024),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

export const MetadataFiltersSchema = z
  .record(z.string().trim().min(1).max(128), MetadataFilterValueSchema)
  .refine((filters) => Object.keys(filters).length <= 20, {
    message: "filters supports at most 20 metadata fields",
  });

export type MemoryFilterScalarWire = string | number | boolean | null;
export type MemoryFilterFieldWire =
  | "id"
  | "content"
  | "memory_type"
  | "importance"
  | "created_at"
  | "updated_at"
  | "event_date"
  | "last_accessed_at"
  | "access_count"
  | "subject"
  | "attribute"
  | `metadata.${string}`;
export type MemoryFilterConditionWire = {
  /** Validated built-in field or a `metadata.<path>` selector. */
  field: MemoryFilterFieldWire;
  operator:
    | "eq"
    | "ne"
    | "in"
    | "nin"
    | "gt"
    | "gte"
    | "lt"
    | "lte"
    | "contains"
    | "icontains"
    | "exists";
  value: MemoryFilterScalarWire | MemoryFilterScalarWire[];
};
export type MemoryFilterExpressionWire =
  | MemoryFilterConditionWire
  | { and: MemoryFilterExpressionWire[] }
  | { or: MemoryFilterExpressionWire[] }
  | { not: MemoryFilterExpressionWire };

const MemoryFilterScalarSchema = z.union([
  z.string().max(1_024),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const MemoryFilterFieldSchema = z.union([
  z.enum([
    "id",
    "content",
    "memory_type",
    "importance",
    "created_at",
    "updated_at",
    "event_date",
    "last_accessed_at",
    "access_count",
    "subject",
    "attribute",
  ]),
  z
    .string()
    .min(10)
    .max(265)
    .regex(/^metadata\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/)
    .refine(
      (field) =>
        !field
          .slice("metadata.".length)
          .split(".")
          .some((segment) =>
            ["__proto__", "prototype", "constructor"].includes(segment),
          ),
      { message: "unsafe metadata filter path" },
    ),
]) as z.ZodType<MemoryFilterFieldWire>;
const MemoryFilterOperatorSchema = z.enum([
  "eq",
  "ne",
  "in",
  "nin",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "icontains",
  "exists",
]);

export const MemoryFilterConditionSchema = z
  .object({
    field: MemoryFilterFieldSchema,
    operator: MemoryFilterOperatorSchema,
    value: z.union([
      MemoryFilterScalarSchema,
      z.array(MemoryFilterScalarSchema).min(1).max(100),
    ]),
  })
  .strict()
  .superRefine((condition, context) => {
    const values = Array.isArray(condition.value)
      ? condition.value
      : [condition.value];
    if (
      ["in", "nin"].includes(condition.operator) !==
      Array.isArray(condition.value)
    ) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: `${condition.operator} requires a non-empty value array; other operators require one scalar`,
      });
    }
    if (
      condition.operator === "exists" &&
      (Array.isArray(condition.value) || typeof condition.value !== "boolean")
    ) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "exists requires a boolean value",
      });
    }
    if (
      ["contains", "icontains"].includes(condition.operator) &&
      (Array.isArray(condition.value) || typeof condition.value !== "string")
    ) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: `${condition.operator} requires a string value`,
      });
    }
    const metadataField = condition.field.startsWith("metadata.");
    const textField = [
      "id",
      "content",
      "memory_type",
      "subject",
      "attribute",
    ].includes(condition.field);
    if (
      !metadataField &&
      ["gt", "gte", "lt", "lte"].includes(condition.operator) &&
      ![
        "importance",
        "access_count",
        "created_at",
        "updated_at",
        "event_date",
        "last_accessed_at",
      ].includes(condition.field)
    ) {
      context.addIssue({
        code: "custom",
        path: ["operator"],
        message: `${condition.operator} is not supported for ${condition.field}`,
      });
    }
    if (
      !metadataField &&
      ["contains", "icontains"].includes(condition.operator) &&
      !textField
    ) {
      context.addIssue({
        code: "custom",
        path: ["operator"],
        message: `${condition.operator} is not supported for ${condition.field}`,
      });
    }
    if (
      ["importance", "access_count"].includes(condition.field) &&
      condition.operator !== "exists" &&
      values.some((value) => typeof value !== "number")
    ) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: `${condition.field} filters require numeric values`,
      });
    }
    if (
      ["created_at", "updated_at", "event_date", "last_accessed_at"].includes(
        condition.field,
      ) &&
      condition.operator !== "exists" &&
      values.some(
        (value) =>
          typeof value !== "string" ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(
            value,
          ) ||
          Number.isNaN(Date.parse(value)),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: `${condition.field} filters require ISO date strings`,
      });
    }
    if (
      condition.field === "memory_type" &&
      condition.operator !== "exists" &&
      values.some(
        (value) =>
          typeof value !== "string" ||
          !MemoryTypeSchema.options.includes(value as never),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "memory_type contains an unsupported value",
      });
    }
  });

const MemoryFilterExpressionBaseSchema: z.ZodType<MemoryFilterExpressionWire> =
  z.lazy(() =>
    z.union([
      MemoryFilterConditionSchema,
      z
        .object({
          and: z.array(MemoryFilterExpressionBaseSchema).min(1).max(20),
        })
        .strict(),
      z
        .object({
          or: z.array(MemoryFilterExpressionBaseSchema).min(1).max(20),
        })
        .strict(),
      z.object({ not: MemoryFilterExpressionBaseSchema }).strict(),
    ]),
  );

export const MemoryFilterExpressionSchema =
  MemoryFilterExpressionBaseSchema.superRefine((expression, context) => {
    const visit = (
      node: MemoryFilterExpressionWire,
      depth: number,
    ): { depth: number; conditions: number } => {
      if ("field" in node) return { depth, conditions: 1 };
      if ("not" in node) return visit(node.not, depth + 1);
      const children = "and" in node ? node.and : node.or;
      const stats = children.map((child) => visit(child, depth + 1));
      return {
        depth: Math.max(depth, ...stats.map((stat) => stat.depth)),
        conditions: stats.reduce((sum, stat) => sum + stat.conditions, 0),
      };
    };
    const stats = visit(expression, 1);
    if (stats.depth > 8) {
      context.addIssue({
        code: "custom",
        message: "filters supports at most 8 logical levels",
      });
    }
    if (stats.conditions > 100) {
      context.addIssue({
        code: "custom",
        message: "filters supports at most 100 conditions",
      });
    }
  });

export const AddMemoryCommandSchema = z
  .object({
    ...ScopeFields,
    content: NonBlankTextSchema.optional(),
    messages: z.array(MessageSchema).min(1).max(MAX_MEMORY_MESSAGES).optional(),
    infer: z.boolean().default(true),
    event_date: z.string().datetime().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((command) => command.content || command.messages, {
    message: "messages or content is required",
  })
  .refine((command) => command.user_id || command.agent_id || command.run_id, {
    message: "One of user_id, agent_id, run_id is required",
  })
  .superRefine((command, context) => {
    const bytes = new TextEncoder().encode(JSON.stringify(command)).byteLength;
    if (bytes > MAX_MEMORY_ADD_BYTES) {
      context.addIssue({
        code: "custom",
        message: `memory add payload must be at most ${MAX_MEMORY_ADD_BYTES} UTF-8 bytes; use the document API for long sources`,
      });
    }
  });

const SearchMemoryFields = {
  query: z.string().trim().min(1),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  top_k: z.coerce.number().int().min(1).max(50).optional(),
  memory_type: MemoryTypeSchema.optional(),
  mode: SearchModeSchema.optional(),
  search_strategy: SearchStrategySchema.optional(),
  sort_by: SearchSortSchema.optional(),
  min_score: z.coerce.number().finite().min(0).max(1).optional(),
  filters: z
    .union([MemoryFilterExpressionSchema, MetadataFiltersSchema])
    .optional(),
  trace: z.boolean().default(false),
};

export const SearchMemoryCommandSchema = z
  .object({
    ...ScopeFields,
    ...SearchMemoryFields,
  })
  .refine((command) => command.user_id || command.agent_id || command.run_id, {
    message: "One of user_id, agent_id, run_id is required",
  });

/**
 * Authenticated operator surfaces are already isolated by workspace namespace,
 * so they may search the full workspace without weakening the public API's
 * required user/agent/run scope contract.
 */
export const WorkspaceSearchMemoryCommandSchema = z.object(SearchMemoryFields);

const UpdateMemoryFields = {
  content: NonBlankTextSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  importance: z.number().min(0).max(1).optional(),
  memory_type: MemoryTypeSchema.optional(),
  version: z.string().trim().min(1).optional(),
};

function hasMemoryUpdate(command: {
  content?: string;
  metadata?: Record<string, unknown>;
  importance?: number;
  memory_type?: z.infer<typeof MemoryTypeSchema>;
}) {
  return (
    command.content !== undefined ||
    command.metadata !== undefined ||
    command.importance !== undefined ||
    command.memory_type !== undefined
  );
}

export const UpdateMemoryCommandSchema = z
  .object(UpdateMemoryFields)
  .refine(hasMemoryUpdate, { message: "Nothing to update" });

export const MemoryFeedbackRatingSchema = z.enum([
  "positive",
  "negative",
  "very_negative",
]);

export const SetMemoryFeedbackCommandSchema = z.object({
  rating: MemoryFeedbackRatingSchema,
  reason: z.string().trim().min(1).max(2_000).optional(),
  request_id: z.string().trim().min(1).max(200).optional(),
});

export const MAX_MEMORY_BATCH_ITEMS = 1_000;
export const MAX_MEMORY_BATCH_BYTES = 750_000;

const BatchUpdateMemoryItemSchema = z
  .object({
    memory_id: z.string().trim().min(1),
    ...UpdateMemoryFields,
  })
  .refine(hasMemoryUpdate, { message: "Nothing to update" });

const BatchDeleteMemoryItemSchema = z.object({
  memory_id: z.string().trim().min(1),
});

function uniqueMemoryIds(
  command: { memories: Array<{ memory_id: string }> },
  context: z.RefinementCtx,
) {
  const seen = new Set<string>();
  for (const [index, item] of command.memories.entries()) {
    if (seen.has(item.memory_id)) {
      context.addIssue({
        code: "custom",
        message: "memory_id must be unique within a batch",
        path: ["memories", index, "memory_id"],
      });
    }
    seen.add(item.memory_id);
  }
}

function batchFitsDurableTask(
  command: { memories: Array<{ memory_id: string }> },
  context: z.RefinementCtx,
) {
  const bytes = new TextEncoder().encode(JSON.stringify(command)).byteLength;
  if (bytes > MAX_MEMORY_BATCH_BYTES) {
    context.addIssue({
      code: "custom",
      message: `batch payload must be at most ${MAX_MEMORY_BATCH_BYTES} UTF-8 bytes`,
    });
  }
}

export const BatchUpdateMemoriesCommandSchema = z
  .object({
    memories: z
      .array(BatchUpdateMemoryItemSchema)
      .min(1)
      .max(MAX_MEMORY_BATCH_ITEMS),
  })
  .superRefine(uniqueMemoryIds)
  .superRefine(batchFitsDurableTask);

export const BatchDeleteMemoriesCommandSchema = z
  .object({
    memories: z
      .array(BatchDeleteMemoryItemSchema)
      .min(1)
      .max(MAX_MEMORY_BATCH_ITEMS),
  })
  .superRefine(uniqueMemoryIds)
  .superRefine(batchFitsDurableTask);

export const CursorPageSchema = z.object({
  cursor: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const ApiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  request_id: z.string(),
  details: z.unknown().optional(),
});

export const MemorySchema = z.object({
  id: z.string(),
  memory: z.string(),
  memory_type: z.string(),
  importance: z.number(),
  user_id: z.string().nullable(),
  agent_id: z.string().nullable(),
  run_id: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  event_date: z.string().datetime().nullable(),
  valid_from: z.string().datetime().nullable(),
  valid_to: z.string().datetime().nullable(),
  subject: z.string().nullable().optional(),
  attribute: z.string().nullable().optional(),
  superseded_by: z.string().nullable().optional(),
  access_count: z.number().int().nonnegative().optional(),
  last_accessed_at: z.string().datetime().nullable().optional(),
  score: z.number().optional(),
});

export const AddResultSchema = z.object({
  id: z.string(),
  memory: NonBlankTextSchema,
  event: z.enum(["ADD", "UPDATE", "DELETE", "INVALIDATE"]),
});

export const AddMemoryResponseSchema = z
  .object({
    results: z.array(AddResultSchema),
  })
  .superRefine((response, context) => {
    const ids = new Set<string>();
    for (const [index, result] of response.results.entries()) {
      if (ids.has(result.id)) {
        context.addIssue({
          code: "custom",
          message: `results[${index}].id duplicates an earlier memory id`,
          path: ["results", index, "id"],
        });
      }
      ids.add(result.id);
    }
  });

export const AsyncMemoryReceiptSchema = z.object({
  message: z.string(),
  status: z.enum(["PENDING", "RUNNING", "RETRYING", "SUCCEEDED", "FAILED"]),
  event_id: z.string(),
});

export const MemoryEventStatusSchema = z.enum([
  "PENDING",
  "RUNNING",
  "RETRYING",
  "SUCCEEDED",
  "FAILED",
]);

export const MemoryWriteSummarySchema = z.object({
  outcome: z.enum(["STORED", "NO_MEMORY"]),
  planned: z.number().int().nonnegative(),
  persisted: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});

export const MemoryEventSchema = z
  .object({
    id: z.string(),
    event_type: z.literal("ADD"),
    status: MemoryEventStatusSchema,
    scope: z.object({
      user_id: z.string().optional(),
      agent_id: z.string().optional(),
      run_id: z.string().optional(),
    }),
    results: z.array(AddResultSchema),
    write_summary: MemoryWriteSummarySchema.nullable(),
    attempts: z.number().int().nonnegative(),
    max_attempts: z.number().int().positive(),
    error: z.string().nullable(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
    started_at: z.string().datetime().nullable(),
    completed_at: z.string().datetime().nullable(),
    latency_ms: z.number().int().nonnegative().nullable(),
  })
  .superRefine((event, context) => {
    if (event.status === "SUCCEEDED") {
      if (!event.write_summary) {
        context.addIssue({
          code: "custom",
          message: "SUCCEEDED events require a write_summary",
          path: ["write_summary"],
        });
        return;
      }
      if (event.write_summary.planned !== event.results.length) {
        context.addIssue({
          code: "custom",
          message: "write_summary.planned must match the number of results",
          path: ["write_summary", "planned"],
        });
      }
      if (event.write_summary.persisted !== event.results.length) {
        context.addIssue({
          code: "custom",
          message: "write_summary.persisted must match the number of results",
          path: ["write_summary", "persisted"],
        });
      }
      if (event.write_summary.failed !== 0) {
        context.addIssue({
          code: "custom",
          message: "SUCCEEDED events cannot contain failed writes",
          path: ["write_summary", "failed"],
        });
      }
      const expectedOutcome = event.results.length > 0 ? "STORED" : "NO_MEMORY";
      if (event.write_summary.outcome !== expectedOutcome) {
        context.addIssue({
          code: "custom",
          message: `write_summary.outcome must be ${expectedOutcome}`,
          path: ["write_summary", "outcome"],
        });
      }
    } else if (event.write_summary !== null) {
      context.addIssue({
        code: "custom",
        message: "Non-successful events cannot claim a completed write summary",
        path: ["write_summary"],
      });
    }
  });

export const MemoryEventPageSchema = z.object({
  results: z.array(MemoryEventSchema),
  next_cursor: z.string().nullable(),
});

export const MemoryEventListQuerySchema = CursorPageSchema.extend({
  status: MemoryEventStatusSchema.optional(),
});

export const UpdateMemoryResponseSchema = AddResultSchema;

export const DeleteMemoryResponseSchema = z.object({
  id: z.string(),
  deleted: z.literal(true),
});

export const DeleteMemoriesResponseSchema = z.object({
  deleted: z.number().int().nonnegative(),
});

export const MemoryPageSchema = z.object({
  results: z.array(MemorySchema),
  next_cursor: z.string().nullable(),
});

export const ScopeEntitySchema = z.object({
  id: ScopeEntityIdSchema,
  type: ScopeEntityTypeSchema,
  total_memories: z.number().int().positive(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export const ScopeEntityPageSchema = z.object({
  results: z.array(ScopeEntitySchema),
  next_cursor: z.string().nullable(),
});

export const DeleteScopeEntityResponseSchema = z.object({
  id: ScopeEntityIdSchema,
  type: ScopeEntityTypeSchema,
  deleted_memories: z.number().int().positive(),
});

export const BeliefEntrySchema = z.object({
  id: z.string(),
  content: z.string(),
  event_date: z.string().datetime().nullable(),
  valid_from: z.string().datetime().nullable(),
  valid_to: z.string().datetime().nullable(),
  current: z.boolean(),
});

export const BeliefChainSchema = z.object({
  subject: z.string(),
  attribute: z.string(),
  entries: z.array(BeliefEntrySchema),
});

const RankedIdSchema = z.object({
  id: z.string(),
  score: z.number(),
});

export const SearchTraceSchema = z.object({
  lists: z.object({
    vector: z.array(RankedIdSchema),
    fts: z.array(RankedIdSchema),
    graph: z.array(RankedIdSchema),
    temporal: z.array(RankedIdSchema),
  }),
  fused: z.array(RankedIdSchema),
  selected: z.array(z.string()),
  selected_items: z.array(
    z.object({
      id: z.string(),
      content: z.string(),
    }),
  ),
});

export const SearchMemoryResponseSchema = z.object({
  results: z.array(MemorySchema),
  beliefs: z.array(BeliefChainSchema).optional(),
  trace: SearchTraceSchema.optional(),
});

export const MemoryHistoryEntrySchema = z.object({
  id: z.string(),
  memory_id: z.string(),
  event: z.enum(["ADD", "UPDATE", "DELETE", "INVALIDATE", "FEEDBACK", "NONE"]),
  previous_value: z.string().nullable(),
  new_value: z.string().nullable(),
  created_at: z.string().datetime(),
});

export const MemoryHistoryResponseSchema = z.object({
  results: z.array(MemoryHistoryEntrySchema),
});

export const MemoryFeedbackSchema = z.object({
  id: z.string(),
  memory_id: z.string(),
  rating: MemoryFeedbackRatingSchema,
  reason: z.string().nullable(),
  request_id: z.string().nullable(),
  created_at: z.string().datetime(),
});

export const MemoryFeedbackResponseSchema = z.object({
  feedback: MemoryFeedbackSchema.nullable(),
});

export const ClearMemoryFeedbackResponseSchema = z.object({
  cleared: z.boolean(),
});

export const OperationSchema = z.object({
  id: z.string(),
  kind: z.enum([
    "add",
    "update",
    "feedback",
    "invalidate",
    "delete",
    "delete_all",
    "batch_update",
    "batch_delete",
    "purge",
    "import",
    "rebuild",
    "derive",
    "export",
    "maintenance",
    "memory_infer",
    "document_extract",
    "document_ingest",
    "document_delete",
  ]),
  status: z.enum([
    "pending",
    "processing",
    "retry",
    "success",
    "dead",
    "committed",
    "failed",
    "awaiting_upload",
    "cancelled",
  ]),
  raw_status: z.enum(["pending", "ready", "not_requested"]).optional(),
  vector_status: z.enum(["pending", "ready", "not_requested"]).optional(),
  derived_status: z.enum(["pending", "ready", "not_requested"]).optional(),
  attempts: z.number().int().nonnegative(),
  max_attempts: z.number().int().positive().optional(),
  error: z.string().nullable(),
  next_attempt_at: z.string().datetime().nullable().optional(),
  result: z.unknown().nullable().optional(),
  started_at: z.string().datetime().nullable().optional(),
  completed_at: z.string().datetime().nullable().optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export const OperationPageSchema = z.object({
  results: z.array(OperationSchema),
});

export const HealthResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  checked_at: z.string().datetime(),
  engine: z.object({
    configured: z.boolean(),
    initialized: z.boolean(),
    code: z.string().nullable(),
  }),
  operations: z.object({
    pending: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    oldest_pending_at: z.string().datetime().nullable(),
  }),
  tasks: z.object({
    pending: z.number().int().nonnegative(),
    dead: z.number().int().nonnegative(),
    oldest_pending_at: z.string().datetime().nullable(),
  }),
  projections: z.object({
    vector_pending: z.number().int().nonnegative(),
    derived_pending: z.number().int().nonnegative(),
  }),
  warnings: z.object({
    last_24h: z.number().int().nonnegative(),
  }),
});

export const MAX_DOCUMENT_SOURCE_BYTES = 1_000_000;
export const MAX_DOCUMENT_UPLOAD_BYTES = 25_000_000;
export const MAX_DOCUMENT_UPLOAD_PAGES = 300;
export const MAX_DOCUMENT_METADATA_BYTES = 64_000;

const DocumentMetadataSchema = z
  .record(z.string(), z.unknown())
  .refine(
    (metadata) =>
      new TextEncoder().encode(JSON.stringify(metadata)).byteLength <=
      MAX_DOCUMENT_METADATA_BYTES,
    `metadata must be at most ${MAX_DOCUMENT_METADATA_BYTES} UTF-8 bytes`,
  );

export const CreateDocumentUploadCommandSchema = z
  .object({
    ...ScopeFields,
    filename: z.string().trim().min(1).max(500),
    size_bytes: z.number().int().positive().max(MAX_DOCUMENT_UPLOAD_BYTES),
    content_type: z.string().trim().min(1).max(255),
    checksum_sha256: z
      .string()
      .regex(/^[a-fA-F0-9]{64}$/)
      .optional(),
    source_key: z.string().trim().min(1).max(512).optional(),
    title: z.string().trim().min(1).max(500).optional(),
    source_uri: z.string().trim().min(1).max(2_048).optional(),
    metadata: DocumentMetadataSchema.optional(),
  })
  .refine((command) => command.user_id || command.agent_id || command.run_id, {
    message: "One of user_id, agent_id, run_id is required",
  });

export const SourceAssetSchema = z.object({
  id: z.string(),
  operation_id: z.string(),
  source_key: z.string(),
  filename: z.string(),
  content_type: z.string(),
  size_bytes: z.number().int().positive(),
  checksum_sha256: z.string().nullable(),
  status: z.enum([
    "awaiting_upload",
    "uploaded",
    "queued",
    "processing",
    "ready",
    "failed",
    "cancelled",
  ]),
  title: z.string().nullable(),
  source_uri: z.string().nullable(),
  user_id: z.string().nullable(),
  agent_id: z.string().nullable(),
  run_id: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  artifact_id: z.string().nullable(),
  document_id: z.string().nullable(),
  error: z.string().nullable(),
  uploaded_at: z.string().datetime().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export const DocumentUploadInstructionSchema = z.object({
  method: z.literal("PUT"),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()),
  max_bytes: z.number().int().positive(),
});

export const CreateDocumentUploadResponseSchema = z.object({
  source_asset: SourceAssetSchema,
  upload: DocumentUploadInstructionSchema,
  operation: OperationSchema,
});

export const CompleteDocumentUploadResponseSchema = z.object({
  source_asset: SourceAssetSchema,
  operation: OperationSchema,
});

export const IngestDocumentCommandSchema = z
  .object({
    ...ScopeFields,
    source_key: z.string().trim().min(1).max(512),
    content: NonBlankTextSchema.refine(
      (content) =>
        new TextEncoder().encode(content).byteLength <=
        MAX_DOCUMENT_SOURCE_BYTES,
      `content must be at most ${MAX_DOCUMENT_SOURCE_BYTES} UTF-8 bytes`,
    ),
    title: z.string().trim().min(1).max(500).optional(),
    mime_type: z.string().trim().min(1).max(255).optional(),
    source_uri: z.string().trim().min(1).max(2_048).optional(),
    metadata: DocumentMetadataSchema.optional(),
  })
  .refine((command) => command.user_id || command.agent_id || command.run_id, {
    message: "One of user_id, agent_id, run_id is required",
  });

export const DocumentSearchInputSchema = z.object({
  ...ScopeFields,
  query: z.string().trim().min(1),
  limit: z.coerce.number().int().min(1).max(20).default(5),
  neighbors: z.coerce.number().int().min(0).max(2).default(1),
  source_key: z.string().trim().min(1).max(512).optional(),
});

export const SearchDocumentCommandSchema = DocumentSearchInputSchema.refine(
  (command) => command.user_id || command.agent_id || command.run_id,
  {
    message: "One of user_id, agent_id, run_id is required",
  },
);

export const DocumentListInputSchema = z.object({
  ...ScopeFields,
  source_key: z.string().trim().min(1).max(512).optional(),
  cursor: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const ListDocumentQuerySchema = DocumentListInputSchema.refine(
  (command) => command.user_id || command.agent_id || command.run_id,
  {
    message: "One of user_id, agent_id, run_id is required",
  },
);

export const DocumentSchema = z.object({
  id: z.string(),
  source_key: z.string(),
  content_hash: z.string(),
  version_hash: z.string(),
  title: z.string().nullable(),
  mime_type: z.string(),
  source_uri: z.string().nullable(),
  user_id: z.string().nullable(),
  agent_id: z.string().nullable(),
  run_id: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  size_bytes: z.number().int().nonnegative(),
  created_at: z.string().datetime(),
});

export const DocumentContentSchema = z.object({
  id: z.string(),
  content: z.string(),
  content_hash: z.string(),
});

export const DocumentChunkSchema = z.object({
  id: z.string(),
  document_id: z.string(),
  source_key: z.string(),
  index: z.number().int().nonnegative(),
  content: z.string(),
  start_byte: z.number().int().nonnegative(),
  end_byte: z.number().int().nonnegative(),
  content_hash: z.string(),
});

export const DocumentSearchHitSchema = z.object({
  document: DocumentSchema,
  chunk: DocumentChunkSchema,
  neighbors: z.array(DocumentChunkSchema),
  score: z.number(),
});

export const IngestDocumentResponseSchema = z.object({
  document: DocumentSchema,
  chunks: z.number().int().nonnegative(),
  created: z.boolean(),
});

export const DocumentPageSchema = z.object({
  results: z.array(DocumentSchema),
  next_cursor: z.string().nullable(),
});

export const SearchDocumentResponseSchema = z.object({
  results: z.array(DocumentSearchHitSchema),
});

export const DeleteDocumentResponseSchema = z.object({
  id: z.string(),
  deleted: z.literal(true),
  versions: z.number().int().positive(),
  chunks: z.number().int().nonnegative(),
});

export const StateQuerySchema = z
  .object({
    ...ScopeFields,
    subject: z.string().trim().min(1),
    attribute: z.string().trim().min(1),
    as_of: z.string().datetime().optional(),
  })
  .refine((command) => command.user_id || command.agent_id || command.run_id, {
    message: "One of user_id, agent_id, run_id is required",
  });

const QueryBooleanSchema = z.union([
  z.boolean(),
  z.enum(["true", "false"]).transform((value) => value === "true"),
]);

export const BeliefViewModeSchema = z.enum(["default", "conflict", "audit"]);

export const BeliefQuerySchema = z
  .object({
    ...ScopeFields,
    subject: z.string().trim().min(1),
    attribute: z.string().trim().min(1),
    view: BeliefViewModeSchema.default("conflict"),
    applicability_kind: ApplicabilityKindSchema.optional(),
    applicability_key: z.string().trim().min(1).max(1_024).optional(),
    at: z.string().datetime().optional(),
    all_applicability: QueryBooleanSchema.default(false),
  })
  .superRefine((command, refinement) => {
    if (!command.user_id && !command.agent_id && !command.run_id) {
      refinement.addIssue({
        code: "custom",
        message: "One of user_id, agent_id, run_id is required",
      });
    }
    const kind = command.applicability_kind;
    if (kind === "global" && command.applicability_key) {
      refinement.addIssue({
        code: "custom",
        path: ["applicability_key"],
        message: "global applicability must not include a key",
      });
    }
    if (kind && kind !== "global" && !command.applicability_key) {
      refinement.addIssue({
        code: "custom",
        path: ["applicability_key"],
        message: `${kind} applicability requires a key`,
      });
    }
    if (!kind && command.applicability_key) {
      refinement.addIssue({
        code: "custom",
        path: ["applicability_kind"],
        message: "applicability_kind is required with applicability_key",
      });
    }
    if (command.all_applicability && command.view !== "audit") {
      refinement.addIssue({
        code: "custom",
        path: ["all_applicability"],
        message: "all_applicability is available only for audit view",
      });
    }
  });

export const ProfileQuerySchema = z
  .object({
    ...ScopeFields,
    query: z.string().trim().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(20).default(5),
  })
  .refine((command) => command.user_id || command.agent_id || command.run_id, {
    message: "One of user_id, agent_id, run_id is required",
  });

export const StateSlotSchema = z.object({
  id: z.string(),
  subject: z.string(),
  attribute: z.string(),
  value: z.string(),
  valid_from: z.string().datetime(),
  valid_to: z.string().datetime().nullable(),
  superseded_by: z.string().nullable(),
  source_ids: z.array(z.string()),
});

export const StateResponseSchema = z.object({
  data: StateSlotSchema.nullable(),
});

export const StateHistoryResponseSchema = z.object({
  data: z.array(StateSlotSchema),
});

export const BeliefEvidenceSchema = z.object({
  id: z.string(),
  source_id: z.string(),
  evidence_key: z.string(),
  context_id: z.string(),
  applicability: ApplicabilityContextSchema,
  observed_at: z.string().datetime(),
  valid_from: z.string().datetime(),
  valid_to: z.string().datetime().nullable(),
  weight: z.number().gt(0).max(1),
  active: z.boolean(),
});

export const BeliefCandidateSchema = z.object({
  id: z.string(),
  subject: z.string(),
  attribute: z.string(),
  value: z.string(),
  applicability: ApplicabilityContextSchema,
  status: z.enum(["supported", "contested", "superseded"]),
  score: z.number().nonnegative(),
  support: z.number().min(0).max(1),
  evidence_count: z.number().int().nonnegative(),
  context_count: z.number().int().nonnegative(),
  source_ids: z.array(z.string()),
  first_observed_at: z.string().datetime(),
  last_observed_at: z.string().datetime(),
  superseded_by: z.string().nullable(),
  reason_codes: z.array(z.string()),
  evidence: z.array(BeliefEvidenceSchema).optional(),
});

export const BeliefShadowSchema = z.object({
  outcome: z.enum([
    "agreement",
    "disagreement",
    "state_only",
    "belief_only",
    "unresolved",
    "empty",
  ]),
  state: StateSlotSchema.nullable(),
  winner_id: z.string().nullable(),
});

export const BeliefViewSchema = z.object({
  projection_status: z.enum(["ready", "disabled"]),
  mode: BeliefViewModeSchema,
  subject: z.string(),
  attribute: z.string(),
  applicability: ApplicabilityContextSchema,
  winner: BeliefCandidateSchema.nullable(),
  candidates: z.array(BeliefCandidateSchema),
  unresolved: z.boolean(),
  reason_codes: z.array(z.string()),
  shadow: BeliefShadowSchema,
});

export const BeliefResponseSchema = z.object({ data: BeliefViewSchema });

export const ProfileSectionSchema = z.object({
  id: z.string(),
  title: z.string(),
  content: z.string(),
  score: z.number(),
});

export const ProfileResponseSchema = z.object({
  data: z.union([z.string(), z.null(), z.array(ProfileSectionSchema)]),
});

export const ImportMemoryCommandSchema = z.object({
  snapshot: z.record(z.string(), z.unknown()),
});

export type AddMemoryCommand = z.infer<typeof AddMemoryCommandSchema>;
export type AsyncMemoryReceiptWire = z.infer<typeof AsyncMemoryReceiptSchema>;
export type MemoryWriteSummaryWire = z.infer<typeof MemoryWriteSummarySchema>;
export type MemoryEventWire = z.infer<typeof MemoryEventSchema>;
export type MemoryEventPageWire = z.infer<typeof MemoryEventPageSchema>;
export type MemoryEventListQuery = z.infer<typeof MemoryEventListQuerySchema>;
export type SearchMemoryCommand = z.infer<typeof SearchMemoryCommandSchema>;
export type WorkspaceSearchMemoryCommand = z.infer<
  typeof WorkspaceSearchMemoryCommandSchema
>;
export type UpdateMemoryCommand = z.infer<typeof UpdateMemoryCommandSchema>;
export type SetMemoryFeedbackCommand = z.infer<
  typeof SetMemoryFeedbackCommandSchema
>;
export type MemoryFeedbackWire = z.infer<typeof MemoryFeedbackSchema>;
export type BatchUpdateMemoriesCommand = z.infer<
  typeof BatchUpdateMemoriesCommandSchema
>;
export type BatchDeleteMemoriesCommand = z.infer<
  typeof BatchDeleteMemoriesCommandSchema
>;
export type MemoryWire = z.infer<typeof MemorySchema>;
export type ScopeEntityWire = z.infer<typeof ScopeEntitySchema>;
export type ScopeEntityTypeWire = z.infer<typeof ScopeEntityTypeSchema>;
export type AddResultWire = z.infer<typeof AddResultSchema>;
export type StateSlotWire = z.infer<typeof StateSlotSchema>;
export type ApplicabilityContextWire = z.infer<
  typeof ApplicabilityContextSchema
>;
export type BeliefQuery = z.infer<typeof BeliefQuerySchema>;
export type BeliefViewWire = z.infer<typeof BeliefViewSchema>;
export type IngestDocumentCommand = z.infer<typeof IngestDocumentCommandSchema>;
export type CreateDocumentUploadCommand = z.infer<
  typeof CreateDocumentUploadCommandSchema
>;
export type SourceAssetWire = z.infer<typeof SourceAssetSchema>;
export type CreateDocumentUploadResponseWire = z.infer<
  typeof CreateDocumentUploadResponseSchema
>;
export type CompleteDocumentUploadResponseWire = z.infer<
  typeof CompleteDocumentUploadResponseSchema
>;
export type SearchDocumentCommand = z.infer<typeof SearchDocumentCommandSchema>;
export type ListDocumentQuery = z.infer<typeof ListDocumentQuerySchema>;
export type DocumentWire = z.infer<typeof DocumentSchema>;
export type DocumentContentWire = z.infer<typeof DocumentContentSchema>;
export type DocumentSearchHitWire = z.infer<typeof DocumentSearchHitSchema>;
export type IngestDocumentResponseWire = z.infer<
  typeof IngestDocumentResponseSchema
>;
export type DeleteDocumentResponseWire = z.infer<
  typeof DeleteDocumentResponseSchema
>;

const jsonContent = (schema: Record<string, unknown>) => ({
  "application/json": { schema },
});
const schemaRef = (name: string) => ({
  $ref: `#/components/schemas/${name}`,
});
function toOpenApiComponentSchema(name: string, schema: z.ZodType) {
  const rewriteLocalDefinitions = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewriteLocalDefinitions);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        key === "$ref" &&
        typeof child === "string" &&
        child.startsWith("#/$defs/")
          ? `#/components/schemas/${name}/$defs/${child.slice("#/$defs/".length)}`
          : rewriteLocalDefinitions(child),
      ]),
    );
  };
  return rewriteLocalDefinitions(z.toJSONSchema(schema)) as Record<
    string,
    unknown
  >;
}
const documentMultipartSchema = {
  type: "object",
  required: ["file"],
  anyOf: [
    { required: ["user_id"] },
    { required: ["agent_id"] },
    { required: ["run_id"] },
  ],
  properties: {
    file: {
      type: "string",
      format: "binary",
      description: `One valid UTF-8 textual file, at most ${MAX_DOCUMENT_SOURCE_BYTES} bytes.`,
    },
    source_key: {
      type: "string",
      minLength: 1,
      maxLength: 512,
      description: "Stable source identity. Defaults to the uploaded filename.",
    },
    title: { type: "string", minLength: 1, maxLength: 500 },
    mime_type: {
      type: "string",
      description:
        "Optional supported textual media type override. Binary media types are rejected.",
    },
    source_uri: { type: "string", minLength: 1, maxLength: 2_048 },
    metadata: {
      type: "string",
      description: "A JSON-encoded object, up to 64,000 UTF-8 bytes.",
    },
    user_id: { type: "string", minLength: 1 },
    agent_id: { type: "string", minLength: 1 },
    run_id: { type: "string", minLength: 1 },
  },
} as const;
const response = (description: string, schema: Record<string, unknown>) => ({
  description,
  content: jsonContent(schema),
});
const emptyResponse = (description: string) => ({ description });
const errors = {
  "400": response("Invalid request", schemaRef("ApiError")),
  "401": response(
    "Missing, invalid, or expired API key",
    schemaRef("ApiError"),
  ),
  "403": response(
    "API key lacks the required permission",
    schemaRef("ApiError"),
  ),
  "402": response(
    "Hosted project has insufficient credits",
    schemaRef("ApiError"),
  ),
  "429": response("Rate limit exceeded", schemaRef("ApiError")),
  "500": response("Memory engine failure", schemaRef("ApiError")),
};
const scopeParameters = ["user_id", "agent_id", "run_id"].map((name) => ({
  in: "query",
  name,
  required: false,
  schema: { type: "string", minLength: 1 },
}));

export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "FishMem API",
    version: "1.0.0",
    description:
      "Namespace-bound memory, asynchronous inference events, source RAG, state, profile, and operation API.",
  },
  security: [{ bearerAuth: [] }],
  paths: {
    "/v1/health": {
      get: {
        operationId: "getHealth",
        responses: {
          "200": response(
            "Authenticated project readiness and backlog status",
            schemaRef("HealthResponse"),
          ),
          ...errors,
        },
      },
    },
    "/v1/memories": {
      get: {
        operationId: "listMemories",
        parameters: [
          ...scopeParameters,
          { in: "query", name: "cursor", schema: { type: "string" } },
          {
            in: "query",
            name: "limit",
            schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
          },
        ],
        responses: {
          "200": response("Stable cursor page", schemaRef("MemoryPage")),
          ...errors,
        },
      },
      post: {
        operationId: "addMemory",
        description:
          "With infer=true (the default), queues durable LLM extraction and returns an event receipt. With infer=false, stores the supplied text immediately and returns the stored records.",
        parameters: [{ $ref: "#/components/parameters/IdempotencyKey" }],
        requestBody: {
          required: true,
          content: jsonContent(schemaRef("AddMemoryCommand")),
        },
        responses: {
          "200": response(
            "Raw records stored synchronously when infer=false",
            schemaRef("AddMemoryResponse"),
          ),
          "202": response(
            "Memory inference queued; poll the returned event",
            schemaRef("AsyncMemoryReceipt"),
          ),
          "409": response("Idempotency conflict", schemaRef("ApiError")),
          ...errors,
        },
      },
      delete: {
        operationId: "deleteMemories",
        parameters: [
          ...scopeParameters,
          { $ref: "#/components/parameters/IdempotencyKey" },
        ],
        responses: {
          "200": response(
            "Deletion result",
            schemaRef("DeleteMemoriesResponse"),
          ),
          ...errors,
        },
      },
    },
    "/v1/memories/{id}": {
      parameters: [{ $ref: "#/components/parameters/MemoryId" }],
      get: {
        operationId: "getMemory",
        responses: {
          "200": response("Memory", schemaRef("Memory")),
          "404": response("Memory not found", schemaRef("ApiError")),
          ...errors,
        },
      },
      put: {
        operationId: "updateMemory",
        parameters: [{ $ref: "#/components/parameters/IdempotencyKey" }],
        requestBody: {
          required: true,
          content: jsonContent(schemaRef("UpdateMemoryCommand")),
        },
        responses: {
          "200": response(
            "Updated memory result",
            schemaRef("UpdateMemoryResponse"),
          ),
          "404": response("Memory not found", schemaRef("ApiError")),
          "409": response(
            "Version or idempotency conflict",
            schemaRef("ApiError"),
          ),
          ...errors,
        },
      },
      delete: {
        operationId: "deleteMemory",
        parameters: [{ $ref: "#/components/parameters/IdempotencyKey" }],
        responses: {
          "200": response(
            "Tombstone result",
            schemaRef("DeleteMemoryResponse"),
          ),
          "404": response("Memory not found", schemaRef("ApiError")),
          ...errors,
        },
      },
    },
    "/v1/memories/{id}/history": {
      get: {
        operationId: "getMemoryHistory",
        parameters: [{ $ref: "#/components/parameters/MemoryId" }],
        responses: {
          "200": response(
            "Immutable memory history",
            schemaRef("MemoryHistoryResponse"),
          ),
          "404": response("Memory not found", schemaRef("ApiError")),
          ...errors,
        },
      },
    },
    "/v1/memories/{id}/feedback": {
      parameters: [{ $ref: "#/components/parameters/MemoryId" }],
      get: {
        operationId: "getMemoryFeedback",
        description:
          "Returns the current quality signal. The immutable audit trail remains available through memory history.",
        responses: {
          "200": response(
            "Current feedback, or null when no signal is set",
            schemaRef("MemoryFeedbackResponse"),
          ),
          "404": response("Memory not found", schemaRef("ApiError")),
          ...errors,
        },
      },
      post: {
        operationId: "setMemoryFeedback",
        description:
          "Sets a retry-safe quality signal without changing the stored memory or its retrieval projection.",
        parameters: [
          { $ref: "#/components/parameters/RequiredIdempotencyKey" },
        ],
        requestBody: {
          required: true,
          content: jsonContent(schemaRef("SetMemoryFeedbackCommand")),
        },
        responses: {
          "200": response(
            "Current feedback state",
            schemaRef("MemoryFeedbackResponse"),
          ),
          "404": response("Memory not found", schemaRef("ApiError")),
          "409": response("Idempotency conflict", schemaRef("ApiError")),
          ...errors,
        },
      },
      delete: {
        operationId: "clearMemoryFeedback",
        description:
          "Clears the current signal while preserving the feedback audit trail.",
        parameters: [
          { $ref: "#/components/parameters/RequiredIdempotencyKey" },
        ],
        responses: {
          "200": response(
            "Feedback clear result",
            schemaRef("ClearMemoryFeedbackResponse"),
          ),
          "404": response("Memory not found", schemaRef("ApiError")),
          "409": response("Idempotency conflict", schemaRef("ApiError")),
          ...errors,
        },
      },
    },
    "/v1/memories/search": {
      post: {
        operationId: "searchMemories",
        requestBody: {
          required: true,
          content: jsonContent(schemaRef("SearchMemoryCommand")),
        },
        responses: {
          "200": response(
            "Ranked memories and optional retrieval evidence",
            schemaRef("SearchMemoryResponse"),
          ),
          ...errors,
        },
      },
    },
    "/v1/memories/batch": {
      put: {
        operationId: "batchUpdateMemories",
        parameters: [
          { $ref: "#/components/parameters/RequiredIdempotencyKey" },
        ],
        requestBody: {
          required: true,
          content: jsonContent(schemaRef("BatchUpdateMemoriesCommand")),
        },
        responses: {
          "202": response(
            "Durable batch update operation accepted",
            schemaRef("Operation"),
          ),
          "409": response("Idempotency conflict", schemaRef("ApiError")),
          ...errors,
        },
      },
      delete: {
        operationId: "batchDeleteMemories",
        parameters: [
          { $ref: "#/components/parameters/RequiredIdempotencyKey" },
        ],
        requestBody: {
          required: true,
          content: jsonContent(schemaRef("BatchDeleteMemoriesCommand")),
        },
        responses: {
          "202": response(
            "Durable batch delete operation accepted",
            schemaRef("Operation"),
          ),
          "409": response("Idempotency conflict", schemaRef("ApiError")),
          ...errors,
        },
      },
    },
    "/v1/entities": {
      get: {
        operationId: "listScopeEntities",
        description:
          "Lists structural user, agent, and run owners derived from canonical memories. These are distinct from named graph entities.",
        parameters: [
          {
            in: "query",
            name: "type",
            schema: { type: "string", enum: ["user", "agent", "run"] },
          },
          { in: "query", name: "cursor", schema: { type: "string" } },
          {
            in: "query",
            name: "limit",
            schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
          },
        ],
        responses: {
          "200": response(
            "Stable scope-entity page",
            schemaRef("ScopeEntityPage"),
          ),
          ...errors,
        },
      },
    },
    "/v1/entities/{type}/{id}": {
      parameters: [
        { $ref: "#/components/parameters/ScopeEntityType" },
        { $ref: "#/components/parameters/ScopeEntityId" },
      ],
      get: {
        operationId: "getScopeEntity",
        responses: {
          "200": response("Scope entity", schemaRef("ScopeEntity")),
          "404": response("Scope entity not found", schemaRef("ApiError")),
          ...errors,
        },
      },
      delete: {
        operationId: "deleteScopeEntity",
        description:
          "Retry-safely tombstones every canonical memory carrying this structural scope field.",
        parameters: [
          { $ref: "#/components/parameters/RequiredIdempotencyKey" },
        ],
        responses: {
          "200": response(
            "Deleted scope-entity memory count",
            schemaRef("DeleteScopeEntityResponse"),
          ),
          "404": response("Scope entity not found", schemaRef("ApiError")),
          "409": response("Idempotency conflict", schemaRef("ApiError")),
          ...errors,
        },
      },
    },
    "/v1/documents": {
      get: {
        operationId: "listDocuments",
        parameters: [
          ...scopeParameters,
          {
            in: "query",
            name: "source_key",
            schema: { type: "string", minLength: 1, maxLength: 512 },
          },
          { in: "query", name: "cursor", schema: { type: "string" } },
          {
            in: "query",
            name: "limit",
            schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
          },
        ],
        responses: {
          "200": response(
            "Current source versions in a stable cursor page",
            schemaRef("DocumentPage"),
          ),
          ...errors,
        },
      },
      post: {
        operationId: "ingestDocument",
        parameters: [{ $ref: "#/components/parameters/IdempotencyKey" }],
        requestBody: {
          required: true,
          content: {
            ...jsonContent(schemaRef("IngestDocumentCommand")),
            "multipart/form-data": { schema: documentMultipartSchema },
          },
        },
        responses: {
          "200": response(
            "Canonical source version and projection status",
            schemaRef("IngestDocumentResponse"),
          ),
          "413": response(
            "Uploaded textual source exceeds the byte limit",
            schemaRef("ApiError"),
          ),
          "415": response(
            "Unsupported request or document media type",
            schemaRef("ApiError"),
          ),
          "409": response("Idempotency conflict", schemaRef("ApiError")),
          ...errors,
        },
      },
    },
    "/v1/document-uploads": {
      post: {
        operationId: "createDocumentUpload",
        parameters: [
          { $ref: "#/components/parameters/RequiredIdempotencyKey" },
        ],
        requestBody: {
          required: true,
          content: jsonContent(schemaRef("CreateDocumentUploadCommand")),
        },
        responses: {
          "201": response(
            "Durable source asset and authenticated upload target",
            schemaRef("CreateDocumentUploadResponse"),
          ),
          "409": response("Idempotency conflict", schemaRef("ApiError")),
          "413": response(
            "File exceeds the upload limit",
            schemaRef("ApiError"),
          ),
          "415": response("Unsupported file type", schemaRef("ApiError")),
          ...errors,
        },
      },
    },
    "/v1/document-uploads/{id}": {
      get: {
        operationId: "getDocumentUpload",
        parameters: [{ $ref: "#/components/parameters/SourceAssetId" }],
        responses: {
          "200": response("Source asset lifecycle", schemaRef("SourceAsset")),
          "404": response("Source asset not found", schemaRef("ApiError")),
          ...errors,
        },
      },
      delete: {
        operationId: "deleteDocumentUpload",
        description:
          "Cancels and permanently removes an upload that is not currently processing or already indexed.",
        parameters: [{ $ref: "#/components/parameters/SourceAssetId" }],
        responses: {
          "204": emptyResponse(
            "Upload, raw bytes, and extraction artifacts removed",
          ),
          "404": response("Source asset not found", schemaRef("ApiError")),
          "409": response(
            "Source is processing or must be deleted through the document API",
            schemaRef("ApiError"),
          ),
          ...errors,
        },
      },
    },
    "/v1/document-uploads/{id}/content": {
      put: {
        operationId: "putDocumentUploadContent",
        parameters: [{ $ref: "#/components/parameters/SourceAssetId" }],
        requestBody: {
          required: true,
          content: {
            "application/octet-stream": {
              schema: { type: "string", format: "binary" },
            },
          },
        },
        responses: {
          "204": emptyResponse("Binary content stored and integrity-checked"),
          "409": response(
            "Asset is immutable or differs",
            schemaRef("ApiError"),
          ),
          "413": response(
            "File exceeds the upload limit",
            schemaRef("ApiError"),
          ),
          ...errors,
        },
      },
    },
    "/v1/document-uploads/{id}/complete": {
      post: {
        operationId: "completeDocumentUpload",
        parameters: [{ $ref: "#/components/parameters/SourceAssetId" }],
        responses: {
          "202": response(
            "Extraction operation queued",
            schemaRef("CompleteDocumentUploadResponse"),
          ),
          "409": response("Upload is incomplete", schemaRef("ApiError")),
          ...errors,
        },
      },
    },
    "/v1/documents/search": {
      post: {
        operationId: "searchDocuments",
        requestBody: {
          required: true,
          content: jsonContent(schemaRef("SearchDocumentCommand")),
        },
        responses: {
          "200": response(
            "Ranked source chunks with adjacent evidence",
            schemaRef("SearchDocumentResponse"),
          ),
          ...errors,
        },
      },
    },
    "/v1/documents/{id}": {
      parameters: [{ $ref: "#/components/parameters/DocumentId" }],
      get: {
        operationId: "getDocument",
        responses: {
          "200": response("Document descriptor", schemaRef("Document")),
          "404": response("Document not found", schemaRef("ApiError")),
          ...errors,
        },
      },
      delete: {
        operationId: "deleteDocument",
        parameters: [{ $ref: "#/components/parameters/IdempotencyKey" }],
        responses: {
          "200": response(
            "Permanent deletion of the source and every version",
            schemaRef("DeleteDocumentResponse"),
          ),
          "404": response("Document not found", schemaRef("ApiError")),
          "409": response("Idempotency conflict", schemaRef("ApiError")),
          ...errors,
        },
      },
    },
    "/v1/documents/{id}/content": {
      get: {
        operationId: "getDocumentContent",
        parameters: [{ $ref: "#/components/parameters/DocumentId" }],
        responses: {
          "200": response(
            "Exact original UTF-8 source content",
            schemaRef("DocumentContent"),
          ),
          "404": response("Document not found", schemaRef("ApiError")),
          ...errors,
        },
      },
    },
    "/v1/operations": {
      get: {
        operationId: "listOperations",
        parameters: [
          {
            in: "query",
            name: "limit",
            schema: { type: "integer", minimum: 1, maximum: 100 },
          },
        ],
        responses: {
          "200": response("Operations", schemaRef("OperationPage")),
          ...errors,
        },
      },
    },
    "/v1/operations/{id}": {
      get: {
        operationId: "getOperation",
        parameters: [{ $ref: "#/components/parameters/OperationId" }],
        responses: {
          "200": response("Operation", schemaRef("Operation")),
          "404": response("Operation not found", schemaRef("ApiError")),
          ...errors,
        },
      },
    },
    "/v1/operations/{id}/retry": {
      post: {
        operationId: "retryOperation",
        description:
          "Redrives a retryable or dead operation from its durable D1 state.",
        parameters: [{ $ref: "#/components/parameters/OperationId" }],
        responses: {
          "202": response("Operation redrive accepted", schemaRef("Operation")),
          "404": response(
            "Operation is missing or not retryable",
            schemaRef("ApiError"),
          ),
          ...errors,
        },
      },
    },
    "/v1/events": {
      get: {
        operationId: "listMemoryEvents",
        description:
          "Lists durable memory-inference events without exposing the original conversation payload.",
        parameters: [
          { in: "query", name: "cursor", schema: { type: "string" } },
          {
            in: "query",
            name: "limit",
            schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
          },
          {
            in: "query",
            name: "status",
            schema: {
              type: "string",
              enum: ["PENDING", "RUNNING", "RETRYING", "SUCCEEDED", "FAILED"],
            },
          },
        ],
        responses: {
          "200": response(
            "Stable cursor page of memory-inference events",
            schemaRef("MemoryEventPage"),
          ),
          ...errors,
        },
      },
    },
    "/v1/events/{id}": {
      get: {
        operationId: "getMemoryEvent",
        parameters: [{ $ref: "#/components/parameters/EventId" }],
        responses: {
          "200": response("Memory-inference event", schemaRef("MemoryEvent")),
          "404": response("Event not found", schemaRef("ApiError")),
          ...errors,
        },
      },
    },
    "/v1/exports": {
      post: {
        operationId: "createExport",
        parameters: [
          { $ref: "#/components/parameters/RequiredIdempotencyKey" },
        ],
        responses: {
          "202": response("Export operation accepted", schemaRef("Operation")),
          ...errors,
        },
      },
    },
    "/v1/imports": {
      post: {
        operationId: "createImport",
        parameters: [
          { $ref: "#/components/parameters/RequiredIdempotencyKey" },
        ],
        requestBody: {
          required: true,
          content: jsonContent(schemaRef("ImportMemoryCommand")),
        },
        responses: {
          "202": response("Import operation accepted", schemaRef("Operation")),
          ...errors,
        },
      },
    },
    "/v1/state": {
      get: {
        operationId: "getState",
        parameters: [
          ...scopeParameters,
          {
            in: "query",
            name: "subject",
            required: true,
            schema: { type: "string" },
          },
          {
            in: "query",
            name: "attribute",
            required: true,
            schema: { type: "string" },
          },
          {
            in: "query",
            name: "as_of",
            schema: { type: "string", format: "date-time" },
          },
        ],
        responses: {
          "200": response(
            "Current or historical state",
            schemaRef("StateResponse"),
          ),
          ...errors,
        },
      },
    },
    "/v1/beliefs": {
      get: {
        operationId: "getBeliefView",
        parameters: [
          ...scopeParameters,
          {
            in: "query",
            name: "subject",
            required: true,
            schema: { type: "string" },
          },
          {
            in: "query",
            name: "attribute",
            required: true,
            schema: { type: "string" },
          },
          {
            in: "query",
            name: "view",
            schema: {
              type: "string",
              enum: ["default", "conflict", "audit"],
              default: "conflict",
            },
          },
          {
            in: "query",
            name: "applicability_kind",
            schema: {
              type: "string",
              enum: [
                "global",
                "project",
                "task",
                "conversation",
                "channel",
                "custom",
              ],
            },
          },
          {
            in: "query",
            name: "applicability_key",
            schema: { type: "string" },
          },
          {
            in: "query",
            name: "at",
            schema: { type: "string", format: "date-time" },
          },
          {
            in: "query",
            name: "all_applicability",
            schema: { type: "boolean", default: false },
          },
        ],
        responses: {
          "200": response(
            "Governed inferred-belief shadow, conflict, or audit view",
            schemaRef("BeliefResponse"),
          ),
          ...errors,
        },
      },
    },
    "/v1/state/history": {
      get: {
        operationId: "getStateHistory",
        parameters: [
          ...scopeParameters,
          {
            in: "query",
            name: "subject",
            required: true,
            schema: { type: "string" },
          },
          {
            in: "query",
            name: "attribute",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": response("State history", schemaRef("StateHistoryResponse")),
          ...errors,
        },
      },
    },
    "/v1/profile": {
      get: {
        operationId: "getProfile",
        parameters: [
          ...scopeParameters,
          { in: "query", name: "query", schema: { type: "string" } },
          {
            in: "query",
            name: "limit",
            schema: { type: "integer", minimum: 1, maximum: 20 },
          },
        ],
        responses: {
          "200": response(
            "Profile or relevant profile sections",
            schemaRef("ProfileResponse"),
          ),
          ...errors,
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "FishMem API key",
      },
    },
    parameters: {
      IdempotencyKey: {
        in: "header",
        name: "Idempotency-Key",
        required: false,
        description:
          "Makes a mutation retry-safe. Required by FishMem Cloud writes and strongly recommended when self-hosting.",
        schema: { type: "string", minLength: 1, maxLength: 200 },
      },
      RequiredIdempotencyKey: {
        in: "header",
        name: "Idempotency-Key",
        required: true,
        description: "Required retry identity for durable mutations.",
        schema: { type: "string", minLength: 1, maxLength: 200 },
      },
      MemoryId: {
        in: "path",
        name: "id",
        required: true,
        schema: { type: "string" },
      },
      OperationId: {
        in: "path",
        name: "id",
        required: true,
        schema: { type: "string" },
      },
      EventId: {
        in: "path",
        name: "id",
        required: true,
        schema: { type: "string" },
      },
      DocumentId: {
        in: "path",
        name: "id",
        required: true,
        schema: { type: "string" },
      },
      SourceAssetId: {
        in: "path",
        name: "id",
        required: true,
        schema: { type: "string" },
      },
      ScopeEntityType: {
        in: "path",
        name: "type",
        required: true,
        schema: { type: "string", enum: ["user", "agent", "run"] },
      },
      ScopeEntityId: {
        in: "path",
        name: "id",
        required: true,
        schema: { type: "string", minLength: 1, maxLength: 512 },
      },
    },
    schemas: {
      AddMemoryCommand: z.toJSONSchema(AddMemoryCommandSchema),
      SearchMemoryCommand: toOpenApiComponentSchema(
        "SearchMemoryCommand",
        SearchMemoryCommandSchema,
      ),
      UpdateMemoryCommand: z.toJSONSchema(UpdateMemoryCommandSchema),
      BatchUpdateMemoriesCommand: z.toJSONSchema(
        BatchUpdateMemoriesCommandSchema,
      ),
      BatchDeleteMemoriesCommand: z.toJSONSchema(
        BatchDeleteMemoriesCommandSchema,
      ),
      ImportMemoryCommand: z.toJSONSchema(ImportMemoryCommandSchema),
      ApiError: z.toJSONSchema(ApiErrorSchema),
      Memory: z.toJSONSchema(MemorySchema),
      AddResult: z.toJSONSchema(AddResultSchema),
      AddMemoryResponse: z.toJSONSchema(AddMemoryResponseSchema),
      AsyncMemoryReceipt: z.toJSONSchema(AsyncMemoryReceiptSchema),
      MemoryWriteSummary: z.toJSONSchema(MemoryWriteSummarySchema),
      MemoryEvent: z.toJSONSchema(MemoryEventSchema),
      MemoryEventPage: z.toJSONSchema(MemoryEventPageSchema),
      UpdateMemoryResponse: z.toJSONSchema(UpdateMemoryResponseSchema),
      DeleteMemoryResponse: z.toJSONSchema(DeleteMemoryResponseSchema),
      DeleteMemoriesResponse: z.toJSONSchema(DeleteMemoriesResponseSchema),
      MemoryPage: z.toJSONSchema(MemoryPageSchema),
      ScopeEntity: z.toJSONSchema(ScopeEntitySchema),
      ScopeEntityPage: z.toJSONSchema(ScopeEntityPageSchema),
      DeleteScopeEntityResponse: z.toJSONSchema(
        DeleteScopeEntityResponseSchema,
      ),
      SearchMemoryResponse: z.toJSONSchema(SearchMemoryResponseSchema),
      MemoryHistoryResponse: z.toJSONSchema(MemoryHistoryResponseSchema),
      SetMemoryFeedbackCommand: z.toJSONSchema(SetMemoryFeedbackCommandSchema),
      MemoryFeedback: z.toJSONSchema(MemoryFeedbackSchema),
      MemoryFeedbackResponse: z.toJSONSchema(MemoryFeedbackResponseSchema),
      ClearMemoryFeedbackResponse: z.toJSONSchema(
        ClearMemoryFeedbackResponseSchema,
      ),
      Operation: z.toJSONSchema(OperationSchema),
      OperationPage: z.toJSONSchema(OperationPageSchema),
      HealthResponse: z.toJSONSchema(HealthResponseSchema),
      CreateDocumentUploadCommand: z.toJSONSchema(
        CreateDocumentUploadCommandSchema,
      ),
      SourceAsset: z.toJSONSchema(SourceAssetSchema),
      CreateDocumentUploadResponse: z.toJSONSchema(
        CreateDocumentUploadResponseSchema,
      ),
      CompleteDocumentUploadResponse: z.toJSONSchema(
        CompleteDocumentUploadResponseSchema,
      ),
      IngestDocumentCommand: z.toJSONSchema(IngestDocumentCommandSchema),
      SearchDocumentCommand: z.toJSONSchema(SearchDocumentCommandSchema),
      Document: z.toJSONSchema(DocumentSchema),
      DocumentContent: z.toJSONSchema(DocumentContentSchema),
      DocumentChunk: z.toJSONSchema(DocumentChunkSchema),
      DocumentSearchHit: z.toJSONSchema(DocumentSearchHitSchema),
      IngestDocumentResponse: z.toJSONSchema(IngestDocumentResponseSchema),
      DocumentPage: z.toJSONSchema(DocumentPageSchema),
      SearchDocumentResponse: z.toJSONSchema(SearchDocumentResponseSchema),
      DeleteDocumentResponse: z.toJSONSchema(DeleteDocumentResponseSchema),
      StateQuery: z.toJSONSchema(StateQuerySchema),
      StateSlot: z.toJSONSchema(StateSlotSchema),
      StateResponse: z.toJSONSchema(StateResponseSchema),
      StateHistoryResponse: z.toJSONSchema(StateHistoryResponseSchema),
      ApplicabilityContext: z.toJSONSchema(ApplicabilityContextSchema),
      BeliefEvidence: z.toJSONSchema(BeliefEvidenceSchema),
      BeliefCandidate: z.toJSONSchema(BeliefCandidateSchema),
      BeliefShadow: z.toJSONSchema(BeliefShadowSchema),
      BeliefView: z.toJSONSchema(BeliefViewSchema),
      BeliefResponse: z.toJSONSchema(BeliefResponseSchema),
      ProfileQuery: z.toJSONSchema(ProfileQuerySchema),
      ProfileSection: z.toJSONSchema(ProfileSectionSchema),
      ProfileResponse: z.toJSONSchema(ProfileResponseSchema),
    },
  },
} as const;
