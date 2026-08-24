/**
 * Memory-system adapters. Both systems get identical inputs (same chunked
 * messages, same userId, same models) so the comparison isolates the memory
 * layer: verbatim storage, derivation overlays, and retrieval.
 */

import { capOpenAIEmbeddingRequest } from "../embedding-input.js";
import type { BenchmarkReasoningEffort } from "../llm-provider.js";

export interface BenchMessage {
  role: "user" | "assistant";
  content: string;
}

export interface RetrievedMemory {
  text: string;
  score?: number;
}

export interface AdapterDiagnostics {
  warningCounts: Record<string, number>;
  retries: number;
  timeouts: number;
}

export function mergeAdapterDiagnostics(
  diagnostics: AdapterDiagnostics[],
): AdapterDiagnostics {
  const warningCounts: Record<string, number> = {};
  let retries = 0;
  let timeouts = 0;
  for (const entry of diagnostics) {
    retries += entry.retries;
    timeouts += entry.timeouts;
    for (const [code, count] of Object.entries(entry.warningCounts)) {
      warningCounts[code] = (warningCounts[code] ?? 0) + count;
    }
  }
  return { warningCounts, retries, timeouts };
}

export interface MemoryAdapter {
  name: string;
  init(): Promise<void>;
  /** Ingest one chunk of conversation turns. Returns #memories created. */
  add(messages: BenchMessage[], userId: string): Promise<number>;
  /** Retrieve top-k memories for a question. */
  search(
    query: string,
    userId: string,
    topK: number,
  ): Promise<RetrievedMemory[]>;
  /** Optional hook called after each conversation session is ingested. */
  endSession?(userId: string): Promise<void>;
  /** Trace of the most recent search (fishmem only, when enabled). */
  lastTrace?(): unknown;
  /**
   * Swap the search configuration WITHOUT touching the ingested stores
   * (fishmem only): same memories, same vectors, different retrieval — the
   * basis for properly paired search-side ablation.
   */
  setSearchOverrides?(overrides: Record<string, unknown>): Promise<void>;
  /** Return diagnostics since the previous drain and reset the counters. */
  drainDiagnostics(): AdapterDiagnostics;
  close(): Promise<void>;
}

export function createDiagnosticsTracker() {
  let warningCounts: Record<string, number> = {};
  let retries = 0;
  let timeouts = 0;
  return {
    warning(code: string) {
      warningCounts[code] = (warningCounts[code] ?? 0) + 1;
    },
    retry() {
      retries++;
    },
    timeout() {
      timeouts++;
    },
    drain(): AdapterDiagnostics {
      const snapshot = { warningCounts, retries, timeouts };
      warningCounts = {};
      retries = 0;
      timeouts = 0;
      return snapshot;
    },
  };
}

interface Mem0AddResponse {
  results?: unknown[];
}

interface Mem0SearchResponse {
  results?: Array<{
    memory: string;
    score?: number;
    metadata?: { eventDate?: string };
  }>;
}

export interface AdapterConfig {
  llmModel: string;
  /** Explicit write/extraction reasoning budget for supported LLMs. */
  llmReasoningEffort?: BenchmarkReasoningEffort;
  embedderModel: string;
  apiKey: string;
  /** Custom OpenAI-compatible endpoint (proxy support). */
  baseURL?: string;
  /** Use offline mock providers (fishmem only) — pipeline smoke test. */
  mock?: boolean;
  /** Record per-source retrieval traces (fishmem only). */
  trace?: boolean;
  /** Memory.create config overrides (fishmem only) — ablation toggles. */
  overrides?: Record<string, unknown>;
  usageScope?: string;
  providerFetch?: typeof fetch;
  runWithUsageScope?<T>(scope: string, operation: () => Promise<T>): Promise<T>;
  providerTimeoutMs?: number;
  operationTimeoutMs?: number;
  providerRetries?: number;
  operationRetries?: number;
}

