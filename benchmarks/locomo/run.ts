/**
 * LOCOMO benchmark runner: fishmem vs mem0 (OSS), mirroring the methodology of
 * mem0's evaluation suite (LLM-as-a-Judge accuracy by question category,
 * token F1, BLEU-1, latency percentiles).
 *
 * Usage:
 *   OPENAI_API_KEY=... pnpm bench:locomo -- --systems fishmem,mem0 --conversations 1 --split dev
 *   pnpm bench:locomo -- --smoke           # offline pipeline check, no API key
 *
 * Flags:
 *   --systems fishmem,mem0     systems to run (default: fishmem,mem0)
 *   --split dev|holdout|full   required disclosure for non-smoke runs
 *   --conversations N        number of LOCOMO conversations (default 1, max 10)
 *   --max-questions N        cap questions per conversation (default: all)
 *   --categories 1,2,3,4     question categories to keep (default: 1,2,3,4 —
 *                            category 5 "adversarial" excluded, as in mem0's paper)
 *   --top-k N                memories retrieved per question (default 10)
 *   --chunk-size N           conversation turns per add() call (default 4)
 *   --max-sessions N         cap ingested sessions per conversation (default: all)
 *   --llm MODEL              chat model for memory writes/answering (default gpt-4o-mini)
 *   --embedder MODEL         embedding model (default text-embedding-3-small)
 *   --judge MODEL            judge model (default gpt-4o-mini)
 *   --provider-timeout-ms N provider attempt deadline (default 120000)
 *   --operation-timeout-ms N complete adapter operation deadline (default 300000)
 *   --provider-retries N    provider retries before failing a unit (default 2)
 *   --operation-retries N   complete adapter operation retries (default 0)
 *   --question-retries N    whole search/answer/judge retries (default 0)
 *   --out PATH               results JSON path (default benchmarks/results/locomo-<ts>.json)
 *   --smoke                  offline mock run (fishmem only): verifies the pipeline
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeJsonAtomic } from "../atomic-file.js";
import { openCheckpoint } from "../checkpoint.js";
import { parseIntegerOption } from "../cli.js";
import { benchmarkErrorMessage, writeBenchmarkProgress } from "../progress.js";
import {
  fingerprint,
  openResultCache,
  systemCodeVersion,
} from "../result-cache.js";
import { parseBenchmarkSplit } from "../system.js";
import { CONTEXT_TOKENIZER, countContextTokens } from "../tokens.js";
import type { BenchmarkUsage } from "../usage.js";
import {
  assertNoFailedProviderCalls,
  installOpenAIUsageMeter,
  mergeBenchmarkUsage,
  USAGE_SCHEMA_VERSION,
} from "../usage.js";
import {
  type AdapterConfig,
  type AdapterDiagnostics,
  type BenchMessage,
  createAdapter,
  type MemoryAdapter,
  mergeAdapterDiagnostics,
} from "./adapters.js";
import {
  DATASET_PATH,
  loadDataset,
  type SelectedLocomoQuestion,
  selectLocomoQuestions,
  sessionsOf,
  turnText,
} from "./dataset.js";
import { bleu1, mean, percentile, tokenF1 } from "./metrics.js";
import {
  ANSWER_SYSTEM,
  buildAnswerUser,
  buildJudgeUser,
  JUDGE_SYSTEM,
} from "./prompts.js";
import type {
  BenchmarkRun,
  LocomoSample,
  QuestionResult,
  SystemReport,
} from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// ── tiny .env loader (no dependency) ────────────────────────────────────────
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
const TRACE = hasFlag("trace");
const OVERRIDES = arg("overrides") ? JSON.parse(arg("overrides")!) : undefined;
// Same-store search-variant ablation: ingest ONCE, then evaluate each
// variant's search config on the identical memory store (answer+judge only
// re-run). Variants: [{name, overrides}] — fishmem single-system only.
const SEARCH_VARIANTS:
  | Array<{ name: string; overrides: Record<string, unknown> }>
  | undefined = arg("search-variants-file")
  ? JSON.parse(readFileSync(arg("search-variants-file")!, "utf8"))
  : arg("search-variants")
    ? JSON.parse(arg("search-variants")!)
    : undefined;
// Paired sequential testing: with exactly two systems, answer questions
// interleaved and stop early once the SPRT on discordant pairs is decisive
// (H0 p=0.5 vs H1 p=0.65, α=β=0.05). Saves the answer/judge spend of runs
// whose verdict is already statistically settled; ingest still runs fully.
const PAIRED_SPRT = hasFlag("paired-sprt");
// Crash-safe incremental runs: each system×conversation is recorded to a
// `<out>.partial.jsonl` sidecar as it finishes. `--resume` skips already-done
// units (no re-ingest, no re-spend); `--no-checkpoint` disables the sidecar.
const RESUME = hasFlag("resume");
const NO_CHECKPOINT = hasFlag("no-checkpoint");
// Persistent cross-run result cache (`--cache`): reuse a (system × conversation)
// result when its fingerprint (models/top-k/chunking/categories/overrides + a
// per-system CODE version) is unchanged — so iterating on fishmem doesn't
// re-run the pinned, slow mem0 baseline. `--cache-dir` overrides the location.
const USE_CACHE = hasFlag("cache");
const CACHE_DIR = arg("cache-dir", join(HERE, "../.cache"))!;
const REPO_ROOT = join(HERE, "../..");
const SYSTEMS = (arg("systems", SMOKE ? "fishmem" : "fishmem,mem0") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const N_CONVERSATIONS = Number(arg("conversations", "1"));
const MAX_QUESTIONS = arg("max-questions")
  ? Number(arg("max-questions"))
  : Infinity;
const CATEGORIES = new Set(
  (arg("categories", "1,2,3,4") ?? "").split(",").map(Number),
);
const TOP_K = Number(arg("top-k", "10"));
const CHUNK_SIZE = Number(arg("chunk-size", "4"));
const MAX_SESSIONS = arg("max-sessions")
  ? Number(arg("max-sessions"))
  : Infinity;
const LLM_MODEL = arg("llm", "gpt-4o-mini")!;
const EMBEDDER_MODEL = arg("embedder", "text-embedding-3-small")!;
const JUDGE_MODEL = arg("judge", "gpt-4o-mini")!;
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
const QUESTION_RETRIES = parseIntegerOption(
  arg("question-retries", "0")!,
  "--question-retries",
  0,
);
const OUT = arg("out", join(HERE, "../results", `locomo-${Date.now()}.json`))!;

const API_KEY = process.env.OPENAI_API_KEY ?? "";
const BASE_URL =
  arg("base-url", process.env.OPENAI_BASE_URL ?? "") || undefined;
if (!SMOKE && !API_KEY) {
  console.error(
    "OPENAI_API_KEY is required (set it in the environment or .env). Use --smoke for an offline pipeline check.",
  );
  process.exit(1);
}
const usageMeter = installOpenAIUsageMeter();

// ── answering + judging LLM (shared across systems for fairness) ────────────
import { MockLLM, OpenAILLM } from "../../packages/fishmem/src/index.js";

const answerLLM = SMOKE
  ? new MockLLM((messages) => {
      const q = messages[messages.length - 1]?.content ?? "";
      if (q.includes("CORRECT or WRONG"))
        return JSON.stringify({ label: "CORRECT" });
      if (q.includes("Where does Alice work?")) return "Acme Corp";
      if (q.includes("What does Bob enjoy?")) return "hiking";
      throw new Error(`unexpected LOCOMO smoke prompt: ${q.slice(0, 120)}`);
    })
  : new OpenAILLM({
      apiKey: API_KEY,
      model: LLM_MODEL,
      temperature: 0,
      ...(BASE_URL ? { baseURL: BASE_URL } : {}),
      timeoutMs: PROVIDER_TIMEOUT_MS,
      maxRetries: PROVIDER_RETRIES,
    });
const judgeLLM = SMOKE
  ? answerLLM
  : new OpenAILLM({
      apiKey: API_KEY,
      model: JUDGE_MODEL,
      temperature: 0,
      ...(BASE_URL ? { baseURL: BASE_URL } : {}),
      timeoutMs: PROVIDER_TIMEOUT_MS,
      maxRetries: PROVIDER_RETRIES,
    });

// ── phases ───────────────────────────────────────────────────────────────────

function chunkSession(
  sample: LocomoSample,
  sessionIdx: number,
): { messages: BenchMessage[]; dateTime: string }[] {
  const sessions = sessionsOf(sample);
  const session = sessions[sessionIdx]!;
  const speakerA = sample.conversation.speaker_a;
  const chunks: { messages: BenchMessage[]; dateTime: string }[] = [];
  for (let i = 0; i < session.turns.length; i += CHUNK_SIZE) {
    const slice = session.turns.slice(i, i + CHUNK_SIZE);
    const messages: BenchMessage[] = slice
      .map((turn) => {
        const text = turnText(turn);
        if (!text) return null;
        return {
          role:
            turn.speaker === speakerA
              ? ("user" as const)
              : ("assistant" as const),
          content: `${turn.speaker}: ${text}`,
        };
      })
      .filter((m): m is BenchMessage => m !== null);
    if (messages.length === 0) continue;
    // Date context goes into the first message so both systems can resolve
    // temporal questions (mem0's eval also injects the session timestamp).
    messages[0] = {
      ...messages[0]!,
      content: `(conversation date: ${session.dateTime}) ${messages[0]!.content}`,
    };
    chunks.push({ messages, dateTime: session.dateTime });
  }
  return chunks;
}

async function ingest(
  adapter: MemoryAdapter,
  samples: LocomoSample[],
): Promise<SystemReport["ingest"]> {
  const chunkLatencies: number[] = [];
  let sessions = 0;
  let chunks = 0;
  let memories = 0;
  const t0 = Date.now();
  for (const sample of samples) {
    const userId = `locomo_${sample.sample_id}`;
    const sessionList = sessionsOf(sample).slice(0, MAX_SESSIONS);
    for (let s = 0; s < sessionList.length; s++) {
      sessions++;
      for (const chunk of chunkSession(sample, s)) {
        const start = Date.now();
        // A failed write aborts the unit; a partial corpus is never scored.
        // Provider and complete-operation retry policy lives in the adapter.
        let added: number;
        try {
          added = await usageMeter.run(
            `${adapter.name}/${sample.sample_id}/memory`,
            () => adapter.add(chunk.messages, userId),
          );
        } catch (err) {
          throw new Error(
            `[${adapter.name}] add failed (${sample.sample_id} session ${s + 1})`,
            { cause: err },
          );
        }
        memories += added;
        chunkLatencies.push(Date.now() - start);
        chunks++;
      }
      if (adapter.endSession) {
        try {
          await usageMeter.run(
            `${adapter.name}/${sample.sample_id}/memory`,
            () => adapter.endSession!(userId),
          );
        } catch (err) {
          throw new Error(
            `[${adapter.name}] endSession failed (${sample.sample_id} session ${s + 1})`,
            { cause: err },
          );
        }
      }
      process.stdout.write(
        `\r  [${adapter.name}] ingest ${sample.sample_id}: session ${s + 1}/${sessionList.length}, ${memories} memories   `,
      );
    }
  }
  process.stdout.write("\n");
  return {
    conversations: samples.length,
    sessions,
    chunks,
    memoriesCreated: memories,
    failedAdds: 0,
    totalMs: Date.now() - t0,
    chunkMsP50: percentile(chunkLatencies, 50),
    chunkMsP95: percentile(chunkLatencies, 95),
  };
}

async function answerOne(
  adapter: MemoryAdapter,
  sample: LocomoSample,
  selected: SelectedLocomoQuestion,
  usageSystem = adapter.name,
  attempt = 0,
): Promise<QuestionResult> {
  const { qa, questionIndex, goldAnswer: gold } = selected;
  const usageScope = `${usageSystem}/${sample.sample_id}/question-${questionIndex}/attempt-${attempt}`;
  const userId = `locomo_${sample.sample_id}`;
  const t1 = Date.now();
  const memories = await usageMeter.run(`${usageScope}/memory`, () =>
    adapter.search(qa.question, userId, TOP_K),
  );
  const searchMs = Date.now() - t1;
  const memoriesUsed = memories.length;
  const context = memories.map((m) => `- ${m.text}`).join("\n") || "(none)";
  const t2 = Date.now();
  const generated = (
    await usageMeter.run(`${usageScope}/answer`, () =>
      answerLLM.chat(
        [
          { role: "system", content: ANSWER_SYSTEM },
          { role: "user", content: buildAnswerUser(context, qa.question) },
        ],
        { temperature: 0 },
      ),
    )
  ).trim();
  const answerMs = Date.now() - t2;
  const raw = await usageMeter.run(`${usageScope}/judge`, () =>
    judgeLLM.chat(
      [
        { role: "system", content: JUDGE_SYSTEM },
        { role: "user", content: buildJudgeUser(qa.question, gold, generated) },
      ],
      { responseFormat: "json", temperature: 0 },
    ),
  );
  const json = raw.match(/\{[\s\S]*\}/)?.[0];
  if (!json) throw new Error(`judge returned no JSON for: ${qa.question}`);
  const label: unknown = JSON.parse(json).label;
  if (label !== "CORRECT" && label !== "WRONG") {
    throw new Error(`judge returned invalid label for: ${qa.question}`);
  }
  return {
    ...(TRACE && adapter.lastTrace ? { trace: adapter.lastTrace() } : {}),
    sampleId: sample.sample_id,
    questionIndex,
    question: qa.question,
    goldAnswer: gold,
    category: qa.category,
    generatedAnswer: generated,
    judgeLabel: label,
    f1: tokenF1(generated, gold),
    bleu1: bleu1(generated, gold),
    searchMs,
    answerMs,
    contextChars: context.length,
    contextTokens: countContextTokens(context),
    memoriesUsed,
  };
}

type QuestionAttemptLedger = {
  schemaVersion: "locomo-question-attempts-v1";
  questionRetries: number;
  updatedAt: string;
  failures: Array<{
    at: string;
    system: string;
    sampleId: string;
    questionIndex: number;
    attempt: number;
    error: string;
  }>;
};

let questionAttemptLedger: QuestionAttemptLedger | undefined;

function loadQuestionAttemptLedger(): QuestionAttemptLedger {
  const path = `${OUT}.question-attempts.json`;
  questionAttemptLedger ??= existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as QuestionAttemptLedger)
    : {
        schemaVersion: "locomo-question-attempts-v1",
        questionRetries: QUESTION_RETRIES,
        updatedAt: new Date().toISOString(),
        failures: [],
      };
  if (questionAttemptLedger.questionRetries !== QUESTION_RETRIES) {
    throw new Error(`question attempt ledger config mismatch: ${path}`);
  }
  return questionAttemptLedger;
}

function recordQuestionFailure(
  system: string,
  sampleId: string,
  questionIndex: number,
  attempt: number,
  error: unknown,
): void {
  const path = `${OUT}.question-attempts.json`;
  const ledger = loadQuestionAttemptLedger();
  const at = new Date().toISOString();
  ledger.updatedAt = at;
  ledger.failures.push({
    at,
    system,
    sampleId,
    questionIndex,
    attempt,
    error: benchmarkErrorMessage(error),
  });
  writeJsonAtomic(path, ledger);
}

function questionAttemptDiagnostics(
  system: string,
  sampleId: string,
): AdapterDiagnostics {
  const failures = loadQuestionAttemptLedger().failures.filter(
    (failure) => failure.system === system && failure.sampleId === sampleId,
  );
  const timeouts = failures.filter((failure) =>
    /timed out|timeout|aborted/i.test(failure.error),
  ).length;
  return {
    warningCounts:
      failures.length === 0 ? {} : { question_attempt_failed: failures.length },
    retries: failures.length,
    timeouts,
  };
}

async function answerOneWithRetries(
  adapter: MemoryAdapter,
  sample: LocomoSample,
  selected: SelectedLocomoQuestion,
  usageSystem: string,
): Promise<QuestionCheckpoint> {
  const { questionIndex } = selected;
  const key = `${usageSystem}:${sample.sample_id}:${questionIndex}`;
  for (let attempt = 0; attempt <= QUESTION_RETRIES; attempt++) {
    const scope = `${usageSystem}/${sample.sample_id}/question-${questionIndex}/attempt-${attempt}`;
    try {
      const result = await answerOne(
        adapter,
        sample,
        selected,
        usageSystem,
        attempt,
      );
      const usage = usageMeter.summary(scope);
      assertNoFailedProviderCalls(usage, `${key}:attempt-${attempt}`);
      return { result, usage };
    } catch (error) {
      recordQuestionFailure(
        usageSystem,
        sample.sample_id,
        questionIndex,
        attempt,
        error,
      );
      if (attempt >= QUESTION_RETRIES) throw error;
      console.warn(
        `\n  [${usageSystem}] retry question ${sample.sample_id}:${questionIndex} (${attempt + 1}/${QUESTION_RETRIES})`,
      );
      await new Promise((resolve) =>
        setTimeout(resolve, 1_500 * (attempt + 1)),
      );
    }
  }
  throw new Error("unreachable question retry state");
}

function selectedQuestions(sample: LocomoSample): SelectedLocomoQuestion[] {
  return selectLocomoQuestions(sample, CATEGORIES, MAX_QUESTIONS);
}

/** Paired interleaved answering with SPRT early stop on discordant pairs. */
async function answerQuestionsPaired(
  adapters: [MemoryAdapter, MemoryAdapter],
  samples: LocomoSample[],
): Promise<[QuestionResult[], QuestionResult[]]> {
  // SPRT boundaries for Bernoulli p0=0.5 vs p1=0.65, alpha=beta=0.05.
  const p1 = 0.65;
  const upper = Math.log(0.95 / 0.05);
  const lower = Math.log(0.05 / 0.95);
  const llrStep = (aWins: boolean) =>
    aWins ? Math.log(p1 / 0.5) : Math.log((1 - p1) / 0.5);
  let llr = 0;
  let discordant = 0;
  const qa: QuestionResult[] = [];
  const qb: QuestionResult[] = [];
  let done = 0;
  let total = 0;
  for (const sample of samples) {
    total += selectedQuestions(sample).length;
  }
  outer: for (const sample of samples) {
    const questions = selectedQuestions(sample);
    for (const question of questions) {
      const ra = await answerOne(adapters[0], sample, question);
      const rb = await answerOne(adapters[1], sample, question);
      qa.push(ra);
      qb.push(rb);
      const aOk = ra.judgeLabel === "CORRECT";
      const bOk = rb.judgeLabel === "CORRECT";
      if (aOk !== bOk) {
        discordant++;
        llr += llrStep(aOk);
        // Symmetric test: decisive in either direction ends the run.
        if (llr >= upper || llr <= lower) {
          done++;
          console.log(
            `\nSPRT decisive after ${done}/${total} questions ` +
              `(${discordant} discordant, LLR ${llr.toFixed(2)}): ` +
              (llr >= upper ? adapters[0].name : adapters[1].name) +
              " wins — stopping early.",
          );
          break outer;
        }
      }
      done++;
      process.stdout.write(
        `\r  paired ${done}/${total} (discordant ${discordant}, LLR ${llr.toFixed(2)})   `,
      );
    }
  }
  process.stdout.write("\n");
  return [qa, qb];
}

