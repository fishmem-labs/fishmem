/**
 * LongMemEval benchmark runner for fishmem, scored under the OFFICIAL
 * LongMemEval judge protocol (see judge.ts — prompts ported verbatim from
 * xiaowu0162/LongMemEval, default judge model gpt-4o).
 *
 * Usage:
 *   OPENAI_API_KEY=... pnpm bench:longmemeval -- --variant oracle --split full
 *   pnpm bench:longmemeval -- --smoke          # offline pipeline check, no API key
 *
 * Flags:
 *   --variant oracle|s       dataset variant (default oracle; s = full haystack, 265MB)
 *   --split dev|holdout|full required disclosure for non-smoke runs
 *   --instances N            run only the first N instances (default: all 500)
 *   --per-type N             stable stratified sample of N instances per selected type
 *   --types a,b,c            filter by question_type (default: all six types)
 *   --question-ids a,b       run exact question IDs (diagnostic/reproduction)
 *   --concurrency N          instances processed in parallel (default 8)
 *   --top-k N                memories retrieved per question (default 10)
 *   --chunk-size N           conversation turns per add() call (default 4)
 *   --profile-every N        adapter.endSession() every N sessions (default 10; 0 disables)
 *   --llm MODEL              chat model for memory writes and answering (default gpt-4o-mini)
 *   --answer-model MODEL     override the answering model only (default: --llm value)
 *   --embedder MODEL         embedding model (default text-embedding-3-small)
 *   --judge MODEL            judge model (default gpt-4o, the official default)
 *   --provider-timeout-ms N  deadline for each provider attempt (default 120000)
 *   --operation-timeout-ms N deadline for a complete adapter operation (default 300000)
 *   --provider-retries N     provider retries before failing a unit (default 2)
 *   --operation-retries N    complete adapter operation retries (default 0)
 *   --system NAME            run one system: fishmem|mem0 (default fishmem)
 *   --systems a,b            run multiple systems into one comparable result suite
 *   --out PATH               results JSON path (default benchmarks/results/longmemeval-<ts>.json)
 *   --smoke                  offline mock run: 2 fabricated instances (one abstention),
 *                            asserts the pipeline end-to-end including abstention judging
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeJsonAtomic } from "../atomic-file.js";
import { openCheckpoint } from "../checkpoint.js";
import { parseIntegerOption } from "../cli.js";
import {
  type AdapterConfig,
  type BenchMessage,
  createAdapter,
  mergeAdapterDiagnostics,
} from "../locomo/adapters.js";
import { percentile } from "../locomo/metrics.js";
import { benchmarkErrorMessage, writeBenchmarkProgress } from "../progress.js";
import { systemCodeVersion } from "../result-cache.js";
import { takePerGroup } from "../sampling.js";
import { parseBenchmarkSplit, parseBenchmarkSystem } from "../system.js";
import { CONTEXT_TOKENIZER, countContextTokens } from "../tokens.js";
import {
  assertNoFailedProviderCalls,
  installOpenAIUsageMeter,
  mergeBenchmarkUsage,
  USAGE_SCHEMA_VERSION,
} from "../usage.js";
import {
  datasetPath,
  isAbstention,
  loadDataset,
  type Variant,
} from "./dataset.js";
import { judgeAnswer } from "./judge.js";
import type {
  BenchmarkRun,
  InstanceResult,
  LongMemEvalInstance,
  LongMemEvalTurn,
  RunSummary,
  TypeAccuracy,
} from "./types.js";
import { QUESTION_TYPES } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "../..");

// ── tiny .env loader (no dependency, same as the LOCOMO runner) ─────────────
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
const VARIANT = arg("variant", "oracle") as Variant;
if (VARIANT !== "oracle" && VARIANT !== "s") {
  console.error(`--variant must be oracle|s (got "${VARIANT}")`);
  process.exit(1);
}
const N_INSTANCES = arg("instances") ? Number(arg("instances")) : Infinity;
const PER_TYPE = arg("per-type") ? Number(arg("per-type")) : undefined;
if (arg("instances") && PER_TYPE !== undefined) {
  throw new Error("Use either --instances or --per-type, not both");
}
const TYPES = arg("types")
  ? new Set(
      arg("types")!
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    )
  : null;
const QUESTION_IDS = arg("question-ids")
  ? new Set(
      arg("question-ids")!
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    )
  : null;
if (
  QUESTION_IDS &&
  (TYPES || PER_TYPE !== undefined || arg("instances") !== undefined)
) {
  throw new Error(
    "--question-ids is mutually exclusive with --types, --per-type, and --instances",
  );
}
if (TYPES) {
  for (const t of TYPES) {
    if (!(QUESTION_TYPES as string[]).includes(t)) {
      console.error(
        `--types: unknown question type "${t}" (expected ${QUESTION_TYPES.join("|")})`,
      );
      process.exit(1);
    }
  }
}
const CONCURRENCY = Math.max(1, Number(arg("concurrency", "8")));
const TOP_K = Number(arg("top-k", "10"));
const CHUNK_SIZE = Math.max(1, Number(arg("chunk-size", "4")));
const PROFILE_EVERY = Number(arg("profile-every", "10"));
const LLM_MODEL = arg("llm", "gpt-4o-mini")!;
const ANSWER_MODEL = arg("answer-model", LLM_MODEL)!;
const EMBEDDER_MODEL = arg("embedder", "text-embedding-3-small")!;
const JUDGE_MODEL = arg("judge", "gpt-4o")!; // official LongMemEval default
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
  throw new Error("LongMemEval --smoke supports only fishmem");
}
const OVERRIDES = arg("overrides") ? JSON.parse(arg("overrides")!) : undefined;
const OUT = arg(
  "out",
  join(HERE, "../results", `longmemeval-${Date.now()}.json`),
)!;

const API_KEY = process.env.OPENAI_API_KEY ?? "";
const BASE_URL =
  arg("base-url", process.env.OPENAI_BASE_URL ?? "") || undefined;
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

/**
 * Smoke responder: scripts deterministic answers for the two fabricated
 * instances and a discriminating judge (so the abstention judging path is
 * genuinely exercised, not just stubbed to "yes").
 */