// ── fishmem ────────────────────────────────────────────────────────────────────

export async function createFishmemAdapter(
  cfg: AdapterConfig,
): Promise<MemoryAdapter> {
  const diagnostics = createDiagnosticsTracker();
  const { Memory, classifySearchIntent } = await import(
    "../../packages/fishmem/src/index.js"
  );
  const strategyOf = (overrides?: Record<string, unknown>) =>
    (overrides as { search?: { searchStrategy?: string } } | undefined)?.search
      ?.searchStrategy;
  const profileOf = (overrides?: Record<string, unknown>) =>
    (
      overrides as
        | { profile?: { sectionRecall?: boolean; maxSections?: number } }
        | undefined
    )?.profile;
  let activeSearchStrategy = strategyOf(cfg.overrides);
  let activeProfile = profileOf(cfg.overrides);
  // `contextMode` is an ADAPTER-only knob (not an engine search option): it
  // gates the injected user-profile + chronology WITHOUT touching retrieval, so
  // it cleanly isolates "trim the answer context" from the engine's
  // precision/recall retrieval routing. Modes: "full" = always inject; "gated"
  // (DEFAULT) = skip for single-fact queries; "lean" = never inject. Read from
  // the overrides object but STRIPPED before the config reaches the engine.
  //
  // Default is "gated" from a same-store paired ablation (2026-06-18, 2 convs):
  // gating cuts answer context from ~713→376 tok (≈ mem0's 328, ~47% less) at
  // overall −3.9pt (p=0.078, within ingest noise) — single-fact answers don't
  // use the profile/chronology, so dropping it for them is ~free. NOTE it does
  // NOT fix the single-hop gap vs mem0 (lean==full on single-hop): that gap is
  // retrieval-side, not context. See [[mem0-store-not-in-memory]] notes.
  const ctxModeOf = (o?: Record<string, unknown>) =>
    (o as { contextMode?: "full" | "gated" | "lean" } | undefined)?.contextMode;
  const stripCtxMode = (o?: Record<string, unknown>) => {
    const { contextMode: _drop, ...rest } = (o ?? {}) as Record<
      string,
      unknown
    >;
    return rest;
  };
  // FishMem performs one canonical extraction pass for every benchmark chunk.
  // Context injection remains an adapter-only ablation knob.
  let activeContextMode: "full" | "gated" | "lean" =
    ctxModeOf(cfg.overrides) ?? "lean";
  let memory = await Memory.create(
    cfg.mock
      ? {
          ...stripCtxMode(cfg.overrides),
          embedder: { provider: "mock" },
          llm: { provider: "mock" },
          vectorStore: { provider: "memory" },
          graphStore: { provider: "memory" },
          onWarning: (warning: { code: string }) =>
            diagnostics.warning(warning.code),
        }
      : {
          ...stripCtxMode(cfg.overrides),
          embedder: {
            provider: "openai",
            config: {
              apiKey: cfg.apiKey,
              model: cfg.embedderModel,
              timeoutMs: cfg.providerTimeoutMs,
              maxRetries: cfg.providerRetries,
              ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
            },
          },
          llm: {
            provider: "openai",
            config: {
              apiKey: cfg.apiKey,
              model: cfg.llmModel,
              ...(cfg.llmReasoningEffort
                ? { reasoningEffort: cfg.llmReasoningEffort }
                : {}),
              timeoutMs: cfg.providerTimeoutMs,
              maxRetries: cfg.providerRetries,
              ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
            },
          },
          vectorStore: { provider: "memory" },
          graphStore: { provider: "memory" },
          onWarning: (warning: { code: string }) =>
            diagnostics.warning(warning.code),
        },
  );
  let lastTrace: unknown;
  return {
    name: "fishmem",
    lastTrace: () => lastTrace,
    async init() {},
    async add(messages, userId) {
      // Preserve the ordered user/assistant turns exactly as supplied to mem0.
      // Memory.add performs one extraction pass; derivation, when enabled
      // through overrides, reuses that same result.
      const res = await memory.add(messages, { userId });
      return res.results.length;
    },
    async search(query, userId, topK) {
      const intent = classifySearchIntent(query);
      const precisionContext =
        activeSearchStrategy === "precision" ||
        (activeSearchStrategy === "auto" && intent === "single_fact");
      // Whether to OMIT the heavy profile + chronology context. Triggered by
      // precision retrieval (existing) OR purely by context mode (new, retrieval
      // untouched): "lean" always omits, "gated" omits for single-fact queries
      // — the token-parity lever, since that extra context only dilutes simple
      // single-fact lookups while it helps temporal/relational ones.
      const trimContext =
        precisionContext ||
        activeContextMode === "lean" ||
        (activeContextMode === "gated" && intent === "single_fact");
      const res = await memory.search(query, {
        userId,
        limit: topK,
        ...(cfg.trace ? { trace: true } : {}),
      });
      lastTrace = res.trace;
      const out: RetrievedMemory[] = res.results.map((r) => ({
        text: renderWithDates(r.memory),
        score: r.score,
      }));
      // Compact chronology of the dated results — cheap, helps "X after Y"
      // ordering questions without disturbing the relevance order above.
      const dated = trimContext
        ? []
        : res.results
            .filter((r) => r.memory.eventDate)
            .sort(
              (a, b) =>
                a.memory.eventDate!.getTime() - b.memory.eventDate!.getTime(),
            );
      if (dated.length >= 2) {
        const line = dated
          .map(
            (r) =>
              `${r.memory.eventDate!.toISOString().slice(0, 10)}: ${r.memory.content.slice(0, 60)}`,
          )
          .join(" | ");
        out.push({ text: `CHRONOLOGY of the dated memories above: ${line}` });
      }
      // Letta/Memobase-style always-injected profile: synthesis of identity,
      // preferences, and per-topic aggregations that top-k retrieval misses.
      if (!trimContext && activeProfile?.sectionRecall) {
        const sections = await memory.getProfileSections(
          query,
          { userId },
          {
            limit: activeProfile.maxSections,
          },
        );
        if (sections.length) {
          out.unshift({
            text: `USER PROFILE SECTIONS (synthesized, query-selected):\n${sections
              .map((s) => s.content)
              .join("\n\n")}`,
          });
        }
      } else if (!trimContext) {
        const profile = await memory.getProfile({ userId });
        if (profile) {
          out.unshift({ text: `USER PROFILE (synthesized):\n${profile}` });
        }
      }
      return out;
    },
    async endSession(userId) {
      // The standard benchmark adapter uses lean answer context and therefore
      // never reads a synthesized profile. Avoid paying for a profile that
      // cannot affect any answer. Full/gated profile experiments still refresh
      // it normally when explicitly selected through overrides.
      if (activeContextMode === "lean") return;
      await memory.refreshProfile({ userId });
    },
    async setSearchOverrides(overrides) {
      // contextMode is adapter-only — consume it here and keep it OUT of the
      // engine config, so retrieval is identical across context modes.
      const incomingCtxMode = ctxModeOf(overrides);
      if (incomingCtxMode) activeContextMode = incomingCtxMode;
      // Rebuild the facade over the SAME provider/store instances.
      const base: Record<string, unknown> = {
        embedder: memory.embedder,
        llm: memory.llm,
        vectorStore: memory.vectors,
        graphStore: memory.store,
        autoAssociate: { enabled: false }, // ingest is done; irrelevant
        onWarning: (warning: { code: string }) =>
          diagnostics.warning(warning.code),
      };
      memory = await Memory.create({
        ...base,
        ...stripCtxMode(cfg.overrides),
        ...stripCtxMode(overrides),
      });
      const activeOverrides = { ...(cfg.overrides ?? {}), ...overrides };
      activeSearchStrategy = strategyOf(activeOverrides);
      activeProfile = profileOf(activeOverrides);
    },
    async close() {
      await memory.close();
    },
    drainDiagnostics: diagnostics.drain,
  };
}