async function answerQuestions(
  adapter: MemoryAdapter,
  samples: LocomoSample[],
  usageSystem = adapter.name,
  checkpoint?: {
    get(key: string): QuestionCheckpoint | undefined;
    record(key: string, value: QuestionCheckpoint): void;
    usage: BenchmarkUsage[];
  },
): Promise<QuestionResult[]> {
  const results: QuestionResult[] = [];
  for (const sample of samples) {
    const questions = selectedQuestions(sample);
    let done = 0;
    for (const question of questions) {
      const { questionIndex } = question;
      const key = `${usageSystem}:${sample.sample_id}:${questionIndex}`;
      const saved = checkpoint?.get(key);
      if (saved) {
        assertNoFailedProviderCalls(saved.usage, key);
        results.push(saved.result);
        checkpoint!.usage.push(saved.usage);
      } else {
        const { result, usage } = await answerOneWithRetries(
          adapter,
          sample,
          question,
          usageSystem,
        );
        results.push(result);
        if (checkpoint) {
          checkpoint.record(key, { result, usage });
          checkpoint.usage.push(usage);
        }
      }
      done++;
      process.stdout.write(
        `\r  [${adapter.name}] answer ${sample.sample_id}: ${done}/${questions.length}   `,
      );
    }
    process.stdout.write("\n");
  }
  return results;
}

