export type EvalSplit = "smoke" | "dev" | "holdout" | "full" | "unspecified";

export interface EvalItemResult {
  id: string;
  category: string;
  question: string;
  expected?: string;
  answer: string;
  score: number;
  correct?: boolean;
  searchMs: number;
  answerMs: number;
  ingestMs?: number;
  contextChars: number;
  contextTokens?: number;
  memoriesUsed: number;
  judgeErrors: number;
}

export interface EvalSummary {
  quality: {
    overall: number;
  };
  cost: {
    ingestMs: number;
    memoriesCreated: number;
    llmCalls?: number;
    embeddingCalls?: number;
    inputTokens?: number;
    outputTokens?: number;
    estimatedUsd?: number;
    unscopedCalls?: number;
    unmeteredCalls?: number;
    unpricedCalls?: number;
    failedCalls?: number;
    priceSnapshot?: unknown;
  };
  latency: {
    searchMsP50: number;
    searchMsP95: number;
    answerMsP50: number;
    answerMsP95: number;
  };
  context: {
    meanChars: number;
    meanTokens?: number;
    tokenizer?: string;
  };
  reliability: {
    failedAdds: number;
    judgeErrors: number;
    warningCounts?: Record<string, number>;
    retries?: number;
    timeouts?: number;
    providerFailures?: number;
    degradationCount?: number;
  };
}

export interface EvalRun {
  dataset: string;
  split: EvalSplit;
  system: string;
  config: Record<string, unknown>;
  items: EvalItemResult[];
  summary: EvalSummary;
}
