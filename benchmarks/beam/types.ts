import type { AdapterDiagnostics } from "../locomo/adapters.js";
import type { BenchmarkUsage } from "../usage.js";

/**
 * BEAM dataset shapes (mohammadtavakoli78/BEAM — "Beyond a Million Tokens",
 * arXiv:2510.27246, ICLR 2026) + benchmark result shapes.
 *
 * On-disk layout mirrors the official repo / `src/beam/download_dataset.py`
 * output: one directory per conversation containing `chat.json` and
 * `probing_questions/probing_questions.json`.
 */

/** The ten memory-ability categories, exactly as keyed in probing_questions.json. */
export const BEAM_CATEGORIES = [
  "abstention",
  "contradiction_resolution",
  "event_ordering",
  "information_extraction",
  "instruction_following",
  "knowledge_update",
  "multi_session_reasoning",
  "preference_following",
  "summarization",
  "temporal_reasoning",
] as const;

export type BeamCategory = (typeof BEAM_CATEGORIES)[number];

// ── chat.json ────────────────────────────────────────────────────────────────

export interface BeamMessage {
  role: "user" | "assistant";
  id: number;
  content: string;
  /** Present on user "main_question" messages, e.g. "March-15-2024". */
  time_anchor?: string;
  index?: string;
  question_type?:
    | "main_question"
    | "answer_ai_question"
    | "followup_question"
    | null;
}

/** One batch of the conversation; `turns` is a list of message groups. */
export interface BeamBatch {
  batch_number: number;
  /** e.g. "April-05-2024" (may be null for the first batch in some chats). */
  time_anchor: string | null;
  turns: BeamMessage[][];
}

/**
 * chat.json top-level shape:
 *  - 100K/500K/1M: BeamBatch[]
 *  - 10M: Array<{ "plan-<n>": BeamBatch[] }> (10 sequential plans per chat)
 */
export type BeamChatFile = BeamBatch[] | Array<Record<string, BeamBatch[]>>;

// ── probing_questions.json ───────────────────────────────────────────────────

/**
 * One probing question. Categories carry extra metadata fields
 * (difficulty, source_chat_ids, ...) which we pass through untouched;
 * only `question` + `rubric` are required by the official evaluation.
 */
export interface BeamQuestion {
  question: string;
  /** Nuggets: atomic criteria judged one by one (the official rubric). */
  rubric: string[];
  difficulty?: string;
  [extra: string]: unknown;
}

export type BeamProbingQuestions = Record<BeamCategory, BeamQuestion[]>;

// ── loader output ────────────────────────────────────────────────────────────

export interface BeamConversation {
  /** Directory name in the dataset, e.g. "1".."35". */
  id: string;
  /** Dataset tier directory: 100K | 500K | 1M | 10M. */
  tier: string;
  /** Flattened batches (10M plan wrappers unwrapped, in plan order). */
  batches: BeamBatch[];
  questions: BeamProbingQuestions;
}

// ── Benchmark result shapes ──────────────────────────────────────────────────

export interface RubricItemVerdict {
  item: string;
  /**
   * Judge score as aggregated by the OFFICIAL code: `int(score)` for nine
   * categories (0.5 floors to 0), `float(score)` for event_ordering.
   */
  score: number;
  /** Raw numeric score the judge emitted, before the int/float cast. */
  rawScore: number;
  reason: string;
}

/** Extra metrics computed for event_ordering (compute_metrics.event_ordering_score). */
export interface EventOrderingScore {
  precision: number;
  recall: number;
  f1: number;
  /** Normalized Kendall tau-b: (tau_b + 1) / 2, 0 when undefined. */
  tau_norm: number;
  /** tau_norm * f1 (official `final_score`). */
  final_score: number;
}

export interface QuestionResult {
  conversationId: string;
  category: BeamCategory;
  questionIndex: number;
  question: string;
  rubric: string[];
  /** Best-effort reference answer (answer/ideal_response/... field), for humans. */
  goldAnswer?: string;
  generatedAnswer: string;
  /** Mean over rubric items (official `llm_judge_score`). */
  llmJudgeScore: number;
  rubricVerdicts: RubricItemVerdict[];
  /** Only for event_ordering questions. */
  ordering?: EventOrderingScore;
  judgeErrors: number;
  searchMs: number;
  answerMs: number;
  judgeMs: number;
  contextChars: number;
  contextTokens: number;
  memoriesUsed: number;
}

export interface ConversationResult {
  conversationId: string;
  questions: QuestionResult[];
  ingest: {
    batches: number;
    chunks: number;
    memoriesCreated: number;
    totalMs: number;
  };
  diagnostics: AdapterDiagnostics;
  usage: BenchmarkUsage;
}

export interface CategoryScore {
  n: number;
  /**
   * Official reporting score for the category (report_results.py):
   * mean `llm_judge_score` — except event_ordering, which reports mean `tau_norm`.
   */
  score: number;
  /** Mean llm_judge_score (= score for all categories but event_ordering). */
  meanLlmJudgeScore: number;
  /** event_ordering only: mean final_score (tau_norm * f1). */
  meanFinalScore?: number;
}

export interface RunSummary {
  conversations: number;
  totalQuestions: number;
  /**
   * Macro average of the ten per-category scores — how the BEAM paper / mem0
   * blog headline ("overall") is computed.
   */
  overallMacro: number;
  /** Mean over all questions (micro), using each category's reporting score. */
  overallMicro: number;
  byCategory: Record<string, CategoryScore>;
  judgeErrors: number;
  searchMsP50: number;
  searchMsP95: number;
  answerMsP50: number;
  answerMsP95: number;
  ingestTotalMs: number;
  batchesIngested: number;
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
  results: ConversationResult[];
  summary: RunSummary;
  usage: BenchmarkUsage;
}