/** Merge per-conversation ingest stats into one system-level summary. */
function mergeIngest(parts: SystemReport["ingest"][]): SystemReport["ingest"] {
  if (parts.length <= 1) return parts[0] ?? ({} as SystemReport["ingest"]);
  const sum = (k: keyof SystemReport["ingest"]) =>
    parts.reduce((a, p) => a + ((p[k] as number) ?? 0), 0);
  const totalChunks = sum("chunks") || 1;
  return {
    conversations: sum("conversations"),
    sessions: sum("sessions"),
    chunks: sum("chunks"),
    memoriesCreated: sum("memoriesCreated"),
    failedAdds: sum("failedAdds"),
    totalMs: sum("totalMs"),
    // Chunk-weighted p50, conservative (max) p95 — informational on merge.
    chunkMsP50: Math.round(
      parts.reduce((a, p) => a + p.chunkMsP50 * p.chunks, 0) / totalChunks,
    ),
    chunkMsP95: Math.max(...parts.map((p) => p.chunkMsP95)),
  };
}

function summarize(questions: QuestionResult[]): SystemReport["summary"] {
  const byCat: Record<string, { n: number; correct: number }> = {};
  let correct = 0;
  for (const q of questions) {
    const cat = String(q.category);
    byCat[cat] ??= { n: 0, correct: 0 };
    byCat[cat]!.n++;
    if (q.judgeLabel === "CORRECT") {
      byCat[cat]!.correct++;
      correct++;
    }
  }
  return {
    total: questions.length,
    judgeAccuracy: questions.length ? correct / questions.length : 0,
    judgeAccuracyByCategory: Object.fromEntries(
      Object.entries(byCat).map(([cat, v]) => [
        cat,
        { n: v.n, accuracy: v.n ? v.correct / v.n : 0 },
      ]),
    ),
    meanF1: mean(questions.map((q) => q.f1)),
    meanBleu1: mean(questions.map((q) => q.bleu1)),
    searchMsP50: percentile(
      questions.map((q) => q.searchMs),
      50,
    ),
    searchMsP95: percentile(
      questions.map((q) => q.searchMs),
      95,
    ),
    answerMsP50: percentile(
      questions.map((q) => q.answerMs),
      50,
    ),
    answerMsP95: percentile(
      questions.map((q) => q.answerMs),
      95,
    ),
    meanContextChars: mean(questions.map((q) => q.contextChars)),
    meanContextTokens: mean(questions.map((q) => q.contextTokens)),
  };
}