function smokeResponder(messages: { content: string }[]): string {
  const text = messages.map((m) => m.content).join("\n");
  const modelResponse = text.split("Model Response:")[1] ?? "";
  if (
    text.includes(
      "Does the model correctly identify the question as unanswerable?",
    )
  ) {
    return /not available|never mentioned|no information|unanswerable/i.test(
      modelResponse,
    )
      ? "yes"
      : "no";
  }
  if (text.includes("Is the model response correct? Answer yes or no only.")) {
    return /acme corp/i.test(modelResponse) ? "yes" : "no";
  }
  if (text.includes("What is the name of the user's dog?")) {
    return "That information is not available in the conversation history.";
  }
  if (text.includes("Where does the user work?")) {
    return "The user works at Acme Corp.";
  }
  return "smoke answer";
}

const answerLLM: LLM = SMOKE
  ? new MockLLM(smokeResponder)
  : new OpenAILLM({
      apiKey: API_KEY,
      model: ANSWER_MODEL,
      temperature: 0,
      ...(BASE_URL ? { baseURL: BASE_URL } : {}),
      timeoutMs: PROVIDER_TIMEOUT_MS,
      maxRetries: PROVIDER_RETRIES,
    });
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

// ── answer prompt (LOCOMO ANSWER_SYSTEM style, generalized for LongMemEval) ─
const ANSWER_SYSTEM = `You are an intelligent memory assistant tasked with answering a question using ONLY the provided memories from a user's past conversations with an AI assistant.

# CONTEXT:
You have access to memories extracted from the user's prior chat sessions. These memories contain dated information that may be relevant to the question. The date the question is asked is given as "Question date".

# INSTRUCTIONS:
1. Carefully analyze all provided memories.
2. Pay close attention to dates: memories carry conversation/event dates, and the question has its own date.
3. If the question asks about a specific event or fact, look for direct evidence in the memories.
4. If the memories contain contradictory or updated information, the information most recent relative to the question date reflects the user's current state.
5. For time references (like "last year", "two months ago", "how many days since..."), compute concrete dates or durations from the memory dates and the question date.
6. Do not confuse statements made by the AI assistant with facts about the user.
7. If the question asks for a RECOMMENDATION or SUGGESTION (e.g. "can you
   recommend...", "what would you suggest..."), do NOT abstain: give
   recommendations explicitly tailored to the user's stated tools,
   preferences, and interests found in the memories, and reference those
   anchors ("since you use X, ...."). A generic recommendation that ignores
   the user's stated context is wrong.
8. Otherwise, if the memories contain no information relevant to the
   question, explicitly say that the information is not available in the
   conversation history. Do NOT guess or fabricate an answer.
9. Keep factual answers concise; recommendation answers should be a short
   tailored list.

Respond with the answer only — no preamble.`;

