import { AsyncLocalStorage } from "node:async_hooks";

type UsageKind = "chat" | "embedding";

interface PriceRate {
  input: number;
  cachedInput?: number;
  output?: number;
}

export interface BenchmarkProviderUsageRecord {
  scope?: string;
  kind: UsageKind;
  model: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  failed: boolean;
}

export interface BenchmarkUsage {
  llmCalls: number;
  embeddingCalls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  estimatedUsd?: number;
  unscopedCalls: number;
  unmeteredCalls: number;
  unpricedCalls: number;
  failedCalls: number;
  priceSnapshot: typeof PRICE_SNAPSHOT;
  byModel: Record<
    string,
    { calls: number; inputTokens: number; outputTokens: number }
  >;
}

export const USAGE_SCHEMA_VERSION = "provider-response-v5-priced-subtotal";

export const PRICE_SNAPSHOT = {
  asOf: "2026-08-22",
  currency: "USD",
  unit: "per_1m_tokens",
  source: "https://developers.openai.com/api/docs/models",
  models: {
    "gpt-4o-mini": { input: 0.15, cachedInput: 0.075, output: 0.6 },
    "gpt-4o": { input: 2.5, cachedInput: 1.25, output: 10 },
    "gpt-4.1-mini": { input: 0.4, cachedInput: 0.1, output: 1.6 },
    "gpt-5.6-sol": { input: 5, cachedInput: 0.5, output: 30 },
    "gpt-5.6-terra": { input: 2, cachedInput: 0.2, output: 12 },
    "gpt-5.6-luna": { input: 0.2, cachedInput: 0.02, output: 1.2 },
    "text-embedding-3-small": { input: 0.02 },
    "text-embedding-3-large": { input: 0.13 },
    "text-embedding-ada-002": { input: 0.1 },
  } satisfies Record<string, PriceRate>,
} as const;

export interface OpenAIUsageMeter {
  run<T>(scope: string, operation: () => T): T;
  /** Record provider usage that happened outside this process' fetch transport. */
  record(record: Omit<BenchmarkProviderUsageRecord, "scope">): void;
  summary(scopePrefix: string): BenchmarkUsage;
  unscopedCalls(): number;
  restore(): void;
}

export function usageDelta(
  before: BenchmarkUsage,
  after: BenchmarkUsage,
): BenchmarkUsage {
  return combineUsage(after, before, -1);
}

export function mergeBenchmarkUsage(parts: BenchmarkUsage[]): BenchmarkUsage {
  return parts.reduce(
    (total, part) => combineUsage(total, part, 1),
    emptyUsage(),
  );
}

export function assertNoFailedProviderCalls(
  usage: BenchmarkUsage,
  unit: string,
): void {
  if (usage.failedCalls > 0) {
    throw new Error(
      `${unit} had ${usage.failedCalls} failed provider call(s); unit was not checkpointed`,
    );
  }
}

export function installOpenAIUsageMeter(): OpenAIUsageMeter {
  const storage = new AsyncLocalStorage<string>();
  const records: BenchmarkProviderUsageRecord[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const kind = requestKind(args[0]);
    const scope = storage.getStore();
    let response: Response;
    try {
      response = await originalFetch(...args);
    } catch (error) {
      if (kind) records.push({ scope, kind, model: "unknown", failed: true });
      throw error;
    }
    if (!kind) return response;
    if (!response.ok) {
      records.push({ scope, kind, model: "unknown", failed: true });
      return response;
    }
    const payload = await response
      .clone()
      .json()
      .catch(() => undefined);
    records.push(recordFromResponse(scope, kind, payload));
    return response;
  }) as typeof fetch;

  return {
    run: (scope, operation) => storage.run(scope, operation),
    record: (record) => records.push({ ...record, scope: storage.getStore() }),
    summary: (scopePrefix) => summarize(records, scopePrefix),
    unscopedCalls: () => records.filter((record) => !record.scope).length,
    restore() {
      if (globalThis.fetch === originalFetch) return;
      globalThis.fetch = originalFetch;
    },
  };
}

function requestKind(
  input: Parameters<typeof fetch>[0],
): UsageKind | undefined {
  const raw =
    typeof input === "string" || input instanceof URL ? input : input.url;
  const path = new URL(String(raw)).pathname.replace(/\/+$/, "");
  if (path.endsWith("/chat/completions")) return "chat";
  if (path.endsWith("/responses")) return "chat";
  if (path.endsWith("/embeddings")) return "embedding";
  return undefined;
}

function recordFromResponse(
  scope: string | undefined,
  kind: UsageKind,
  value: unknown,
): BenchmarkProviderUsageRecord {
  if (!isObject(value)) {
    return { scope, kind, model: "unknown", failed: false };
  }
  const usage = isObject(value.usage) ? value.usage : undefined;
  const details = usage
    ? isObject(usage.prompt_tokens_details)
      ? usage.prompt_tokens_details
      : isObject(usage.input_tokens_details)
        ? usage.input_tokens_details
        : undefined
    : undefined;
  return {
    scope,
    kind,
    model: typeof value.model === "string" ? value.model : "unknown",
    inputTokens: finiteNumber(
      usage?.prompt_tokens ?? usage?.input_tokens ?? usage?.total_tokens,
    ),
    cachedInputTokens: finiteNumber(details?.cached_tokens) ?? 0,
    outputTokens:
      finiteNumber(usage?.completion_tokens ?? usage?.output_tokens) ?? 0,
    failed: false,
  };
}