type LocomoUnit = {
  ingest: SystemReport["ingest"];
  questions: QuestionResult[];
  diagnostics: AdapterDiagnostics;
  usage: BenchmarkUsage;
};

type QuestionCheckpoint = {
  result: QuestionResult;
  usage: BenchmarkUsage;
};

function publishProgress(
  units: Map<string, LocomoUnit>,
  samples: LocomoSample[],
  startedAt: string,
  status: "running" | "complete" | "failed",
  error?: unknown,
): void {
  const unitsFor = (system: string) =>
    samples
      .map((sample) => units.get(`${system}:${sample.sample_id}`))
      .filter((unit): unit is LocomoUnit => unit !== undefined);
  const systems = SYSTEMS.map((system) => {
    const completed = unitsFor(system);
    const questions = completed.flatMap((unit) => unit.questions);
    const usage = mergeBenchmarkUsage(completed.map((unit) => unit.usage));
    return {
      system,
      completed: completed.length,
      total: samples.length,
      quality: questions.length > 0 ? summarize(questions).judgeAccuracy : null,
      ingestMs: completed.reduce(
        (total, unit) => total + unit.ingest.totalMs,
        0,
      ),
      llmCalls: usage.llmCalls,
      embeddingCalls: usage.embeddingCalls,
      estimatedUsd: usage.estimatedUsd ?? 0,
      failedCalls: usage.failedCalls,
      checkpoint: `${OUT}.partial.jsonl`,
    };
  });
  const commonSamples = samples.filter(
    (sample) =>
      units.has(`fishmem:${sample.sample_id}`) &&
      units.has(`mem0:${sample.sample_id}`),
  );
  const common = commonSamples.length;
  const fishmemQuestions = commonSamples.flatMap(
    (sample) => units.get(`fishmem:${sample.sample_id}`)!.questions,
  );
  const mem0Questions = commonSamples.flatMap(
    (sample) => units.get(`mem0:${sample.sample_id}`)!.questions,
  );
  const fishmemQuality =
    common > 0 ? summarize(fishmemQuestions).judgeAccuracy : null;
  const mem0Quality =
    common > 0 ? summarize(mem0Questions).judgeAccuracy : null;
  writeBenchmarkProgress(OUT, {
    benchmark: "locomo",
    status,
    startedAt,
    updatedAt: new Date().toISOString(),
    output: OUT,
    ...(error === undefined ? {} : { error: benchmarkErrorMessage(error) }),
    systems,
    paired: {
      commonUnits: common,
      fishmemQuality,
      mem0Quality,
      difference:
        fishmemQuality === null || mem0Quality === null
          ? null
          : fishmemQuality - mem0Quality,
    },
  });
}

