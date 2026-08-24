/**
 * BEAM benchmark runner for fishmem, scored under the OFFICIAL BEAM
 * evaluation protocol (see judge.ts — prompts and metrics ported from
 * mohammadtavakoli78/BEAM; default judge model gpt-4.1-mini).
 *
 * BEAM = "Beyond a Million Tokens: Benchmarking and Enhancing Long-Term
 * Memory in LLMs" (Tavakoli et al., arXiv:2510.27246, ICLR 2026).
 * Tiers: 100K (20 chats), 500K (35), 1M (35), 10M (10); 20 probing
 * questions per chat across ten memory-ability categories.
 *
 * Usage:
 *   OPENAI_API_KEY=... pnpm bench:beam -- --variant 1m --instances 2 --split dev
 *   pnpm bench:beam -- --smoke          # offline pipeline check, no API key
 *
 * Flags:
 *   --variant 1m|10m|100k|500k  dataset tier (default 1m — the headline BEAM-1M setup)
 *   --split dev|holdout|full     required disclosure for non-smoke runs
 *   --instances N             run only the first N conversations (default: all)
 *   --categories a,b,c        filter question categories (default: all ten)
 *   --concurrency N           conversations processed in parallel (default 2)
 *   --top-k N                 memories retrieved per question (default 10)
 *   --chunk-size N            conversation messages per add() call (default 4)
 *   --profile-every N         adapter.endSession() every N batches (default 5; 0 disables)
 *   --llm MODEL               chat model for memory writes (default gpt-4o-mini)
 *   --write-reasoning LEVEL   write/extraction reasoning effort for supported models
 *   --answer-model MODEL      override the answering model only (default: --llm value)
 *   --answer-provider NAME    openai-chat|openai-responses|codex-cli
 *   --answer-reasoning LEVEL  Responses/Codex reasoning effort
 *   --codex-path PATH         Codex CLI binary (default: codex)
 *   --codex-transport NAME    exec|app-server (default: exec)
 *   --embedder MODEL          embedding model (default text-embedding-3-small)
 *   --judge MODEL             judge model (default gpt-4.1-mini, the official default)
 *   --provider-timeout-ms N   provider attempt deadline (default 120000)
 *   --operation-timeout-ms N  complete adapter operation deadline (default 300000)
 *   --provider-retries N      provider retries before failing a unit (default 2)
 *   --operation-retries N     complete adapter operation retries (default 0)
 *   --overrides JSON          FishMem config overrides (recorded in output)
 *   --system fishmem|mem0     run one memory system (default fishmem)
 *   --systems a,b             run multiple systems into one comparable result suite
 *   --out PATH                results JSON path (default benchmarks/results/beam-<ts>.json)
 *   --smoke                   offline mock run: 2 fabricated conversations covering
 *                             4 categories (incl. event-ordering alignment + a
 *                             deliberately-failing rubric item), asserts the
 *                             pipeline end-to-end
 *
 * COST WARNING: real variants embed 100K–10M tokens per conversation; write-side
 * LLM cost only applies to systems/overrides that enable derivation or
 * extraction. See README.md before launching a full run.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeJsonAtomic } from "../atomic-file.js";
import { openCheckpoint } from "../checkpoint.js";
import { parseIntegerOption } from "../cli.js";
import {
  benchmarkProviderEndpoint,
  createBenchmarkLLM,
  parseBenchmarkAnswerProvider,
  parseBenchmarkReasoningEffort,
  parseCodexTransport,
} from "../llm-provider.js";
import {
  type AdapterConfig,
  type BenchMessage,
  createAdapter,
  mergeAdapterDiagnostics,
} from "../locomo/adapters.js";
import { percentile } from "../locomo/metrics.js";
import { benchmarkErrorMessage, writeBenchmarkProgress } from "../progress.js";
import { systemCodeVersion } from "../result-cache.js";
import { parseBenchmarkSplit, parseBenchmarkSystem } from "../system.js";
import { CONTEXT_TOKENIZER, countContextTokens } from "../tokens.js";
import {
  installOpenAIUsageMeter,
  mergeBenchmarkUsage,
  USAGE_SCHEMA_VERSION,
} from "../usage.js";
import {
  dataDir,
  goldAnswerOf,
  loadConversations,
  type Variant,
} from "./dataset.js";
import {
  evaluateEventOrdering,
  judgeRubric,
  OFFICIAL_JUDGE_MODEL,
} from "./judge.js";
import { ANSWER_GENERATION_FOR_RAG } from "./prompts.js";
import type {
  BeamConversation,
  BeamProbingQuestions,
  BeamQuestion,
  BenchmarkRun,
  CategoryScore,
  ConversationResult,
  EventOrderingScore,
  QuestionResult,
  RunSummary,
} from "./types.js";
import { BEAM_CATEGORIES } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "../..");

// ── tiny .env loader (no dependency, same as the LOCOMO/LongMemEval runners) ─
for (const envPath of [join(HERE, "../../.env")]) {
  if (!existsSync(envPath)) continue;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]!]) {
      process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
    }
  }
}

// ── arg parsing ──────────────────────────────────────────────────────────────
function arg(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0) return process.argv[idx + 1];
  return fallback;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

const SMOKE = hasFlag("smoke");
const SPLIT = parseBenchmarkSplit(arg("split"), SMOKE);
const RESUME = hasFlag("resume");
const OVERRIDES = arg("overrides") ? JSON.parse(arg("overrides")!) : undefined;
const VARIANT = (arg("variant", "1m") as string).toLowerCase() as Variant;
if (!["100k", "500k", "1m", "10m"].includes(VARIANT)) {
  console.error(`--variant must be 1m|10m|100k|500k (got "${VARIANT}")`);
  process.exit(1);
}
const N_INSTANCES = arg("instances") ? Number(arg("instances")) : Infinity;
const CATEGORIES = arg("categories")
  ? new Set(
      arg("categories")!
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    )
  : null;
if (CATEGORIES) {
  for (const c of CATEGORIES) {
    if (!(BEAM_CATEGORIES as readonly string[]).includes(c)) {
      console.error(
        `--categories: unknown category "${c}" (expected ${BEAM_CATEGORIES.join("|")})`,
      );
      process.exit(1);
    }
  }
}
const CONCURRENCY = Math.max(1, Number(arg("concurrency", "2")));
const TOP_K = Number(arg("top-k", "10"));
const CHUNK_SIZE = Math.max(1, Number(arg("chunk-size", "4")));
const PROFILE_EVERY = Number(arg("profile-every", "5"));
const LLM_MODEL = arg("llm", "gpt-4o-mini")!;
const WRITE_REASONING = parseBenchmarkReasoningEffort(arg("write-reasoning"));
const ANSWER_MODEL = arg("answer-model", LLM_MODEL)!;
const ANSWER_PROVIDER = parseBenchmarkAnswerProvider(arg("answer-provider"));
const ANSWER_REASONING = parseBenchmarkReasoningEffort(arg("answer-reasoning"));
const CODEX_PATH = arg("codex-path", process.env.CODEX_PATH ?? "codex")!;
const CODEX_TRANSPORT = parseCodexTransport(arg("codex-transport"));
const EMBEDDER_MODEL = arg("embedder", "text-embedding-3-small")!;
const JUDGE_MODEL = arg("judge", OFFICIAL_JUDGE_MODEL)!;
const PROVIDER_TIMEOUT_MS = parseIntegerOption(
  arg("provider-timeout-ms", "120000")!,
  "--provider-timeout-ms",
  1_000,
);
const OPERATION_TIMEOUT_MS = parseIntegerOption(
  arg("operation-timeout-ms", "300000")!,
  "--operation-timeout-ms",
  1_000,
);
const PROVIDER_RETRIES = parseIntegerOption(
  arg("provider-retries", "2")!,
  "--provider-retries",
  0,
);
const OPERATION_RETRIES = parseIntegerOption(
  arg("operation-retries", "0")!,
  "--operation-retries",
  0,
);
const SYSTEM_ARG = arg("system");
const SYSTEMS_ARG = arg("systems");
if (SYSTEM_ARG && SYSTEMS_ARG) {
  throw new Error("Use either --system or --systems, not both");
}
const SYSTEMS = (SYSTEMS_ARG ?? SYSTEM_ARG ?? "fishmem")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean)
  .map(parseBenchmarkSystem);
if (SYSTEMS.length === 0) throw new Error("--systems must not be empty");
if (new Set(SYSTEMS).size !== SYSTEMS.length) {
  throw new Error("--systems must not contain duplicates");
}
if (SMOKE && SYSTEMS.some((system) => system !== "fishmem")) {
  throw new Error("BEAM --smoke supports only fishmem");
}
const OUT = arg("out", join(HERE, "../results", `beam-${Date.now()}.json`))!;

const API_KEY = process.env.OPENAI_API_KEY ?? "";
const BASE_URL =
  arg("base-url", process.env.OPENAI_BASE_URL ?? "") || undefined;
const PROVIDER_ENDPOINT = benchmarkProviderEndpoint(BASE_URL);
if (!SMOKE && !API_KEY) {
  console.error(
    "OPENAI_API_KEY is required (set it in the environment or root .env). Use --smoke for an offline pipeline check.",
  );
  process.exit(1);
}
const usageMeter = installOpenAIUsageMeter();

// ── answer + judge LLMs ──────────────────────────────────────────────────────
import {
  type LLM,
  MockLLM,
  OpenAILLM,
} from "../../packages/fishmem/src/index.js";

const answerHandle = SMOKE
  ? null
  : createBenchmarkLLM({
      provider: ANSWER_PROVIDER,
      model: ANSWER_MODEL,
      apiKey: API_KEY,
      ...(BASE_URL ? { baseURL: BASE_URL } : {}),
      timeoutMs: PROVIDER_TIMEOUT_MS,
      maxRetries: PROVIDER_RETRIES,
      reasoningEffort: ANSWER_REASONING,
      usageMeter,
      codexPath: CODEX_PATH,
      codexTransport: CODEX_TRANSPORT,
    });

/** Counts judge calls that carry the official unreplaced `<question>` slot (quirk check). */
let smokeJudgeSlotSeen = 0;