// Types whose `eventDate` is a genuine occurrence/target time worth surfacing.
// For STATIVE types (fact/preference/identity/observation) an eventDate is just
// when the fact was observed — rendering it as "[date]" misleads the answer LLM
// (trace: "[2023-06-09] Melanie has been married for 5 years" → it answered
// "Since June 9, 2023" instead of "5 years"). Events still get their date, so
// the temporal advantage is untouched.
const DATED_MEMORY_TYPES = new Set(["event", "decision", "todo", "goal"]);

/** Render a fishmem memory with its bi-temporal anchors for the answer LLM. */
function renderWithDates(m: {
  content: string;
  memoryType?: string;
  eventDate?: Date;
  validFrom?: Date;
  validTo?: Date;
}): string {
  const day = (x: Date) => x.toISOString().slice(0, 10);
  // An invalidated fact is genuinely temporal regardless of type ("was true
  // until X") — always worth showing.
  if (m.validTo) {
    const from = m.validFrom ?? m.eventDate;
    return `[was true ${from ? `from ${day(from)} ` : ""}until ${day(m.validTo)}] ${m.content}`;
  }
  if (m.eventDate && DATED_MEMORY_TYPES.has(m.memoryType ?? "")) {
    return `[${day(m.eventDate)}] ${m.content}`;
  }
  return m.content;
}

