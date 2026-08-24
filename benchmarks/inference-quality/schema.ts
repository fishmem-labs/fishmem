import type { MemoryType, Message } from "../../packages/fishmem/src/index.js";

export const INFERENCE_QUALITY_SCHEMA_VERSION = 1 as const;
export const INFERENCE_QUALITY_DATASET_VERSION =
  "fishmem-selective-inference-v3" as const;

export type InferenceQualityCategory =
  | "durable-recall"
  | "mixed-signal"
  | "ephemeral"
  | "one-shot-request"
  | "role-attribution"
  | "memory-control"
  | "secret-safety"
  | "prompt-injection"
  | "deduplication";

export interface EvaluatedFact {
  text: string;
  memoryType: MemoryType;
  subject?: string;
  attribute?: string;
}

export interface FactMatcher {
  /** Every fragment must occur in the normalized fact text. */
  allText?: string[];
  /** At least one fragment must occur in the normalized fact text. */
  anyText?: string[];
  subject?: string;
  attribute?: string;
  memoryTypes?: MemoryType[];
}

export interface RequiredFact {
  match: FactMatcher;
  /** Deterministic valid output used only by the offline harness smoke. */
  oracle: {
    text: string;
    subject?: string;
    attribute?: string;
    type: MemoryType;
    cardinality?: "single" | "multi";
    event_date?: string | null;
  };
}

export interface InferenceQualityCase {
  id: string;
  category: InferenceQualityCategory;
  description: string;
  /** A leak in this case blocks release regardless of aggregate score. */
  critical?: boolean;
  messages: Message[];
  required: RequiredFact[];
  forbidden?: FactMatcher[];
  minFacts?: number;
  maxFacts: number;
}

export interface InferenceCaseResult {
  id: string;
  category: InferenceQualityCategory;
  critical: boolean;
  facts: EvaluatedFact[];
  requiredMatched: number;
  requiredTotal: number;
  forbiddenMatched: number;
  forbiddenTotal: number;
  countCompliant: boolean;
  passed: boolean;
  latencyMs: number;
  error?: string;
}

export interface InferenceQualitySummary {
  cases: number;
  passedCases: number;
  casePassRate: number;
  requiredMatched: number;
  requiredTotal: number;
  requiredRecall: number;
  forbiddenMatched: number;
  forbiddenTotal: number;
  forbiddenLeakRate: number;
  criticalLeakCount: number;
  countCompliantCases: number;
  countCompliance: number;
  noMemoryCases: number;
  noMemoryCorrect: number;
  noMemoryAccuracy: number;
  unwantedFacts: number;
  totalFacts: number;
  failedCases: number;
}

export interface InferencePromptRun {
  id: "baseline-exhaustive" | "selective-v1";
  promptSha256: string;
  cases: InferenceCaseResult[];
  summary: InferenceQualitySummary;
  usage: {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
  };
}

export interface InferenceQualityRun {
  schemaVersion: typeof INFERENCE_QUALITY_SCHEMA_VERSION;
  datasetVersion: typeof INFERENCE_QUALITY_DATASET_VERSION;
  mode: "smoke" | "live";
  provider: "mock" | "openai-compatible";
  model: string;
  createdAt: string;
  prompts: InferencePromptRun[];
}