/**
 * Smoke responder: deterministic answers for the fabricated conversations and
 * a genuinely discriminating judge/classifier, so rubric judging, the int()
 * flooring path, and event-ordering alignment are actually exercised.
 */
function smokeResponder(messages: { content: string }[]): string {
  const text = messages.map((m) => m.content).join("\n");

  // 1) Unified rubric judge (most specific marker first).
  if (text.includes("- RESPONSE TO EVALUATE:")) {
    if (text.includes("- QUESTION (what the user asked): <question>"))
      smokeJudgeSlotSeen++;
    const m = text.match(
      /- RUBRIC CRITERION \(what to check\): (.*)\n- RESPONSE TO EVALUATE: ([\s\S]*?)\n\n## EVALUATION RUBRIC:/,
    );
    const item = m?.[1] ?? "";
    const response = (m?.[2] ?? "").toLowerCase();
    let key = item;
    const stated = item.match(/should (?:state|contain|mention): (.*)$/);
    if (stated) key = stated[1]!;
    else if (/no information related to/i.test(item)) key = "no information";
    const score = response.includes(key.toLowerCase()) ? 1.0 : 0.0;
    return JSON.stringify({
      score,
      reason: `smoke judge: key "${key}" ${score ? "found" : "missing"}`,
    });
  }

  // 2) Event-ordering alignment classifier.
  if (text.includes("You are a binary classifier")) {
    const m = text.match(
      /First snippet: ([\s\S]*?) \n\s*Second snippet: ([\s\S]*?)\n\s*$/,
    );
    const norm = (s: string) =>
      s
        .toLowerCase()
        .replace(/^[\s\d.\-)]+/, "")
        .trim();
    const a = norm(m?.[1] ?? "");
    const b = norm(m?.[2] ?? "");
    return a && b && (a === b || a.includes(b) || b.includes(a)) ? "YES" : "NO";
  }

  // 3) Official RAG answer prompt.
  if (text.includes("MUST answer questions using ONLY")) {
    if (text.includes("Where does the user work?"))
      return "The user works at Acme Corp.";
    if (text.includes("user's dog")) {
      return "Based on the provided chat, there is no information related to the user's dog.";
    }
    if (text.includes("project phases")) {
      return "Planning phase\nImplementation phase\nLaunch phase";
    }
    if (text.includes("latency target")) {
      return "The user's current API latency target is 250ms.";
    }
    return "smoke answer";
  }

  return "smoke fallback";
}