function buildAnswerUser(
  context: string,
  question: string,
  questionDate: string,
): string {
  return `Memories:

${context}

Question date: ${questionDate}
Question: ${question}

Answer:`;
}

// ── per-instance pipeline ────────────────────────────────────────────────────

/** Chunk one session's turns into add() payloads of CHUNK_SIZE messages. */
function chunkSession(
  turns: LongMemEvalTurn[],
  date: string,
): BenchMessage[][] {
  const chunks: BenchMessage[][] = [];
  for (let i = 0; i < turns.length; i += CHUNK_SIZE) {
    const messages: BenchMessage[] = turns
      .slice(i, i + CHUNK_SIZE)
      .filter((t) => (t.content ?? "").trim().length > 0)
      .map((t) => ({
        role:
          t.role === "assistant" ? ("assistant" as const) : ("user" as const),
        content: t.content,
      }));
    if (messages.length === 0) continue;
    // Date context goes into the first message of each chunk so the memory
    // system can anchor temporal-reasoning questions (LOCOMO harness style).
    messages[0] = {
      ...messages[0]!,
      content: `(conversation date: ${date}) ${messages[0]!.content}`,
    };
    chunks.push(messages);
  }
  return chunks;
}

async function processInstance(
  inst: LongMemEvalInstance,
  system: (typeof SYSTEMS)[number],
): Promise<InstanceResult> {
  const usageScope = `${system}/${inst.question_id}`;
  // Per-instance isolation: fresh adapter (in-memory stores) + userId = question_id.
  const adapterCfg: AdapterConfig = {
    llmModel: LLM_MODEL,
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
    ...(OVERRIDES ? { overrides: OVERRIDES } : {}),
  };
  const adapter = await createAdapter(system, adapterCfg);
  await adapter.init();
  try {
    const userId = inst.question_id;

    // 1) Ingest the haystack, session by session (sequential within an instance).
    const t0 = Date.now();
    let chunks = 0;
    let memories = 0;
    const sessions = inst.haystack_sessions;
    for (let s = 0; s < sessions.length; s++) {
      const date = inst.haystack_dates[s] ?? inst.question_date;
      for (const chunk of chunkSession(sessions[s]!, date)) {
        try {
          memories += await adapter.add(chunk, userId);
        } catch (err) {
          throw new Error(
            `[${inst.question_id}] add failed (session ${s + 1})`,
            { cause: err },
          );
        }
        chunks++;
      }
      // Profile refresh every PROFILE_EVERY sessions and after the final one.
      const done = s + 1;
      if (
        PROFILE_EVERY > 0 &&
        adapter.endSession &&
        (done % PROFILE_EVERY === 0 || done === sessions.length)
      ) {
        try {
          await adapter.endSession(userId);
        } catch (err) {
          throw new Error(
            `[${inst.question_id}] endSession failed (session ${done})`,
            { cause: err },
          );
        }
      }
    }
    const ingestMs = Date.now() - t0;

    // 2) Retrieve + answer.
    const t1 = Date.now();
    const retrieved = await adapter.search(inst.question, userId, TOP_K);
    const searchMs = Date.now() - t1;
    const memoriesUsed = retrieved.length;
    const context = retrieved.map((m) => `- ${m.text}`).join("\n") || "(none)";

    const t2 = Date.now();
    const generated = (
      await usageMeter.run(`${usageScope}/answer`, () =>
        answerLLM.chat(
          [
            { role: "system", content: ANSWER_SYSTEM },
            {
              role: "user",
              content: buildAnswerUser(
                context,
                inst.question,
                inst.question_date,
              ),
            },
          ],
          { temperature: 0 },
        ),
      )
    ).trim();
    const answerMs = Date.now() - t2;

    // 3) Judge with the official LongMemEval protocol.
    const abstention = isAbstention(inst.question_id);
    const t3 = Date.now();
    const verdict = await usageMeter.run(`${usageScope}/judge`, () =>
      judgeAnswer(
        judgeLLM,
        inst.question_type,
        inst.question,
        String(inst.answer),
        generated,
        abstention,
      ),
    );
    const judgeMs = Date.now() - t3;

    const usage = usageMeter.summary(usageScope);
    assertNoFailedProviderCalls(usage, inst.question_id);
    return {
      questionId: inst.question_id,
      questionType: inst.question_type,
      abstention,
      question: inst.question,
      questionDate: inst.question_date,
      goldAnswer: String(inst.answer),
      generatedAnswer: generated,
      judgeLabel: verdict.label,
      judgeRaw: verdict.raw,
      ingest: {
        sessions: sessions.length,
        chunks,
        memoriesCreated: memories,
        totalMs: ingestMs,
      },
      searchMs,
      answerMs,
      judgeMs,
      contextChars: context.length,
      contextTokens: countContextTokens(context),
      memoriesUsed,
      diagnostics: adapter.drainDiagnostics(),
      usage,
    };
  } finally {
    await adapter.close();
  }
}