const CATEGORY_NAMES: Record<string, string> = {
  "1": "multi-hop",
  "2": "temporal",
  "3": "open-domain",
  "4": "single-hop",
  "5": "adversarial",
};

function printReport(reports: SystemReport[]): void {
  console.log("\n## LOCOMO results\n");
  const header = ["metric", ...reports.map((r) => r.system)];
  const rows: string[][] = [];
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const ms = (x: number) => `${x.toFixed(0)}ms`;
  rows.push(["questions", ...reports.map((r) => String(r.summary.total))]);
  rows.push([
    "judge accuracy",
    ...reports.map((r) => pct(r.summary.judgeAccuracy)),
  ]);
  const cats = new Set(
    reports.flatMap((r) => Object.keys(r.summary.judgeAccuracyByCategory)),
  );
  for (const cat of [...cats].sort()) {
    rows.push([
      `  cat ${cat} (${CATEGORY_NAMES[cat] ?? "?"})`,
      ...reports.map((r) => {
        const c = r.summary.judgeAccuracyByCategory[cat];
        return c ? `${pct(c.accuracy)} (n=${c.n})` : "—";
      }),
    ]);
  }
  rows.push(["mean F1", ...reports.map((r) => r.summary.meanF1.toFixed(3))]);
  rows.push([
    "mean BLEU-1",
    ...reports.map((r) => r.summary.meanBleu1.toFixed(3)),
  ]);
  rows.push(["search p50", ...reports.map((r) => ms(r.summary.searchMsP50))]);
  rows.push(["search p95", ...reports.map((r) => ms(r.summary.searchMsP95))]);
  rows.push(["answer p50", ...reports.map((r) => ms(r.summary.answerMsP50))]);
  rows.push([
    "ingest total",
    ...reports.map((r) => `${(r.ingest.totalMs / 1000).toFixed(1)}s`),
  ]);
  rows.push([
    "ingest chunk p50",
    ...reports.map((r) => ms(r.ingest.chunkMsP50)),
  ]);
  rows.push([
    "mean context tokens",
    ...reports.map((r) =>
      String((r.summary as Record<string, unknown>).meanContextTokens ?? "—"),
    ),
  ]);
  rows.push([
    "memories created",
    ...reports.map((r) => String(r.ingest.memoriesCreated)),
  ]);
  rows.push([
    "dropped adds",
    ...reports.map((r) => String(r.ingest.failedAdds ?? 0)),
  ]);

  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => (row[i] ?? "").length)),
  );
  const fmt = (row: string[]) =>
    `| ${row.map((c, i) => (c ?? "").padEnd(widths[i]!)).join(" | ")} |`;
  console.log(fmt(header));
  console.log(`|${widths.map((w) => "-".repeat(w + 2)).join("|")}|`);
  for (const row of rows) console.log(fmt(row));

  // A run with permanently-dropped adds is NOT clean — one or both systems lost
  // memories the other kept, biasing the comparison. Flag it unmissably.
  const dropped = reports.filter((r) => (r.ingest.failedAdds ?? 0) > 0);
  if (dropped.length) {
    console.log(
      `\n⚠️  NOT A CLEAN RUN — permanent add drops: ${dropped
        .map((r) => `${r.system}=${r.ingest.failedAdds}`)
        .join(
          ", ",
        )}. Memories were lost asymmetrically; re-run before trusting these numbers.`,
    );
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const startedAt = new Date().toISOString();
  const all = SMOKE ? smokeDataset() : loadDataset();
  // --conversation-ids conv-30,conv-41 selects specific conversations by id
  // (overrides --conversations N). Lets a run target the held-out split
  // exactly, or top up one system without re-ingesting others.
  const CONV_IDS = arg("conversation-ids")
    ? new Set(
        arg("conversation-ids")!
          .split(",")
          .map((s) => s.trim()),
      )
    : undefined;
  const samples = CONV_IDS
    ? all.filter((s) => CONV_IDS.has(s.sample_id))
    : all.slice(0, Math.max(1, N_CONVERSATIONS));
  if (CONV_IDS && samples.length !== CONV_IDS.size) {
    console.error(
      `warning: requested ${CONV_IDS.size} ids, matched ${samples.length} (available: ${all.map((s) => s.sample_id).join(", ")})`,
    );
  }
  console.log(
    `LOCOMO benchmark — systems: ${SYSTEMS.join(", ")} | conversations: ${samples.length} | categories: ${[...CATEGORIES].join(",")} | top-k: ${TOP_K} | llm: ${SMOKE ? "mock" : LLM_MODEL}`,
  );

  const adapterCfg: AdapterConfig = {
    llmModel: LLM_MODEL,
    embedderModel: EMBEDDER_MODEL,
    apiKey: API_KEY,
    baseURL: BASE_URL,
    mock: SMOKE,
    trace: TRACE,
    overrides: OVERRIDES,
    providerFetch: globalThis.fetch,
    providerTimeoutMs: PROVIDER_TIMEOUT_MS,
    operationTimeoutMs: OPERATION_TIMEOUT_MS,
    providerRetries: PROVIDER_RETRIES,
    operationRetries: OPERATION_RETRIES,
  };

  const reports: SystemReport[] = [];
  let finalizeCheckpoint = () => {};
  let completeProgress = () => {};
  if (
    SEARCH_VARIANTS &&
    SYSTEMS.length === 1 &&
    SYSTEMS[0]!.startsWith("fishmem")
  ) {
    console.log(
      `\n=== ${SYSTEMS[0]} (single ingest, ${SEARCH_VARIANTS.length} search variants) ===`,
    );
    const adapter = await createAdapter(SYSTEMS[0]!, adapterCfg);
    await adapter.init();
    const ingestStats = await ingest(adapter, samples);
    for (const variant of SEARCH_VARIANTS) {
      console.log(`\n--- variant: ${variant.name} ---`);
      await adapter.setSearchOverrides!(variant.overrides);
      const reportSystem = `${SYSTEMS[0]}:${variant.name}`;
      const questions = await answerQuestions(adapter, samples, reportSystem);
      const usage = mergeBenchmarkUsage([
        usageMeter.summary(SYSTEMS[0]!),
        usageMeter.summary(reportSystem),
      ]);
      usage.unscopedCalls = usageMeter.unscopedCalls();
      reports.push({
        system: reportSystem,
        systemVersion: systemCodeVersion(SYSTEMS[0]!, REPO_ROOT),
        diagnostics: adapter.drainDiagnostics(),
        usage,
        models: {
          llm: SMOKE ? "mock" : LLM_MODEL,
          embedder: SMOKE ? "mock" : EMBEDDER_MODEL,
        },
        ingest: ingestStats,
        questions,
        summary: summarize(questions),
      });
    }
    await adapter.close();
  } else if (PAIRED_SPRT && SYSTEMS.length === 2) {
    const adapters: MemoryAdapter[] = [];
    const ingests: SystemReport["ingest"][] = [];
    for (const system of SYSTEMS) {
      console.log(`\n=== ${system} (ingest) ===`);
      const adapter = await createAdapter(system, adapterCfg);
      await adapter.init();
      adapters.push(adapter);
      ingests.push(await ingest(adapter, samples));
    }
    console.log("\n=== paired answering with SPRT early stop ===");
    const [qa, qb] = await answerQuestionsPaired(
      adapters as [MemoryAdapter, MemoryAdapter],
      samples,
    );
    for (let i = 0; i < 2; i++) {
      await adapters[i]!.close();
      reports.push({
        system: SYSTEMS[i]!,
        systemVersion: systemCodeVersion(SYSTEMS[i]!, REPO_ROOT),
        diagnostics: adapters[i]!.drainDiagnostics(),
        usage: usageMeter.summary(SYSTEMS[i]!),
        models: {
          llm: SMOKE ? "mock" : LLM_MODEL,
          embedder: SMOKE ? "mock" : EMBEDDER_MODEL,
        },
        ingest: ingests[i]!,
        questions: i === 0 ? qa : qb,
        summary: summarize(i === 0 ? qa : qb),
      });
    }
  } else {
    // Crash-safe: each (system × conversation) is ingested+answered+recorded to
    // a `<out>.partial.jsonl` sidecar as a unit. `--resume` reuses recorded
    // units verbatim (no re-ingest, no re-spend); the sidecar also lets you read
    // partial accuracy mid-run. Per-conversation ingest is behaviorally
    // identical to ingest-all here — each conversation is isolated by userId, so
    // search results (and thus accuracy) are unchanged.
    const checkpointMeta = {
      systems: SYSTEMS,
      systemVersions: Object.fromEntries(
        SYSTEMS.map((system) => [system, systemCodeVersion(system, REPO_ROOT)]),
      ),
      split: SPLIT,
      conversations: samples.map((s) => s.sample_id),
      categories: [...CATEGORIES],
      topK: TOP_K,
      chunkSize: CHUNK_SIZE,
      maxSessions: MAX_SESSIONS ?? null,
      maxQuestions: MAX_QUESTIONS ?? null,
      llm: LLM_MODEL,
      embedder: EMBEDDER_MODEL,
      judge: JUDGE_MODEL,
      baseURL: BASE_URL ?? null,
      overrides: OVERRIDES ?? null,
      usageSchema: USAGE_SCHEMA_VERSION,
      providerTimeoutMs: PROVIDER_TIMEOUT_MS,
      operationTimeoutMs: OPERATION_TIMEOUT_MS,
      providerRetries: PROVIDER_RETRIES,
      operationRetries: OPERATION_RETRIES,
      questionRetries: QUESTION_RETRIES,
    };
    const cp = openCheckpoint<LocomoUnit>(OUT, {
      resume: RESUME,
      enabled: !NO_CHECKPOINT,
      meta: checkpointMeta,
    });
    const questionCp = openCheckpoint<QuestionCheckpoint>(`${OUT}.questions`, {
      resume: RESUME,
      enabled: !NO_CHECKPOINT,
      meta: { ...checkpointMeta, granularity: "question" },
    });
    if (cp.doneCount) {
      console.log(
        `(resume) ${cp.doneCount} system×conversation unit(s) already recorded — skipping those`,
      );
    }
    finalizeCheckpoint = () => {
      cp.finalize();
      questionCp.finalize();
    };
    const progressUnits = new Map<string, LocomoUnit>();
    publishProgress(progressUnits, samples, startedAt, "running");
    publishFailure = (error) =>
      publishProgress(progressUnits, samples, startedAt, "failed", error);
    completeProgress = () =>
      publishProgress(progressUnits, samples, startedAt, "complete");
    const cache = openResultCache<{
      ingest: SystemReport["ingest"];
      questions: QuestionResult[];
      diagnostics: AdapterDiagnostics;
      usage: BenchmarkUsage;
    }>({ dir: CACHE_DIR, enabled: USE_CACHE });
    // Config portion of the cache fingerprint (constant across systems/convs).
    const cacheCfg = {
      llm: LLM_MODEL,
      embedder: EMBEDDER_MODEL,
      judge: JUDGE_MODEL,
      topK: TOP_K,
      chunkSize: CHUNK_SIZE,
      maxSessions: MAX_SESSIONS ?? null,
      maxQuestions: MAX_QUESTIONS ?? null,
      categories: [...CATEGORIES].sort(),
      split: SPLIT,
      overrides: OVERRIDES ?? null,
      usageSchema: USAGE_SCHEMA_VERSION,
      providerTimeoutMs: PROVIDER_TIMEOUT_MS,
      operationTimeoutMs: OPERATION_TIMEOUT_MS,
      providerRetries: PROVIDER_RETRIES,
      operationRetries: OPERATION_RETRIES,
      questionRetries: QUESTION_RETRIES,
    };
    if (USE_CACHE) console.log(`(cache) persistent result cache: ${CACHE_DIR}`);
    for (const system of SYSTEMS) {
      console.log(`\n=== ${system} ===`);
      // Per-system code version busts the cache when the engine changes
      // (fishmem: source hash; mem0: pinned package version).
      const codeVer = USE_CACHE ? systemCodeVersion(system, REPO_ROOT) : "";
      let adapter: MemoryAdapter | null = null; // created lazily — skipped if all cached
      const ingestParts: SystemReport["ingest"][] = [];
      const questions: QuestionResult[] = [];
      const diagnosticParts: AdapterDiagnostics[] = [];
      const usageParts: BenchmarkUsage[] = [];
      for (const sample of samples) {
        const key = `${system}:${sample.sample_id}`;
        const fp = USE_CACHE
          ? fingerprint({
              ...cacheCfg,
              system,
              sampleId: sample.sample_id,
              code: codeVer,
            })
          : "";
        // 1) same-run checkpoint, then 2) cross-run persistent cache.
        const unit = cp.get(key) ?? cache.get(fp);
        if (unit) {
          assertNoFailedProviderCalls(unit.usage, key);
          cp.record(key, unit); // idempotent; promotes a cache hit into this run
          progressUnits.set(key, unit);
          publishProgress(progressUnits, samples, startedAt, "running");
          console.log(
            `  [${system}] ${sample.sample_id}: ✓ reused (${unit.questions.length} q)`,
          );
          ingestParts.push(unit.ingest);
          questions.push(...unit.questions);
          diagnosticParts.push(unit.diagnostics);
          usageParts.push(unit.usage);
          continue;
        }
        if (!adapter) {
          adapter = await createAdapter(system, adapterCfg);
          await adapter.init();
        }
        const ingestStats = await ingest(adapter, [sample]);
        const ingestUsage = usageMeter.summary(
          `${system}/${sample.sample_id}/memory`,
        );
        assertNoFailedProviderCalls(ingestUsage, `${key}:ingest`);
        const questionUsage: BenchmarkUsage[] = [];
        const qs = await answerQuestions(adapter, [sample], system, {
          get: questionCp.get,
          record: questionCp.record,
          usage: questionUsage,
        });
        const usage = mergeBenchmarkUsage([ingestUsage, ...questionUsage]);
        assertNoFailedProviderCalls(usage, key);
        const fresh = {
          ingest: ingestStats,
          questions: qs,
          diagnostics: mergeAdapterDiagnostics([
            adapter.drainDiagnostics(),
            questionAttemptDiagnostics(system, sample.sample_id),
          ]),
          usage,
        };
        cp.record(key, fresh);
        progressUnits.set(key, fresh);
        publishProgress(progressUnits, samples, startedAt, "running");
        if (USE_CACHE) cache.put(fp, key, fresh);
        ingestParts.push(ingestStats);
        questions.push(...qs);
        diagnosticParts.push(fresh.diagnostics);
        usageParts.push(fresh.usage);
      }
      if (adapter) await adapter.close();
      reports.push({
        system,
        systemVersion: systemCodeVersion(system, REPO_ROOT),
        diagnostics: mergeAdapterDiagnostics(diagnosticParts),
        usage: mergeBenchmarkUsage(usageParts),
        models: {
          llm: SMOKE ? "mock" : LLM_MODEL,
          embedder: SMOKE ? "mock" : EMBEDDER_MODEL,
        },
        ingest: mergeIngest(ingestParts),
        questions,
        summary: summarize(questions),
      });
    }
  }

  const unscopedCalls = usageMeter.unscopedCalls();
  for (const report of reports) report.usage.unscopedCalls = unscopedCalls;

  const run: BenchmarkRun = {
    startedAt,
    dataset: SMOKE ? "smoke-fixture" : DATASET_PATH,
    config: {
      conversations: samples.length,
      conversationIds: samples.map((sample) => sample.sample_id),
      categories: [...CATEGORIES],
      topK: TOP_K,
      chunkSize: CHUNK_SIZE,
      maxSessions: MAX_SESSIONS ?? null,
      maxQuestions: Number.isFinite(MAX_QUESTIONS) ? MAX_QUESTIONS : null,
      llm: LLM_MODEL,
      embedder: EMBEDDER_MODEL,
      judge: JUDGE_MODEL,
      smoke: SMOKE,
      split: SPLIT,
      contextTokenizer: CONTEXT_TOKENIZER,
      baseURL: BASE_URL ?? null,
      overrides: OVERRIDES ?? null,
      usageSchema: USAGE_SCHEMA_VERSION,
      providerTimeoutMs: PROVIDER_TIMEOUT_MS,
      operationTimeoutMs: OPERATION_TIMEOUT_MS,
      providerRetries: PROVIDER_RETRIES,
      operationRetries: OPERATION_RETRIES,
      questionRetries: QUESTION_RETRIES,
    },
    systems: reports,
  };
  writeJsonAtomic(OUT, run);
  completeProgress();
  finalizeCheckpoint();
  printReport(reports);
  console.log(`\nFull results written to ${OUT}`);

  if (SMOKE) assertSmoke(run);
}

