import type { AdapterDiagnostics } from "../locomo/adapters.js";
import type { BenchmarkUsage } from "../usage.js";

/** LongMemEval dataset shapes (xiaowu0162/LongMemEval) + benchmark result shapes. */

export type LongMemEvalQuestionType =
  | "multi-session"
  | "temporal-reasoning"
  | "knowledge-update"
  | "single-session-user"
  | "single-session-assistant"
  | "single-session-preference";

export const QUESTION_TYPES: LongMemEvalQuestionType[] = [
  "multi-session",
  "temporal-reasoning",
  "knowledge-update",
  "single-session-user",
  "single-session-assistant",
  "single-session-preference",
];

export interface LongMemEvalTurn {
  role: "user" | "assistant";
  content: string;
  /** Present in the dataset: marks turns containing answer evidence (unused by the harness). */
  has_answer?: boolean;
}

export interface LongMemEvalInstance {
  question_id: string;
  question_type: LongMemEvalQuestionType;
  question: string;
  /**
   * Gold answer. For `_abs` (abstention) questions this is an explanation of
   * why the question is unanswerable; for single-session-preference it is a
   * grading rubric.
   */
  answer: string | number;
  /** e.g. "2023/04/10 (Mon) 23:07" */
  question_date: string;
  /** One date per haystack session, aligned with haystack_sessions. */
  haystack_dates: string[];
  haystack_session_ids: string[];
  haystack_sessions: LongMemEvalTurn[][];
  /** Session ids containing the answer evidence. */
  answer_session_ids: string[];
}

// ── Benchmark result shapes ──────────────────────────────────────────────────

export interface InstanceResult {
  questionId: string;
  questionType: LongMemEvalQuestionType;
  /** Official convention: question_ids containing "_abs" must be declined. */
  abstention: boolean;
  question: string;
  questionDate: string;
  goldAnswer: string;
  generatedAnswer: string;
  /** Official judge verdict: substring "yes" in the judge output ⇒ correct. */
  judgeLabel: "yes" | "no" | "ERROR";
  judgeRaw: string;
  ingest: {
    sessions: number;
    chunks: number;
    memoriesCreated: number;
    totalMs: number;
  };
  searchMs: number;
  answerMs: number;
  judgeMs: number;
  contextChars: number;
  contextTokens: number;
  memoriesUsed: number;
  diagnostics: AdapterDiagnostics;
  usage: BenchmarkUsage;
}

export interface TypeAccuracy {
  n: number;
  correct: number;
  accuracy: number;
}

export interface RunSummary {
  total: number;
  /** judgeLabel === "yes" over all questions (judge errors count as wrong). */
  accuracy: number;
  /** Per question type — abstention instances included under their type, as in the official script. */
  byType: Record<string, TypeAccuracy>;
  /** Abstention questions only ("_abs" ids): accuracy of declining correctly. */
  abstention: TypeAccuracy;
  nonAbstention: TypeAccuracy;
  judgeErrors: number;
  searchMsP50: number;
  searchMsP95: number;
  answerMsP50: number;
  answerMsP95: number;
  /** Sum of per-instance ingest time (aggregate work, not wall-clock — instances run concurrently). */
  ingestTotalMs: number;
  sessionsIngested: number;
  chunksIngested: number;
  memoriesCreated: number;
  diagnostics: AdapterDiagnostics;
  /** Sum of recorded ingest/search/answer/judge durations for successful units. Resumable and concurrency-independent. */
  successfulOperationMs: number;
  /** Wall time of this process invocation only; never treated as cross-resume elapsed time. */
  invocationWallClockMs: number;
  resumedUnits: number;
  freshUnits: number;
}

export interface BenchmarkRun {
  startedAt: string;
  finishedAt: string;
  dataset: string;
  system: string;
  config: Record<string, unknown>;
  results: InstanceResult[];
  summary: RunSummary;
  usage: BenchmarkUsage;
}