function summarize(
  records: BenchmarkProviderUsageRecord[],
  scopePrefix: string,
): BenchmarkUsage {
  const selected = records.filter(
    (record) =>
      record.scope === scopePrefix ||
      record.scope?.startsWith(`${scopePrefix}/`),
  );
  const successful = selected.filter((record) => !record.failed);
  const failedCalls = selected.length - successful.length;
  let estimatedUsd = 0;
  let unmeteredCalls = 0;
  let unpricedCalls = 0;
  const byModel: BenchmarkUsage["byModel"] = {};
  for (const record of successful) {
    if (record.inputTokens === undefined) unmeteredCalls++;
    const rate = priceFor(record.model);
    if (!rate) unpricedCalls++;
    if (record.inputTokens !== undefined && rate) {
      const cached = Math.min(
        record.inputTokens,
        record.cachedInputTokens ?? 0,
      );
      estimatedUsd +=
        ((record.inputTokens - cached) * rate.input +
          cached * (rate.cachedInput ?? rate.input) +
          (record.outputTokens ?? 0) * (rate.output ?? 0)) /
        1_000_000;
    }
    const model = (byModel[record.model] ??= {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
    model.calls++;
    model.inputTokens += record.inputTokens ?? 0;
    model.outputTokens += record.outputTokens ?? 0;
  }
  return {
    llmCalls: successful.filter((record) => record.kind === "chat").length,
    embeddingCalls: successful.filter((record) => record.kind === "embedding")
      .length,
    inputTokens: sum(successful, "inputTokens"),
    cachedInputTokens: sum(successful, "cachedInputTokens"),
    outputTokens: sum(successful, "outputTokens"),
    // Keep the subtotal for every priced, metered call even when a separate
    // subscription-backed provider has no per-token USD price. `unpricedCalls`
    // remains mandatory evidence so the subtotal cannot be mistaken for total
    // workload cost.
    ...(unmeteredCalls === 0 ? { estimatedUsd } : {}),
    unscopedCalls: 0,
    unmeteredCalls,
    unpricedCalls,
    failedCalls,
    priceSnapshot: PRICE_SNAPSHOT,
    byModel,
  };
}

function combineUsage(
  left: BenchmarkUsage,
  right: BenchmarkUsage,
  direction: 1 | -1,
): BenchmarkUsage {
  const byModel: BenchmarkUsage["byModel"] = structuredClone(left.byModel);
  for (const [name, value] of Object.entries(right.byModel)) {
    const target = (byModel[name] ??= {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
    target.calls += direction * value.calls;
    target.inputTokens += direction * value.inputTokens;
    target.outputTokens += direction * value.outputTokens;
  }
  const bothPriced =
    left.estimatedUsd !== undefined && right.estimatedUsd !== undefined;
  return {
    llmCalls: left.llmCalls + direction * right.llmCalls,
    embeddingCalls: left.embeddingCalls + direction * right.embeddingCalls,
    inputTokens: left.inputTokens + direction * right.inputTokens,
    cachedInputTokens:
      left.cachedInputTokens + direction * right.cachedInputTokens,
    outputTokens: left.outputTokens + direction * right.outputTokens,
    ...(bothPriced
      ? { estimatedUsd: left.estimatedUsd! + direction * right.estimatedUsd! }
      : {}),
    unscopedCalls: left.unscopedCalls + direction * right.unscopedCalls,
    unmeteredCalls: left.unmeteredCalls + direction * right.unmeteredCalls,
    unpricedCalls: left.unpricedCalls + direction * right.unpricedCalls,
    failedCalls: left.failedCalls + direction * right.failedCalls,
    priceSnapshot: PRICE_SNAPSHOT,
    byModel,
  };
}

function emptyUsage(): BenchmarkUsage {
  return {
    llmCalls: 0,
    embeddingCalls: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    estimatedUsd: 0,
    unscopedCalls: 0,
    unmeteredCalls: 0,
    unpricedCalls: 0,
    failedCalls: 0,
    priceSnapshot: PRICE_SNAPSHOT,
    byModel: {},
  };
}

function priceFor(model: string): PriceRate | undefined {
  for (const [name, rate] of Object.entries(PRICE_SNAPSHOT.models).sort(
    ([left], [right]) => right.length - left.length,
  )) {
    if (model === name || model.startsWith(`${name}-20`)) return rate;
  }
  return undefined;
}

function sum(
  records: BenchmarkProviderUsageRecord[],
  key: keyof BenchmarkProviderUsageRecord,
): number {
  return records.reduce((total, record) => {
    const value = record[key];
    return total + (typeof value === "number" ? value : 0);
  }, 0);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