// ── mem0 (OSS, mem0ai/oss) ───────────────────────────────────────────────────

const EMBED_DIMS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
};

// Parse the harness-injected "(conversation date: <when>)" prefix to an ISO
// day string (YYYY-MM-DD), UTC to avoid TZ slippage. Same source date every
// system sees in-content.
function convDateISO(messages: BenchMessage[]): string | undefined {
  const m = messages[0]?.content.match(/\(conversation date:\s*([^)]+)\)/i);
  if (!m) return undefined;
  const raw = m[1]!.includes(" on ") ? m[1]!.split(" on ")[1]! : m[1]!;
  const d = new Date(raw.trim());
  if (Number.isNaN(d.getTime())) return undefined;
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
    .toISOString()
    .slice(0, 10);
}

// mem0 OSS's undici client does NOT retry dropped sockets: on a proxy that
// periodically closes connections (UND_ERR_SOCKET), a long run hangs forever
// (CPU 0%, no throw — the awaited promise never settles). Short runs (LOCOMO,
// 3 convs) finish before a drop; long ones (LongMemEval 500, BEAM) don't.
// Race each call against a timeout and retry on a FRESH connection, which the
// proxy honours. fishmem's own client already retries, so only mem0 needs this.
export async function withOperationTimeoutRetry<T>(
  fn: () => Promise<T>,
  label: string,
  diagnostics: ReturnType<typeof createDiagnosticsTracker>,
  timeoutMs = 300_000,
  retries = 0,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      const p = fn();
      void p.catch(() => {
        if (timedOut) diagnostics.warning("mem0_abandoned_attempt_rejected");
      });
      return await Promise.race([
        p,
        new Promise<T>((_, rej) => {
          timer = setTimeout(() => {
            timedOut = true;
            diagnostics.timeout();
            rej(new Error(`${label} timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);
    } catch (err) {
      lastErr = err;
      if (err instanceof ProviderIntegrityError) throw err;
      if (attempt < retries) {
        diagnostics.retry();
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw lastErr;
}

class ProviderIntegrityError extends Error {
  constructor(
    label: string,
    failures: number,
    details: string[],
    cause?: unknown,
  ) {
    const suffix = details.length > 0 ? `: ${details.join("; ")}` : "";
    super(`${label} had ${failures} failed provider call(s)${suffix}`, {
      cause,
    });
    this.name = "ProviderIntegrityError";
  }
}

export async function createMem0Adapter(
  cfg: AdapterConfig & { renderDates?: boolean },
): Promise<MemoryAdapter> {
  const diagnostics = createDiagnosticsTracker();
  let providerFailures = 0;
  const providerFailureDetails: string[] = [];
  // mem0ai's "memory" vector store is NOT in-RAM — it is better-sqlite3 on disk,
  // defaulting to ~/.mem0/vector_store.db (+ _entities.db), which PERSISTS and
  // ACCUMULATES across runs (same collection + userIds → prior runs' memories
  // leak in). ":memory:" forces a true in-process DB, fresh per run, matching
  // fishmem's in-RAM store — the only way conditions are actually identical.
  // Also silence mem0's PostHog telemetry: behind the proxy every event hits a
  // DNS timeout (ENOTFOUND us.i.posthog.com), spamming logs and adding latency.
  process.env.MEM0_TELEMETRY ??= "false";
  let Mem0Memory: any;
  try {
    ({ Memory: Mem0Memory } = await import("mem0ai/oss"));
  } catch (err) {
    throw new Error(
      `mem0ai is not installed (pnpm add -D mem0ai): ${(err as Error).message}`,
    );
  }
  const memory = new Mem0Memory({
    version: "v1.1",
    disableHistory: true,
    embedder: {
      provider: "openai",
      config: {
        apiKey: cfg.apiKey,
        model: cfg.embedderModel,
        ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
      },
    },
    vectorStore: {
      provider: "memory",
      config: {
        collectionName: "locomo_bench",
        dimension: EMBED_DIMS[cfg.embedderModel] ?? 1536,
        // True in-RAM (see note above) — no ~/.mem0 disk store, no cross-run
        // leakage. The entities/graph store inherits this (`:memory:` has no
        // `.db` suffix for mem0 to rewrite into `_entities.db`).
        dbPath: ":memory:",
      },
    },
    llm: {
      provider: "openai",
      config: {
        apiKey: cfg.apiKey,
        model: cfg.llmModel,
        timeout: cfg.providerTimeoutMs,
        ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
      },
    },
  });
  if (cfg.providerFetch) {
    const trackedProviderFetch: typeof fetch = async (...args) => {
      const [reasonedInput, reasonedInit] = await injectChatCompletionReasoning(
        args[0],
        args[1],
        cfg.llmModel,
        cfg.llmReasoningEffort,
      );
      const capped = await capOpenAIEmbeddingRequest(
        reasonedInput,
        reasonedInit,
      );
      if (capped.truncatedInputs > 0) {
        diagnostics.warning("mem0_embedding_input_truncated");
      }
      const input = capped.input;
      const init = capped.init;
      const request = providerRequestLabel(input, init);
      try {
        const response = await cfg.providerFetch!(input, init);
        if (!response.ok) {
          providerFailures++;
          providerFailureDetails.push(`${request}: HTTP ${response.status}`);
        }
        return response;
      } catch (error) {
        providerFailures++;
        providerFailureDetails.push(
          `${request}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
        );
        throw error;
      }
    };
    // Use the same request-level retry budget as FishMem. A recovered attempt
    // remains visible in provider usage and diagnostics, while an exhausted
    // request still rejects the enclosing add/search operation.
    bindMem0ProviderTransport(
      memory,
      trackedProviderFetch,
      cfg.providerTimeoutMs,
      cfg.providerRetries,
    );
  }
  const requireHealthyProvider = async <T>(
    label: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const failuresBefore = providerFailures;
    const detailsBefore = providerFailureDetails.length;
    try {
      const result = await operation();
      const failures = providerFailures - failuresBefore;
      if (failures > 0) {
        diagnostics.warning("mem0_provider_retry");
      }
      return result;
    } catch (error) {
      const failures = providerFailures - failuresBefore;
      if (failures > 0 && !(error instanceof ProviderIntegrityError)) {
        diagnostics.warning("mem0_provider_failure");
        throw new ProviderIntegrityError(
          label,
          failures,
          providerFailureDetails.slice(detailsBefore),
          error,
        );
      }
      throw error;
    }
  };
  return {
    name: cfg.renderDates ? "mem0-dated" : "mem0",
    async init() {},
    async add(messages, userId) {
      // Steelman (renderDates): tag each memory with its session's event date
      // in metadata, so retrieval can surface it — giving mem0's memories the
      // same date anchoring fishmem renders. Isolates the rendering advantage
      // from fishmem's structured event-date EXTRACTION (which mem0 still
      // lacks). Default mem0 path stores no date.
      const eventDate = cfg.renderDates ? convDateISO(messages) : undefined;
      const res = await withOperationTimeoutRetry<Mem0AddResponse>(
        () =>
          requireHealthyProvider(
            "mem0.add",
            () =>
              memory.add(messages, {
                userId,
                infer: true,
                ...(eventDate ? { metadata: { eventDate } } : {}),
              }) as Promise<Mem0AddResponse>,
          ),
        "mem0.add",
        diagnostics,
        cfg.operationTimeoutMs,
        cfg.operationRetries,
      );
      return res?.results?.length ?? 0;
    },
    async search(query, userId, topK) {
      const res = await withOperationTimeoutRetry<Mem0SearchResponse>(
        () =>
          requireHealthyProvider(
            "mem0.search",
            () =>
              memory.search(query, {
                topK,
                filters: { user_id: userId },
              }) as Promise<Mem0SearchResponse>,
          ),
        "mem0.search",
        diagnostics,
        cfg.operationTimeoutMs,
        cfg.operationRetries,
      );
      // Default: render exactly what mem0 produces. Its createdAt/updatedAt are
      // ingestion timestamps (not event time) — prefixing them would inject
      // misleading "timestamps" into a shared answer prompt that tells the
      // model to reason over dates, so they are deliberately NOT rendered.
      // Steelman: prefix the metadata event date we stored at ingest.
      return (res.results ?? []).map((r) => {
        const d = cfg.renderDates ? r.metadata?.eventDate : undefined;
        return { text: d ? `(${d}) ${r.memory}` : r.memory, score: r.score };
      });
    },
    drainDiagnostics: diagnostics.drain,
    async close() {},
  };
}

function providerRequestLabel(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): string {
  const method =
    init?.method ?? (input instanceof Request ? input.method : "POST");
  const raw =
    typeof input === "string" || input instanceof URL ? input : input.url;
  return `${method.toUpperCase()} ${new URL(String(raw)).pathname}`;
}

/**
 * mem0ai 3.1.2 does not expose OpenAI's `reasoning_effort` option. Rewrite
 * only its internal Chat Completions request so both benchmark adapters use
 * the same explicitly disclosed write budget. Embedding requests are left
 * byte-for-byte unchanged.
 */
async function injectChatCompletionReasoning(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
  model: string,
  reasoningEffort?: BenchmarkReasoningEffort,
): Promise<[Parameters<typeof fetch>[0], Parameters<typeof fetch>[1]]> {
  if (!reasoningEffort) return [input, init];
  const raw =
    typeof input === "string" || input instanceof URL ? input : input.url;
  if (!new URL(String(raw)).pathname.endsWith("/chat/completions")) {
    return [input, init];
  }

  const rewrite = (body: string): string => {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (parsed.model === model) parsed.reasoning_effort = reasoningEffort;
    return JSON.stringify(parsed);
  };

  if (typeof init?.body === "string") {
    const headers = new Headers(init.headers);
    headers.delete("content-length");
    return [input, { ...init, headers, body: rewrite(init.body) }];
  }
  if (input instanceof Request && init?.body === undefined) {
    const body = await input.clone().text();
    const headers = new Headers(input.headers);
    headers.delete("content-length");
    return [new Request(input, { headers, body: rewrite(body) }), init];
  }
  throw new Error(
    "mem0ai provider contract changed: chat completion body is not rewritable",
  );
}

function bindMem0ProviderTransport(
  memory: unknown,
  providerFetch: typeof fetch,
  timeoutMs?: number,
  maxRetries?: number,
): void {
  const providers = memory as {
    llm?: {
      openai?: {
        fetch?: typeof fetch;
        timeout?: number;
        maxRetries?: number;
        _options?: {
          fetch?: typeof fetch;
          timeout?: number;
          maxRetries?: number;
        };
      };
    };
    embedder?: {
      openai?: {
        fetch?: typeof fetch;
        timeout?: number;
        maxRetries?: number;
        _options?: {
          fetch?: typeof fetch;
          timeout?: number;
          maxRetries?: number;
        };
      };
    };
  };
  for (const [name, provider] of [
    ["llm", providers.llm],
    ["embedder", providers.embedder],
  ] as const) {
    const client = provider?.openai;
    if (!client || typeof client.fetch !== "function") {
      throw new Error(
        `mem0ai provider contract changed: ${name}.openai.fetch is unavailable`,
      );
    }
    client.fetch = providerFetch;
    if (timeoutMs !== undefined) client.timeout = timeoutMs;
    if (maxRetries !== undefined) client.maxRetries = maxRetries;
    if (client._options) {
      client._options.fetch = providerFetch;
      if (timeoutMs !== undefined) client._options.timeout = timeoutMs;
      if (maxRetries !== undefined) client._options.maxRetries = maxRetries;
    }
  }
}

// ── mem0 hosted platform (mem0ai MemoryClient, app.mem0.ai) ──────────────────
//
// The platform is a different product from the OSS SDK: server-side extraction,
// managed reranking, its own enrichment (it rewrites raw turns into dated,
// fleshed-out statements). We feed it the IDENTICAL conversation turns and the
// SAME answer prompt + judge — only the memory engine differs. Two platform
// quirks the harness must respect for correctness:
//   1. add() is ASYNCHRONOUS — it returns {eventId, status:"PENDING"} and the
//      memory is indexed server-side seconds later (async_mode:false is
//      ignored on this tier). Querying before processing finishes would
//      under-credit the platform. We therefore poll getAll() per user on the
//      first search and block until the memory count stabilises ("write
//      barrier") — the fair analogue of letting any system finish its writes.
//   2. getAll()/search() require `filters: { user_id }` + `version: "v2"`,
//      not a top-level user_id.
// Rendering matches the OSS adapter: pass the platform's memory text through
// verbatim (its self-authored dates are its output, not our injection).
export async function createMem0PlatformAdapter(
  cfg: AdapterConfig & { mem0ApiKey?: string },
): Promise<MemoryAdapter> {
  const diagnostics = createDiagnosticsTracker();
  const apiKey = cfg.mem0ApiKey ?? process.env.MEM0_API_KEY;
  if (!apiKey) {
    throw new Error(
      "mem0 platform key missing — set MEM0_API_KEY (get one at app.mem0.ai)",
    );
  }
  let MemoryClient: any;
  try {
    const mod: any = await import("mem0ai");
    MemoryClient = mod.default ?? mod.MemoryClient;
  } catch (err) {
    throw new Error(
      `mem0ai is not installed (pnpm add -D mem0ai): ${(err as Error).message}`,
    );
  }
  const client = new MemoryClient({ apiKey });
  const settled = new Set<string>();

  // Event-time fairness: the harness prepends "(conversation date: <when>)"
  // to each session's first turn (run.ts), so every system sees the event
  // date in-content. fishmem extracts it into eventDate; the platform instead
  // takes event time via add()'s `timestamp` param — without it, it stamps
  // wall-clock NOW (2026) onto 2023 conversations and every temporal answer
  // becomes the ingestion date. Passing the parsed conversation date is how
  // the platform is *designed* to receive event time (and how mem0's own
  // LOCOMO runs must set it). Rebuilt at UTC-noon to avoid TZ day-slippage.
  function eventTimestamp(messages: BenchMessage[]): number | undefined {
    const m = messages[0]?.content.match(/\(conversation date:\s*([^)]+)\)/i);
    if (!m) return undefined;
    const raw = m[1]!.includes(" on ") ? m[1]!.split(" on ")[1]! : m[1]!;
    const d = new Date(raw.trim());
    if (Number.isNaN(d.getTime())) return undefined;
    return Math.floor(
      Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), 12) / 1000,
    );
  }

  async function countFor(userId: string): Promise<number> {
    const all = await client.getAll({
      filters: { user_id: userId },
      version: "v2",
    });
    return typeof all?.count === "number"
      ? all.count
      : (all?.results?.length ?? 0);
  }
  // Block until the user's async memory writes finish indexing: poll until the
  // count is non-zero and unchanged across two consecutive reads (or timeout).
  async function settle(userId: string): Promise<void> {
    if (settled.has(userId)) return;
    let prev = -1;
    let stable = 0;
    for (let i = 0; i < 40; i++) {
      const n = await countFor(userId);
      if (n === prev && n > 0) {
        if (++stable >= 2) {
          settled.add(userId);
          return;
        }
      } else {
        stable = 0;
      }
      prev = n;
      await new Promise((r) => setTimeout(r, 3000));
    }
    diagnostics.timeout();
    throw new Error(`mem0 platform writes did not settle for user ${userId}`);
  }

  return {
    name: "mem0-platform",
    async init() {},
    async add(messages, userId) {
      settled.delete(userId); // new writes → must re-settle before next search
      const ts = eventTimestamp(messages);
      await client.add(messages, {
        user_id: userId,
        ...(ts ? { timestamp: ts } : {}),
      });
      return 0; // async: true count is read from getAll() after settling
    },
    async search(query, userId, topK) {
      await settle(userId);
      const res = await client.search(query, {
        filters: { user_id: userId },
        top_k: topK,
        version: "v2",
      });
      return (res?.results ?? res ?? []).map((r: any) => ({
        text: r.memory,
        score: r.score,
      }));
    },
    drainDiagnostics: diagnostics.drain,
    async close() {},
  };
}

export async function createAdapter(
  system: string,
  cfg: AdapterConfig,
): Promise<MemoryAdapter> {
  let adapter: MemoryAdapter;
  if (system === "fishmem") adapter = await createFishmemAdapter(cfg);
  else if (system === "mem0") adapter = await createMem0Adapter(cfg);
  else if (system === "mem0-dated")
    adapter = await createMem0Adapter({ ...cfg, renderDates: true });
  else if (system === "mem0-platform")
    adapter = await createMem0PlatformAdapter(cfg);
  else
    throw new Error(
      `unknown system: ${system} (expected fishmem|mem0|mem0-dated|mem0-platform)`,
    );
  return cfg.runWithUsageScope
    ? scopeAdapter(adapter, cfg.usageScope ?? system, cfg.runWithUsageScope)
    : adapter;
}

function scopeAdapter(
  adapter: MemoryAdapter,
  scope: string,
  run: NonNullable<AdapterConfig["runWithUsageScope"]>,
): MemoryAdapter {
  return {
    ...adapter,
    init: () => run(`${scope}/memory`, () => adapter.init()),
    add: (messages, userId) =>
      run(`${scope}/memory`, () => adapter.add(messages, userId)),
    search: (query, userId, topK) =>
      run(`${scope}/memory`, () => adapter.search(query, userId, topK)),
    ...(adapter.endSession
      ? {
          endSession: (userId: string) =>
            run(`${scope}/memory`, () => adapter.endSession!(userId)),
        }
      : {}),
    ...(adapter.setSearchOverrides
      ? {
          setSearchOverrides: (overrides: Record<string, unknown>) =>
            run(`${scope}/memory`, () =>
              adapter.setSearchOverrides!(overrides),
            ),
        }
      : {}),
    close: () => run(`${scope}/memory`, () => adapter.close()),
  };
}