const answerLLM: LLM = SMOKE ? new MockLLM(smokeResponder) : answerHandle!.llm;
const judgeLLM: LLM = SMOKE
  ? answerLLM
  : new OpenAILLM({
      apiKey: API_KEY,
      model: JUDGE_MODEL,
      temperature: 0,
      ...(BASE_URL ? { baseURL: BASE_URL } : {}),
      timeoutMs: PROVIDER_TIMEOUT_MS,
      maxRetries: PROVIDER_RETRIES,
    });

// ── per-conversation pipeline ────────────────────────────────────────────────

/**
 * Chunk one batch's messages into add() payloads of CHUNK_SIZE messages.
 * The batch time anchor is prepended to the first message of each chunk so
 * the memory system can ground temporal-reasoning questions (the chat text
 * itself also references its time anchors).
 */
function chunkBatch(
  conv: BeamConversation,
  batchIdx: number,
): BenchMessage[][] {
  const batch = conv.batches[batchIdx]!;
  const flat: BenchMessage[] = [];
  for (const turn of batch.turns) {
    for (const msg of turn) {
      if ((msg.content ?? "").trim().length === 0) continue;
      flat.push({
        role: msg.role === "assistant" ? "assistant" : "user",
        content: msg.content,
      });
    }
  }
  const chunks: BenchMessage[][] = [];
  for (let i = 0; i < flat.length; i += CHUNK_SIZE) {
    const messages = flat.slice(i, i + CHUNK_SIZE);
    if (messages.length === 0) continue;
    if (batch.time_anchor) {
      messages[0] = {
        ...messages[0]!,
        content: `(time anchor: ${batch.time_anchor}) ${messages[0]!.content}`,
      };
    }
    chunks.push(messages);
  }
  return chunks;
}

function buildAnswerPrompt(context: string, question: string): string {
  // Official answer_generation_for_rag substitution (src/prompts.py).
  return ANSWER_GENERATION_FOR_RAG.replace("<context>", context).replace(
    "<question>",
    question,
  );
}