// ── promise pool (instances are independent; sequential per instance) ───────

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

function accuracyOf(results: InstanceResult[]): TypeAccuracy {
  const correct = results.filter((r) => r.judgeLabel === "yes").length;
  return {
    n: results.length,
    correct,
    accuracy: results.length ? correct / results.length : 0,
  };
}

function summarize(
  results: InstanceResult[],
  invocationWallClockMs: number,
  resumedUnits = 0,
  freshUnits = results.length,
): RunSummary {
  const byType: Record<string, TypeAccuracy> = {};
  for (const t of new Set(results.map((r) => r.questionType))) {
    byType[t] = accuracyOf(results.filter((r) => r.questionType === t));
  }
  const overall = accuracyOf(results);
  return {
    total: results.length,
    accuracy: overall.accuracy,
    byType,
    abstention: accuracyOf(results.filter((r) => r.abstention)),
    nonAbstention: accuracyOf(results.filter((r) => !r.abstention)),
    judgeErrors: results.filter((r) => r.judgeLabel === "ERROR").length,
    searchMsP50: percentile(
      results.map((r) => r.searchMs),
      50,
    ),
    searchMsP95: percentile(
      results.map((r) => r.searchMs),
      95,
    ),
    answerMsP50: percentile(
      results.map((r) => r.answerMs),
      50,
    ),
    answerMsP95: percentile(
      results.map((r) => r.answerMs),
      95,
    ),
    ingestTotalMs: results.reduce((a, r) => a + r.ingest.totalMs, 0),
    sessionsIngested: results.reduce((a, r) => a + r.ingest.sessions, 0),
    chunksIngested: results.reduce((a, r) => a + r.ingest.chunks, 0),
    memoriesCreated: results.reduce((a, r) => a + r.ingest.memoriesCreated, 0),
    diagnostics: mergeAdapterDiagnostics(results.map((r) => r.diagnostics)),
    successfulOperationMs: results.reduce(
      (total, result) =>
        total +
        result.ingest.totalMs +
        result.searchMs +
        result.answerMs +
        result.judgeMs,
      0,
    ),
    invocationWallClockMs,
    resumedUnits,
    freshUnits,
  };
}

