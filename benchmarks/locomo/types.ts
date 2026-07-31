import type { BenchmarkUsage } from "../usage.js";
import type { AdapterDiagnostics } from "./adapters.js";

/** LOCOMO dataset shapes (snap-research/locomo, data/locomo10.json). */

export interface LocomoTurn {
  speaker: string;
  dia_id: string;
  text?: string;
  img_url?: string[] | string;
  blip_caption?: string;
}

export interface LocomoQA {
  question: string;
  answer?: string | number;
  adversarial_answer?: string;
  evidence?: string[];
  category: number; // 1 multi-hop, 2 temporal, 3 open-domain, 4 single-hop, 5 adversarial
}

export interface LocomoConversation {
  speaker_a: string;
  speaker_b: string;
  /** session_N and session_N_date_time keys, N = 1.. */
  [key: string]: unknown;
}

export interface LocomoSample {
  sample_id: string;
  qa: LocomoQA[];
  conversation: LocomoConversation;
}

export interface Session {
  index: number;
  dateTime: string;
  turns: LocomoTurn[];
}

// ── Benchmark result shapes ──────────────────────────────────────────────────

export interface QuestionResult {
  /** Per-source retrieval trace (present when the run used --trace). */
  trace?: unknown;
  sampleId: string;
  /** Zero-based position in the source sample's qa array. */
  questionIndex: number;
  question: string;
  goldAnswer: string;
  category: number;
  generatedAnswer: string;
  judgeLabel: "CORRECT" | "WRONG" | "ERROR";
  f1: number;
  bleu1: number;
  searchMs: number;
  answerMs: number;
  contextChars: number;
  contextTokens: number;
  memoriesUsed: number;
}

export interface SystemReport {
  system: string;
  systemVersion: string;
  diagnostics: AdapterDiagnostics;
  usage: BenchmarkUsage;
  models: { llm: string; embedder: string };
  ingest: {
    conversations: number;
    sessions: number;
    chunks: number;
    memoriesCreated: number;
    /** Chunks whose add() failed every retry — memories silently lost. A
     * non-zero value means the run is NOT clean (asymmetric memory loss). */
    failedAdds: number;
    totalMs: number;
    chunkMsP50: number;
    chunkMsP95: number;
  };
  questions: QuestionResult[];
  summary: {
    total: number;
    judgeAccuracy: number;
    judgeAccuracyByCategory: Record<string, { n: number; accuracy: number }>;
    meanF1: number;
    meanBleu1: number;
    searchMsP50: number;
    searchMsP95: number;
    answerMsP50: number;
    answerMsP95: number;
    meanContextChars: number;
    meanContextTokens: number;
  };
}

export interface BenchmarkRun {
  startedAt: string;
  dataset: string;
  config: Record<string, unknown>;
  systems: SystemReport[];
}