async function processConversation(
  conv: BeamConversation,
  system: (typeof SYSTEMS)[number],
): Promise<ConversationResult> {
  const usageScope = `${system}/${conv.id}`;
  // Per-conversation isolation: fresh adapter (in-memory stores) + dedicated userId.
  const adapterCfg: AdapterConfig = {
    llmModel: LLM_MODEL,
    ...(WRITE_REASONING ? { llmReasoningEffort: WRITE_REASONING } : {}),
    embedderModel: EMBEDDER_MODEL,
    apiKey: API_KEY,
    baseURL: BASE_URL,
    mock: SMOKE,
    usageScope,
    runWithUsageScope: usageMeter.run,
    providerFetch: globalThis.fetch,
    providerTimeoutMs: PROVIDER_TIMEOUT_MS,
    operationTimeoutMs: OPERATION_TIMEOUT_MS,
    providerRetries: PROVIDER_RETRIES,
    operationRetries: OPERATION_RETRIES,
    overrides: OVERRIDES,
  };
  const adapter = await createAdapter(system, adapterCfg);
  await adapter.init();
  try {
    const userId = `beam_${conv.tier}_${conv.id}`;

    // 1) Ingest the chat, batch by batch (sequential within a conversation).
    const t0 = Date.now();
    let chunks = 0;
    let memories = 0;
    for (let b = 0; b < conv.batches.length; b++) {
      for (const chunk of chunkBatch(conv, b)) {
        try {
          memories += await adapter.add(chunk, userId);
        } catch (err) {
          throw new Error(
            `[${conv.tier}/${conv.id}] add failed (batch ${b + 1})`,
            { cause: err },
          );
        }
        chunks++;
      }
      const done = b + 1;
      if (
        PROFILE_EVERY > 0 &&
        adapter.endSession &&
        (done % PROFILE_EVERY === 0 || done === conv.batches.length)
      ) {
        try {
          await adapter.endSession(userId);
        } catch (err) {
          throw new Error(
            `[${conv.tier}/${conv.id}] endSession failed (batch ${done})`,
            { cause: err },
          );
        }
      }
    }
    const ingestMs = Date.now() - t0;

    // 2) Answer + judge every probing question (official per-category order).
    const questionResults: QuestionResult[] = [];
    for (const category of BEAM_CATEGORIES) {
      if (CATEGORIES && !CATEGORIES.has(category)) continue;
      const qs = conv.questions[category] ?? [];
      for (let qi = 0; qi < qs.length; qi++) {
        const q = qs[qi]!;

        const t1 = Date.now();
        const retrieved = await adapter.search(q.question, userId, TOP_K);
        const searchMs = Date.now() - t1;
        const memoriesUsed = retrieved.length;
        const context = retrieved.map((m) => m.text).join("\n") || "(none)";

        const t2 = Date.now();
        const generated = (
          await usageMeter.run(`${usageScope}/answer`, () =>
            answerLLM.chat(
              [
                {
                  role: "user",
                  content: buildAnswerPrompt(context, q.question),
                },
              ],
              { temperature: 0 },
            ),
          )
        ).trim();
        const answerMs = Date.now() - t2;

        const t3 = Date.now();
        let ordering: EventOrderingScore | undefined;
        let judged: Awaited<ReturnType<typeof judgeRubric>>;
        if (category === "event_ordering") {
          const r = await usageMeter.run(`${usageScope}/judge`, () =>
            evaluateEventOrdering(judgeLLM, q.rubric, generated),
          );
          ordering = r.ordering;
          judged = r;
        } else {
          judged = await usageMeter.run(`${usageScope}/judge`, () =>
            judgeRubric(judgeLLM, category, q.rubric, generated),
          );
        }
        const judgeMs = Date.now() - t3;

        questionResults.push({
          conversationId: conv.id,
          category,
          questionIndex: qi,
          question: q.question,
          rubric: q.rubric,
          goldAnswer: goldAnswerOf(q),
          generatedAnswer: generated,
          llmJudgeScore: judged.llmJudgeScore,
          rubricVerdicts: judged.verdicts,
          ...(ordering ? { ordering } : {}),
          judgeErrors: judged.judgeErrors,
          searchMs,
          answerMs,
          judgeMs,
          contextChars: context.length,
          contextTokens: countContextTokens(context),
          memoriesUsed,
        });
      }
    }

    const usage = usageMeter.summary(usageScope);
    return {
      conversationId: conv.id,
      questions: questionResults,
      ingest: {
        batches: conv.batches.length,
        chunks,
        memoriesCreated: memories,
        totalMs: ingestMs,
      },
      diagnostics: adapter.drainDiagnostics(),
      usage,
    };
  } finally {
    await adapter.close();
  }
}

// ── promise pool (conversations are independent; sequential inside) ─────────

async function promisePool<T, R>(
  items: T[],
  worker: (item: T) => Promise<R>,
  concurrency: number,
  onProgress: (completed: number, total: number) => void,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let completed = 0;
  const runner = async () => {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx]!);
      completed++;
      onProgress(completed, items.length);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, runner),
  );
  return results;
}

// ── summary + report ─────────────────────────────────────────────────────────

/** Official reporting score of one question (report_results.py semantics). */
function reportingScore(q: QuestionResult): number {
  return q.category === "event_ordering" && q.ordering
    ? q.ordering.tau_norm
    : q.llmJudgeScore;
}