type ProgressResults = Map<string, Map<string, InstanceResult>>;

function publishProgress(
  resultsBySystem: ProgressResults,
  instances: LongMemEvalInstance[],
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
      total: instances.length,
      types: TYPES ? [...TYPES] : "all",
      questionIds: QUESTION_IDS ? [...QUESTION_IDS] : null,
      perType: PER_TYPE ?? null,
      quality: results.length > 0 ? summarize(results, 0).accuracy : null,
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
      ? [...fishmem.keys()].filter((questionId) => mem0.has(questionId))
      : [];
  const fishmemQuality =
    commonIds.length > 0
      ? summarize(
          commonIds.map((id) => fishmem!.get(id)!),
          0,
        ).accuracy
      : null;
  const mem0Quality =
    commonIds.length > 0
      ? summarize(
          commonIds.map((id) => mem0!.get(id)!),
          0,
        ).accuracy
      : null;
  writeBenchmarkProgress(OUT, {
    benchmark: "longmemeval",
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
  const pct = (a: TypeAccuracy | number) =>
    typeof a === "number"
      ? `${(a * 100).toFixed(1)}%`
      : `${(a.accuracy * 100).toFixed(1)}% (${a.correct}/${a.n})`;
  const ms = (x: number) => `${x.toFixed(0)}ms`;

  console.log(`\n## LongMemEval results — ${system}\n`);
  const rows: string[][] = [
    ["questions", String(summary.total)],
    ["accuracy (official judge)", pct(summary.accuracy)],
  ];
  for (const t of QUESTION_TYPES) {
    const a = summary.byType[t];
    if (a) rows.push([`  ${t}`, pct(a)]);
  }
  rows.push(["abstention accuracy (_abs)", pct(summary.abstention)]);
  rows.push(["non-abstention accuracy", pct(summary.nonAbstention)]);
  if (summary.judgeErrors > 0)
    rows.push(["judge errors", String(summary.judgeErrors)]);
  rows.push(["search p50", ms(summary.searchMsP50)]);
  rows.push(["search p95", ms(summary.searchMsP95)]);
  rows.push(["answer p50", ms(summary.answerMsP50)]);
  rows.push([
    "ingest total (aggregate)",
    `${(summary.ingestTotalMs / 1000).toFixed(1)}s across ${summary.sessionsIngested} sessions / ${summary.chunksIngested} chunks`,
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

/** Two fabricated instances: one answerable, one abstention (_abs). */
function smokeDataset(): LongMemEvalInstance[] {
  const session: LongMemEvalTurn[] = [
    {
      role: "user",
      content: "I just started a new job at Acme Corp as an engineer.",
    },
    {
      role: "assistant",
      content: "Congratulations on the new role at Acme Corp!",
    },
    { role: "user", content: "Thanks! The office is in downtown Berlin." },
    { role: "assistant", content: "Berlin is a great city for engineers." },
    {
      role: "user",
      content: "I also signed up for a pottery class on weekends.",
    },
    {
      role: "assistant",
      content: "Pottery sounds like a relaxing weekend hobby.",
    },
  ];
  const base = {
    haystack_dates: ["2023/05/01 (Mon) 14:00"],
    haystack_sessions: [session],
    question_date: "2023/05/20 (Sat) 10:00",
  };
  return [
    {
      question_id: "smoke_1",
      question_type: "single-session-user",
      question: "Where does the user work?",
      answer: "Acme Corp",
      haystack_session_ids: ["smoke_1_s1"],
      answer_session_ids: ["smoke_1_s1"],
      ...base,
    },
    {
      question_id: "smoke_2_abs",
      question_type: "single-session-user",
      question: "What is the name of the user's dog?",
      answer: "The user never mentioned having a dog.",
      haystack_session_ids: ["smoke_2_s1"],
      answer_session_ids: [],
      ...base,
    },
  ];
}

function assertSmoke(
  run: BenchmarkRun,
  system: (typeof SYSTEMS)[number],
): void {
  const fail = (msg: string) => {
    throw new Error(`LongMemEval smoke assertion failed: ${msg}`);
  };
  const { results, summary } = run;
  if (run.system !== system) fail(`result system ${run.system} != ${system}`);
  if (run.config.system !== system) fail("config system does not match result");
  if (results.length !== 2) fail(`expected 2 results, got ${results.length}`);
  if (summary.memoriesCreated <= 0)
    fail("no memories were created during ingest");
  const normal = results.find((r) => !r.abstention);
  const abs = results.find((r) => r.abstention);
  if (!normal || !abs) fail("expected one normal and one abstention instance");
  if (normal!.judgeLabel !== "yes")
    fail(
      `normal instance judged "${normal!.judgeLabel}" (answer: ${normal!.generatedAnswer})`,
    );
  if (abs!.judgeLabel !== "yes")
    fail(
      `abstention instance judged "${abs!.judgeLabel}" (answer: ${abs!.generatedAnswer})`,
    );
  if (summary.abstention.n !== 1 || summary.abstention.accuracy !== 1)
    fail("abstention accuracy bucket not computed correctly");
  if (summary.accuracy !== 1)
    fail(`expected overall accuracy 1, got ${summary.accuracy}`);
  console.log(
    "\nSmoke test passed: ingest -> retrieve -> answer -> official judge",
  );
}

// ── main ─────────────────────────────────────────────────────────────────────

async function runSystem(
  system: (typeof SYSTEMS)[number],
  instances: LongMemEvalInstance[],
  progressResults: ProgressResults,
  progressStartedAt: string,
): Promise<{ run: BenchmarkRun; finalize: () => void }> {
  const startedAt = new Date().toISOString();
  console.log(
    `LongMemEval benchmark — system: ${system} | variant: ${SMOKE ? "smoke" : VARIANT} | instances: ${instances.length}` +
      ` | concurrency: ${CONCURRENCY} | top-k: ${TOP_K} | profile-every: ${PROFILE_EVERY}` +
      ` | llm: ${SMOKE ? "mock" : LLM_MODEL}${ANSWER_MODEL !== LLM_MODEL ? ` | answer: ${ANSWER_MODEL}` : ""} | judge: ${SMOKE ? "mock" : JUDGE_MODEL}`,
  );

  // Incremental checkpoint: each instance is independent (its own adapter +
  // ingest), so a completed one can be skipped wholesale on --resume.
  const checkpointPath = SYSTEMS.length === 1 ? OUT : `${OUT}.${system}`;
  const cp = openCheckpoint<InstanceResult>(checkpointPath, {
    resume: RESUME,
    enabled: !SMOKE,
    meta: {
      harness: "longmemeval",
      system,
      systemVersion: systemCodeVersion(system, REPO_ROOT),
      split: SPLIT,
      variant: SMOKE ? "smoke" : VARIANT,
      total: instances.length,
      types: TYPES ? [...TYPES] : "all",
      questionIds: QUESTION_IDS ? [...QUESTION_IDS] : null,
      perType: PER_TYPE ?? null,
      concurrency: CONCURRENCY,
      topK: TOP_K,
      chunkSize: CHUNK_SIZE,
      profileEvery: PROFILE_EVERY,
      llm: LLM_MODEL,
      answerModel: ANSWER_MODEL,
      embedder: EMBEDDER_MODEL,
      judge: JUDGE_MODEL,
      usageSchema: USAGE_SCHEMA_VERSION,
      providerTimeoutMs: PROVIDER_TIMEOUT_MS,
      operationTimeoutMs: OPERATION_TIMEOUT_MS,
      providerRetries: PROVIDER_RETRIES,
      operationRetries: OPERATION_RETRIES,
    },
  });
  const doneKeys = new Set(
    instances.map((i) => i.question_id).filter((k) => cp.has(k)),
  );
  const todo = instances.filter((i) => !doneKeys.has(i.question_id));
  if (doneKeys.size > 0)
    console.log(
      `  resume: ${doneKeys.size}/${instances.length} already done, ${todo.length} to run`,
    );

  const t0 = Date.now();
  const baseDone = doneKeys.size;
  // Results = those resumed from the checkpoint + the freshly computed ones.
  const resumed = instances
    .filter((i) => doneKeys.has(i.question_id))
    .map((i) => cp.get(i.question_id)!)
    .filter((r): r is InstanceResult => r !== undefined);
  const liveResults = new Map(
    resumed.map((result) => [result.questionId, result] as const),
  );
  progressResults.set(system, liveResults);
  publishProgress(progressResults, instances, progressStartedAt, "running");
  const fresh = await promisePool(
    todo,
    async (inst) => {
      const r = await processInstance(inst, system);
      cp.record(inst.question_id, r);
      liveResults.set(inst.question_id, r);
      publishProgress(progressResults, instances, progressStartedAt, "running");
      return r;
    },
    CONCURRENCY,
    (completed) =>
      process.stdout.write(
        `\r  progress: ${baseDone + completed}/${instances.length} instances | quality: ${(summarize([...liveResults.values()], 0).accuracy * 100).toFixed(1)}%   `,
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
    dataset: SMOKE ? "smoke-fixture" : datasetPath(VARIANT),
    system,
    config: {
      variant: SMOKE ? "smoke" : VARIANT,
      instances: instances.length,
      types: TYPES ? [...TYPES] : "all",
      questionIds: QUESTION_IDS ? [...QUESTION_IDS] : null,
      perType: PER_TYPE ?? null,
      concurrency: CONCURRENCY,
      topK: TOP_K,
      chunkSize: CHUNK_SIZE,
      profileEvery: PROFILE_EVERY,
      llm: SMOKE ? "mock" : LLM_MODEL,
      answerModel: SMOKE ? "mock" : ANSWER_MODEL,
      embedder: SMOKE ? "mock" : EMBEDDER_MODEL,
      judge: SMOKE ? "mock" : JUDGE_MODEL,
      judgeProtocol:
        "official LongMemEval evaluate_qa.py prompts (per-type + abstention)",
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
  const all = SMOKE ? smokeDataset() : loadDataset(VARIANT);
  let instances = QUESTION_IDS
    ? all.filter((instance) => QUESTION_IDS.has(instance.question_id))
    : all;
  if (QUESTION_IDS && instances.length !== QUESTION_IDS.size) {
    const found = new Set(instances.map((instance) => instance.question_id));
    const missing = [...QUESTION_IDS].filter((id) => !found.has(id));
    throw new Error(`unknown --question-ids: ${missing.join(", ")}`);
  }
  if (TYPES) instances = instances.filter((i) => TYPES.has(i.question_type));
  if (PER_TYPE !== undefined) {
    instances = takePerGroup(
      instances,
      PER_TYPE,
      (instance) => instance.question_type,
    );
  } else if (Number.isFinite(N_INSTANCES)) {
    instances = instances.slice(0, N_INSTANCES);
  }

  const progressResults: ProgressResults = new Map();
  publishProgress(progressResults, instances, suiteStartedAt, "running");
  publishFailure = (error) =>
    publishProgress(
      progressResults,
      instances,
      suiteStartedAt,
      "failed",
      error,
    );
  const completed = [];
  for (const system of SYSTEMS) {
    completed.push(
      await runSystem(system, instances, progressResults, suiteStartedAt),
    );
  }
  const runs = completed.map(({ run }) => run);
  const output =
    runs.length === 1
      ? runs[0]
      : {
          benchmark: "longmemeval",
          startedAt: suiteStartedAt,
          finishedAt: new Date().toISOString(),
          systems: runs,
        };

  writeJsonAtomic(OUT, output);
  for (const { finalize } of completed) finalize();
  publishProgress(progressResults, instances, suiteStartedAt, "complete");
  console.log(`\nFull results written to ${OUT}`);
}

let publishFailure: ((error: unknown) => void) | undefined;

main()
  .finally(() => usageMeter.restore())
  .catch((err) => {
    publishFailure?.(err);
    console.error(err);
    process.exit(1);
  });