function assertSmoke(run: BenchmarkRun): void {
  const fail = (message: string): never => {
    throw new Error(`LOCOMO smoke assertion failed: ${message}`);
  };
  if (run.dataset !== "smoke-fixture")
    fail(`unexpected dataset ${run.dataset}`);
  if (run.systems.length !== 1 || run.systems[0]?.system !== "fishmem")
    fail("expected exactly one fishmem report");
  const report = run.systems[0]!;
  if (report.ingest.memoriesCreated <= 0) fail("ingest created no memories");
  if (report.ingest.failedAdds !== 0) fail("ingest reported failed adds");
  if (report.questions.length !== 2)
    fail(`expected 2 questions, got ${report.questions.length}`);
  if (report.questions.some((q) => q.memoriesUsed <= 0))
    fail("a question retrieved no memories");
  if (report.questions.some((q) => q.judgeLabel !== "CORRECT"))
    fail("a smoke answer was not judged CORRECT");
  if (report.summary.judgeAccuracy !== 1)
    fail(`expected accuracy 1, got ${report.summary.judgeAccuracy}`);
  console.log(
    "\nSmoke test passed: ingest -> retrieve -> answer -> judge -> report",
  );
}

/** Two-question fixture for the offline --smoke pipeline check. */
function smokeDataset(): LocomoSample[] {
  return [
    {
      sample_id: "smoke-1",
      qa: [
        {
          question: "Where does Alice work?",
          answer: "Acme Corp",
          category: 4,
        },
        { question: "What does Bob enjoy?", answer: "hiking", category: 4 },
      ],
      conversation: {
        speaker_a: "Alice",
        speaker_b: "Bob",
        session_1_date_time: "2:00 pm on 1 May, 2023",
        session_1: [
          {
            speaker: "Alice",
            dia_id: "S1:1",
            text: "I just started a new job at Acme Corp as an engineer.",
          },
          {
            speaker: "Bob",
            dia_id: "S1:2",
            text: "Congrats! I have been hiking every weekend lately, it clears my head.",
          },
          {
            speaker: "Alice",
            dia_id: "S1:3",
            text: "Nice. The Acme office is in downtown Berlin.",
          },
          {
            speaker: "Bob",
            dia_id: "S1:4",
            text: "I love Berlin. My favourite trail is in the Grunewald forest.",
          },
        ],
      },
    },
  ];
}

let publishFailure: ((error: unknown) => void) | undefined;

main()
  .finally(() => usageMeter.restore())
  .catch((err) => {
    publishFailure?.(err);
    console.error(err);
    process.exit(1);
  });