function summarize(
  convResults: ConversationResult[],
  invocationWallClockMs: number,
  resumedUnits = 0,
  freshUnits = convResults.length,
): RunSummary {
  const all = convResults.flatMap((c) => c.questions);
  const byCategory: Record<string, CategoryScore> = {};
  for (const cat of BEAM_CATEGORIES) {
    const qs = all.filter((q) => q.category === cat);
    if (qs.length === 0) continue;
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const entry: CategoryScore = {
      n: qs.length,
      score: mean(qs.map(reportingScore)),
      meanLlmJudgeScore: mean(qs.map((q) => q.llmJudgeScore)),
    };
    if (cat === "event_ordering") {
      entry.meanFinalScore = mean(qs.map((q) => q.ordering?.final_score ?? 0));
    }
    byCategory[cat] = entry;
  }
  const catScores = Object.values(byCategory).map((c) => c.score);
  return {
    conversations: convResults.length,
    totalQuestions: all.length,
    overallMacro: catScores.length
      ? catScores.reduce((a, b) => a + b, 0) / catScores.length
      : 0,
    overallMicro: all.length
      ? all.map(reportingScore).reduce((a, b) => a + b, 0) / all.length
      : 0,
    byCategory,
    judgeErrors: all.reduce((a, q) => a + q.judgeErrors, 0),
    searchMsP50: percentile(
      all.map((q) => q.searchMs),
      50,
    ),
    searchMsP95: percentile(
      all.map((q) => q.searchMs),
      95,
    ),
    answerMsP50: percentile(
      all.map((q) => q.answerMs),
      50,
    ),
    answerMsP95: percentile(
      all.map((q) => q.answerMs),
      95,
    ),
    ingestTotalMs: convResults.reduce((a, c) => a + c.ingest.totalMs, 0),
    batchesIngested: convResults.reduce((a, c) => a + c.ingest.batches, 0),
    chunksIngested: convResults.reduce((a, c) => a + c.ingest.chunks, 0),
    memoriesCreated: convResults.reduce(
      (a, c) => a + c.ingest.memoriesCreated,
      0,
    ),
    diagnostics: mergeAdapterDiagnostics(
      convResults.map((result) => result.diagnostics),
    ),
    successfulOperationMs: convResults.reduce(
      (total, result) =>
        total +
        result.ingest.totalMs +
        result.questions.reduce(
          (questionTotal, question) =>
            questionTotal +
            question.searchMs +
            question.answerMs +
            question.judgeMs,
          0,
        ),
      0,
    ),
    invocationWallClockMs,
    resumedUnits,
    freshUnits,
  };
}

type ProgressResults = Map<string, Map<string, ConversationResult>>;

function publishProgress(
  resultsBySystem: ProgressResults,
  conversations: BeamConversation[],
  startedAt: string,
  status: "running" | "complete" | "failed",
  error?: unknown,
): void {
  const systems = SYSTEMS.map((system) => {
    const results = [...(resultsBySystem.get(system)?.values() ?? [])];
    const usage = mergeBenchmarkUsage(results.map((result) => result.usage));
    return {
      system,
      completed: results.length,
      total: conversations.length,
      quality: results.length > 0 ? summarize(results, 0).overallMacro : null,
      ingestMs: results.reduce(
        (total, result) => total + result.ingest.totalMs,
        0,
      ),
      llmCalls: usage.llmCalls,
      embeddingCalls: usage.embeddingCalls,
      estimatedUsd: usage.estimatedUsd ?? 0,
      failedCalls: usage.failedCalls,
      checkpoint: `${SYSTEMS.length === 1 ? OUT : `${OUT}.${system}`}.partial.jsonl`,
    };
  });
  const fishmem = resultsBySystem.get("fishmem");
  const mem0 = resultsBySystem.get("mem0");
  const commonIds =
    fishmem && mem0
      ? [...fishmem.keys()].filter((conversationId) => mem0.has(conversationId))
      : [];
  const fishmemQuality =
    commonIds.length > 0
      ? summarize(
          commonIds.map((id) => fishmem!.get(id)!),
          0,
        ).overallMacro
      : null;
  const mem0Quality =
    commonIds.length > 0
      ? summarize(
          commonIds.map((id) => mem0!.get(id)!),
          0,
        ).overallMacro
      : null;
  writeBenchmarkProgress(OUT, {
    benchmark: "beam",
    status,
    startedAt,
    updatedAt: new Date().toISOString(),
    output: OUT,
    ...(error === undefined ? {} : { error: benchmarkErrorMessage(error) }),
    systems,
    paired: {
      commonUnits: commonIds.length,
      fishmemQuality,
      mem0Quality,
      difference:
        fishmemQuality === null || mem0Quality === null
          ? null
          : fishmemQuality - mem0Quality,
    },
  });
}

function printReport(
  summary: RunSummary,
  system: (typeof SYSTEMS)[number],
): void {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const ms = (x: number) => `${x.toFixed(0)}ms`;

  console.log(`\n## BEAM results — ${system}\n`);
  const rows: string[][] = [
    ["conversations", String(summary.conversations)],
    ["questions", String(summary.totalQuestions)],
    ["overall (macro avg of categories)", pct(summary.overallMacro)],
    ["overall (micro avg of questions)", pct(summary.overallMicro)],
  ];
  for (const cat of BEAM_CATEGORIES) {
    const c = summary.byCategory[cat];
    if (!c) continue;
    const extra =
      cat === "event_ordering"
        ? ` (tau_norm; judge ${pct(c.meanLlmJudgeScore)}, final ${pct(c.meanFinalScore ?? 0)})`
        : "";
    rows.push([`  ${cat}`, `${pct(c.score)} (n=${c.n})${extra}`]);
  }
  if (summary.judgeErrors > 0)
    rows.push(["judge errors", String(summary.judgeErrors)]);
  rows.push([
    "search p50 / p95",
    `${ms(summary.searchMsP50)} / ${ms(summary.searchMsP95)}`,
  ]);
  rows.push([
    "answer p50 / p95",
    `${ms(summary.answerMsP50)} / ${ms(summary.answerMsP95)}`,
  ]);
  rows.push([
    "ingest total (aggregate)",
    `${(summary.ingestTotalMs / 1000).toFixed(1)}s across ${summary.batchesIngested} batches / ${summary.chunksIngested} chunks`,
  ]);
  rows.push(["memories created", String(summary.memoriesCreated)]);
  rows.push([
    "successful operation time (sum)",
    `${(summary.successfulOperationMs / 1000).toFixed(1)}s`,
  ]);
  rows.push([
    "current invocation wall clock",
    `${(summary.invocationWallClockMs / 1000).toFixed(1)}s (${summary.resumedUnits} resumed / ${summary.freshUnits} fresh)`,
  ]);

  const widths = [0, 1].map((i) =>
    Math.max("metric".length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const fmt = (row: string[]) =>
    `| ${row.map((c, i) => (c ?? "").padEnd(widths[i]!)).join(" | ")} |`;
  console.log(fmt(["metric", "value"]));
  console.log(`|${widths.map((w) => "-".repeat(w + 2)).join("|")}|`);
  for (const row of rows) console.log(fmt(row));
}

// ── smoke fixtures + assertions ──────────────────────────────────────────────

/**
 * Two fabricated conversations covering four categories:
 *  - information_extraction + abstention (conversation 1)
 *  - event_ordering (alignment + Kendall tau path) + knowledge_update with a
 *    deliberately unsatisfied second rubric item (conversation 2)
 */
function smokeDataset(): BeamConversation[] {
  const emptyCats = Object.fromEntries(
    BEAM_CATEGORIES.map((c) => [c, [] as BeamQuestion[]]),
  ) as BeamProbingQuestions;
  const msg = (id: number, role: "user" | "assistant", content: string) => ({
    id,
    role,
    content,
  });
  return [
    {
      id: "1",
      tier: "SMOKE",
      batches: [
        {
          batch_number: 1,
          time_anchor: "March-15-2024",
          turns: [
            [
              msg(
                0,
                "user",
                "I just started a new job at Acme Corp as an engineer.",
              ),
              msg(
                1,
                "assistant",
                "Congratulations on the new role at Acme Corp!",
              ),
            ],
            [
              msg(2, "user", "Thanks! The office is in downtown Berlin."),
              msg(3, "assistant", "Berlin is a great city for engineers."),
            ],
          ],
        },
      ],
      questions: {
        ...emptyCats,
        information_extraction: [
          {
            question: "Where does the user work?",
            rubric: ["LLM response should state: Acme Corp"],
            answer: "Acme Corp",
          },
        ],
        abstention: [
          {
            question: "What is the name of the user's dog?",
            rubric: [
              "Based on the provided chat, there is no information related to the user's dog",
            ],
            ideal_response:
              "Based on the provided chat, there is no information related to the user's dog.",
          },
        ],
      },
    },
    {
      id: "2",
      tier: "SMOKE",
      batches: [
        {
          batch_number: 1,
          time_anchor: "April-01-2024",
          turns: [
            [
              msg(
                0,
                "user",
                "We finished the planning phase of the project in January.",
              ),
              msg(1, "assistant", "Great, planning is the foundation."),
            ],
            [
              msg(
                2,
                "user",
                "The implementation phase wrapped up in February, and the launch phase happened in March.",
              ),
              msg(3, "assistant", "Congratulations on the launch!"),
            ],
            [
              msg(
                4,
                "user",
                "We originally targeted 400ms API latency, but the current latency target is now 250ms.",
              ),
              msg(5, "assistant", "250ms is a solid target."),
            ],
          ],
        },
      ],
      questions: {
        ...emptyCats,
        event_ordering: [
          {
            question: "List the project phases in the order they occurred.",
            rubric: ["Planning phase", "Implementation phase", "Launch phase"],
            answer: "Planning phase, Implementation phase, Launch phase",
          },
        ],
        knowledge_update: [
          {
            question: "What is the user's current API latency target?",
            rubric: [
              "LLM response should state: 250ms",
              "LLM response should state: 99.9% uptime", // deliberately unsatisfied
            ],
            answer: "250ms",
          },
        ],
      },
    },
  ];
}

function assertSmoke(
  run: BenchmarkRun,
  system: (typeof SYSTEMS)[number],
): void {
  const fail = (msg: string) => {
    throw new Error(`BEAM smoke assertion failed: ${msg}`);
  };
  const { results, summary } = run;
  if (run.system !== system) fail(`result system ${run.system} != ${system}`);
  if (run.config.system !== system) fail("config system does not match result");
  const approx = (a: number, b: number) => Math.abs(a - b) < 1e-9;

  if (results.length !== 2)
    fail(`expected 2 conversations, got ${results.length}`);
  if (summary.totalQuestions !== 4)
    fail(`expected 4 questions, got ${summary.totalQuestions}`);
  if (summary.memoriesCreated <= 0)
    fail("no memories were created during ingest");
  if (summary.judgeErrors !== 0) fail(`judge errors: ${summary.judgeErrors}`);

  const cat = (name: string) => {
    const c = summary.byCategory[name];
    if (!c) fail(`missing category ${name} in summary`);
    return c!;
  };
  if (!approx(cat("information_extraction").score, 1))
    fail(
      `information_extraction expected 1, got ${cat("information_extraction").score}`,
    );
  if (!approx(cat("abstention").score, 1))
    fail(`abstention expected 1, got ${cat("abstention").score}`);
  // knowledge_update: rubric item 1 satisfied (1), item 2 deliberately not (0) → 0.5
  if (!approx(cat("knowledge_update").score, 0.5))
    fail(
      `knowledge_update expected 0.5 (judge must discriminate), got ${cat("knowledge_update").score}`,
    );

  const eo = results
    .flatMap((c) => c.questions)
    .find((q) => q.category === "event_ordering");
  if (!eo?.ordering) fail("event_ordering question missing ordering metrics");
  if (!approx(eo!.ordering!.tau_norm, 1) || !approx(eo!.ordering!.f1, 1))
    fail(
      `event_ordering expected tau_norm=1, f1=1; got tau_norm=${eo!.ordering!.tau_norm}, f1=${eo!.ordering!.f1}`,
    );
  if (!approx(cat("event_ordering").score, 1))
    fail(
      `event_ordering category score expected 1 (tau_norm), got ${cat("event_ordering").score}`,
    );

  // overallMacro = mean(1, 1, 1, 0.5) over the four exercised categories
  if (!approx(summary.overallMacro, 0.875))
    fail(`overallMacro expected 0.875, got ${summary.overallMacro}`);

  // Quirk #1: every rubric judge call must carry the unreplaced <question> slot.
  const totalRubricItems = results
    .flatMap((c) => c.questions)
    .reduce((a, q) => a + q.rubric.length, 0);
  if (smokeJudgeSlotSeen !== totalRubricItems)
    fail(
      `expected ${totalRubricItems} judge calls with the literal "<question>" slot, saw ${smokeJudgeSlotSeen}`,
    );

  console.log(
    "\nSmoke test passed: ingest -> retrieve -> answer -> official rubric judge",
  );
}

// ── main ─────────────────────────────────────────────────────────────────────

async function runSystem(
  system: (typeof SYSTEMS)[number],
  conversations: BeamConversation[],
  progressResults: ProgressResults,
  progressStartedAt: string,
): Promise<{ run: BenchmarkRun; finalize: () => void }> {
  const startedAt = new Date().toISOString();
  console.log(
    `BEAM benchmark — system: ${system} | variant: ${SMOKE ? "smoke" : VARIANT} | conversations: ${conversations.length}` +
      ` | concurrency: ${CONCURRENCY} | top-k: ${TOP_K} | chunk-size: ${CHUNK_SIZE} | profile-every: ${PROFILE_EVERY}` +
      ` | llm: ${SMOKE ? "mock" : `${LLM_MODEL}${WRITE_REASONING ? `/${WRITE_REASONING}` : ""}`}` +
      ` | answer: ${SMOKE ? "mock" : `${ANSWER_PROVIDER}:${ANSWER_MODEL}`} | judge: ${SMOKE ? "mock" : JUDGE_MODEL}`,
  );
  if (!SMOKE && (VARIANT === "10m" || VARIANT === "1m")) {
    console.log(
      `NOTE: ${VARIANT} conversations are ${VARIANT === "10m" ? "~10M" : "~1M"} tokens each — ingestion is the dominant cost. See benchmarks/beam/README.md before a full run.`,
    );
  }

  // Incremental checkpoint: each conversation is independent (own adapter +
  // ingest), so a finished one is skipped wholesale on --resume — critical for
  // the long tiers where a mid-run socket drop would otherwise lose hours.
  const checkpointPath = SYSTEMS.length === 1 ? OUT : `${OUT}.${system}`;
  const cp = openCheckpoint<ConversationResult>(checkpointPath, {
    resume: RESUME,
    enabled: !SMOKE,
    meta: {
      harness: "beam",
      system,
      systemVersion: systemCodeVersion(system, REPO_ROOT),
      split: SPLIT,
      variant: SMOKE ? "smoke" : VARIANT,
      total: conversations.length,
      categories: CATEGORIES ? [...CATEGORIES] : "all",
      concurrency: CONCURRENCY,
      topK: TOP_K,
      chunkSize: CHUNK_SIZE,
      profileEvery: PROFILE_EVERY,
      llm: LLM_MODEL,
      writeReasoning: WRITE_REASONING ?? null,
      answerModel: ANSWER_MODEL,
      answerProvider: ANSWER_PROVIDER,
      answerReasoning: ANSWER_REASONING ?? null,
      answerManifest: answerHandle?.manifest ?? null,
      embedder: EMBEDDER_MODEL,
      judge: JUDGE_MODEL,
      usageSchema: USAGE_SCHEMA_VERSION,
      providerTimeoutMs: PROVIDER_TIMEOUT_MS,
      operationTimeoutMs: OPERATION_TIMEOUT_MS,
      providerRetries: PROVIDER_RETRIES,
      operationRetries: OPERATION_RETRIES,
      providerEndpoint: PROVIDER_ENDPOINT,
      overrides: OVERRIDES ?? null,
    },
  });
  const doneIds = new Set(
    conversations.map((c) => String(c.id)).filter((id) => cp.has(id)),
  );
  const todo = conversations.filter((c) => !doneIds.has(String(c.id)));
  if (doneIds.size > 0)
    console.log(
      `  resume: ${doneIds.size}/${conversations.length} conversations done, ${todo.length} to run`,
    );

  const t0 = Date.now();
  const baseDone = doneIds.size;
  const resumed = conversations
    .filter((c) => doneIds.has(String(c.id)))
    .map((c) => cp.get(String(c.id))!)
    .filter((r): r is ConversationResult => r !== undefined);
  const liveResults = new Map(
    resumed.map((result) => [result.conversationId, result] as const),
  );
  progressResults.set(system, liveResults);
  publishProgress(progressResults, conversations, progressStartedAt, "running");
  const fresh = await promisePool(
    todo,
    async (conv) => {
      const r = await processConversation(conv, system);
      cp.record(String(conv.id), r);
      liveResults.set(String(conv.id), r);
      publishProgress(
        progressResults,
        conversations,
        progressStartedAt,
        "running",
      );
      return r;
    },
    CONCURRENCY,
    (completed) =>
      process.stdout.write(
        `\r  progress: ${baseDone + completed}/${conversations.length} conversations | quality: ${(summarize([...liveResults.values()], 0).overallMacro * 100).toFixed(1)}%   `,
      ),
  );
  process.stdout.write("\n");
  const wallClockMs = Date.now() - t0;
  const results = [...resumed, ...fresh];

  const summary = summarize(results, wallClockMs, resumed.length, fresh.length);
  const usage = mergeBenchmarkUsage(results.map((result) => result.usage));
  usage.unscopedCalls = usageMeter.unscopedCalls();
  const run: BenchmarkRun = {
    startedAt,
    finishedAt: new Date().toISOString(),
    dataset: SMOKE ? "smoke-fixture" : dataDir(VARIANT),
    system,
    config: {
      variant: SMOKE ? "smoke" : VARIANT,
      conversations: conversations.length,
      categories: CATEGORIES ? [...CATEGORIES] : "all",
      concurrency: CONCURRENCY,
      topK: TOP_K,
      chunkSize: CHUNK_SIZE,
      profileEvery: PROFILE_EVERY,
      llm: SMOKE ? "mock" : LLM_MODEL,
      writeReasoning: SMOKE ? null : (WRITE_REASONING ?? null),
      answerModel: SMOKE ? "mock" : ANSWER_MODEL,
      answerProvider: SMOKE ? "mock" : ANSWER_PROVIDER,
      answerReasoning: SMOKE ? null : (ANSWER_REASONING ?? null),
      answerManifest: SMOKE ? null : answerHandle!.manifest,
      embedder: SMOKE ? "mock" : EMBEDDER_MODEL,
      judge: SMOKE ? "mock" : JUDGE_MODEL,
      judgeProtocol:
        "official BEAM compute_metrics.py (unified rubric judge + event-ordering tau-b; category score = mean llm_judge_score, event_ordering = mean tau_norm)",
      answerPrompt: "official answer_generation_for_rag (src/prompts.py)",
      smoke: SMOKE,
      split: SPLIT,
      system,
      systemVersion: systemCodeVersion(system, REPO_ROOT),
      contextTokenizer: CONTEXT_TOKENIZER,
      usageSchema: USAGE_SCHEMA_VERSION,
      providerTimeoutMs: PROVIDER_TIMEOUT_MS,
      operationTimeoutMs: OPERATION_TIMEOUT_MS,
      providerRetries: PROVIDER_RETRIES,
      operationRetries: OPERATION_RETRIES,
      providerEndpoint: PROVIDER_ENDPOINT,
      overrides: OVERRIDES ?? null,
    },
    results,
    summary,
    usage,
  };

  printReport(summary, system);
  if (SMOKE) assertSmoke(run, system);
  return { run, finalize: cp.finalize };
}

async function main() {
  const suiteStartedAt = new Date().toISOString();
  const all = SMOKE ? smokeDataset() : loadConversations(VARIANT);
  let conversations = all;
  if (Number.isFinite(N_INSTANCES)) {
    conversations = conversations.slice(0, N_INSTANCES);
  }

  const progressResults: ProgressResults = new Map();
  publishProgress(progressResults, conversations, suiteStartedAt, "running");
  publishFailure = (error) =>
    publishProgress(
      progressResults,
      conversations,
      suiteStartedAt,
      "failed",
      error,
    );
  const completed = [];
  for (const system of SYSTEMS) {
    completed.push(
      await runSystem(system, conversations, progressResults, suiteStartedAt),
    );
  }
  const runs = completed.map(({ run }) => run);
  const output =
    runs.length === 1
      ? runs[0]
      : {
          benchmark: "beam",
          startedAt: suiteStartedAt,
          finishedAt: new Date().toISOString(),
          systems: runs,
        };

  writeJsonAtomic(OUT, output);
  for (const { finalize } of completed) finalize();
  publishProgress(progressResults, conversations, suiteStartedAt, "complete");
  console.log(`\nFull results written to ${OUT}`);
}

let publishFailure: ((error: unknown) => void) | undefined;

main()
  .finally(async () => {
    await answerHandle?.close();
    usageMeter.restore();
  })
  .catch((err) => {
    publishFailure?.(err);
    console.error(err);
    process.exit(1);
  });
