import type {
  EvalItemResult,
  EvalRun,
  EvalSplit,
  EvalSummary,
} from "./schema.js";

type ObjectValue = Record<string, unknown>;

export function normalizeEvalRuns(input: unknown): EvalRun[] {
  return normalizeRuns(input);
}

function normalizeRuns(input: unknown, benchmarkHint?: string): EvalRun[] {
  const run = object(input, "benchmark result");
  if (Array.isArray(run.systems)) {
    const systems = array(run.systems, "systems");
    if (
      systems.length > 0 &&
      systems.every((value) => isObject(value) && Array.isArray(value.results))
    ) {
      const benchmark = optionalText(run.benchmark);
      if (benchmark !== "longmemeval" && benchmark !== "beam") {
        throw new Error(
          'multi-system native result requires benchmark "longmemeval" or "beam"',
        );
      }
      return systems.flatMap((value) => normalizeRuns(value, benchmark));
    }
    return normalizeLocomo(run);
  }
  if (!Array.isArray(run.results)) {
    throw new Error("unknown benchmark result shape");
  }
  if (benchmarkHint === "longmemeval") return [normalizeLongMemEval(run)];
  if (benchmarkHint === "beam") return [normalizeBeam(run)];
  const first = run.results[0];
  if (isObject(first) && Array.isArray(first.questions)) {
    return [normalizeBeam(run)];
  }
  return [normalizeLongMemEval(run)];
}

function normalizeLocomo(run: ObjectValue): EvalRun[] {
  const config = optionalObject(run.config);
  const split = splitOf(config, run.dataset);
  return array(run.systems, "systems").map((value) => {
    const report = object(value, "LOCOMO system report");
    const ingest = optionalObject(report.ingest);
    const items = array(report.questions, "LOCOMO questions").map(
      (question, index) => {
        const q = object(question, `LOCOMO question ${index}`);
        const sampleId = text(q.sampleId, "sampleId");
        const category = String(q.category);
        const prompt = text(q.question, "question");
        const label = text(q.judgeLabel, "judgeLabel");
        if (label !== "CORRECT" && label !== "WRONG" && label !== "ERROR") {
          throw new Error(`invalid LOCOMO judge label "${label}"`);
        }
        return item({
          id: `${sampleId}:${optionalNumber(q.questionIndex, "questionIndex") ?? index}`,
          category,
          question: prompt,
          expected: optionalText(q.goldAnswer),
          answer: text(q.generatedAnswer, "generatedAnswer"),
          score: label === "CORRECT" ? 1 : 0,
          correct: label === "CORRECT",
          searchMs: number(q.searchMs, "searchMs"),
          answerMs: number(q.answerMs, "answerMs"),
          contextChars: number(q.contextChars, "contextChars"),
          contextTokens: optionalNumber(q.contextTokens, "contextTokens"),
          memoriesUsed: number(q.memoriesUsed, "memoriesUsed"),
          judgeErrors: label === "ERROR" ? 1 : 0,
        });
      },
    );
    return evalRun({
      dataset: "locomo",
      split,
      system: text(report.system, "system"),
      config: {
        ...config,
        ...(typeof report.systemVersion === "string"
          ? { systemVersion: report.systemVersion }
          : {}),
      },
      items,
      ingestMs: number(ingest.totalMs, "ingest.totalMs"),
      memoriesCreated: number(ingest.memoriesCreated, "ingest.memoriesCreated"),
      failedAdds: number(ingest.failedAdds, "ingest.failedAdds"),
      usage: optionalObject(report.usage),
      diagnostics: optionalObject(report.diagnostics),
    });
  });
}

function normalizeLongMemEval(run: ObjectValue): EvalRun {
  const config = optionalObject(run.config);
  const system = text(run.system, "system");
  assertSystemMatchesConfig(system, config);
  const items = array(run.results, "LongMemEval results").map(
    (value, index) => {
      const result = object(value, `LongMemEval result ${index}`);
      const label = text(result.judgeLabel, "judgeLabel");
      if (label !== "yes" && label !== "no" && label !== "ERROR") {
        throw new Error(`invalid LongMemEval judge label "${label}"`);
      }
      const ingest = optionalObject(result.ingest);
      return item({
        id: text(result.questionId, "questionId"),
        category: text(result.questionType, "questionType"),
        question: text(result.question, "question"),
        expected: optionalText(result.goldAnswer),
        answer: text(result.generatedAnswer, "generatedAnswer"),
        score: label === "yes" ? 1 : 0,
        correct: label === "yes",
        searchMs: number(result.searchMs, "searchMs"),
        answerMs: number(result.answerMs, "answerMs"),
        ingestMs: number(ingest.totalMs, "ingest.totalMs"),
        contextChars: number(result.contextChars, "contextChars"),
        contextTokens: optionalNumber(result.contextTokens, "contextTokens"),
        memoriesUsed: number(result.memoriesUsed, "memoriesUsed"),
        judgeErrors: label === "ERROR" ? 1 : 0,
      });
    },
  );
  const summary = optionalObject(run.summary);
  assertNativeCount(
    number(summary.total, "summary.total"),
    items.length,
    "LongMemEval",
  );
  return evalRun({
    dataset: `longmemeval:${text(config.variant, "config.variant")}`,
    split: splitOf(config, run.dataset),
    system,
    config,
    items,
    ingestMs: number(summary.ingestTotalMs, "summary.ingestTotalMs"),
    memoriesCreated: number(summary.memoriesCreated, "summary.memoriesCreated"),
    failedAdds: 0,
    usage: optionalObject(run.usage),
    diagnostics: optionalObject(summary.diagnostics),
  });
}

function normalizeBeam(run: ObjectValue): EvalRun {
  const config = optionalObject(run.config);
  const system = text(run.system, "system");
  assertSystemMatchesConfig(system, config);
  const items: EvalItemResult[] = [];
  for (const value of array(run.results, "BEAM results")) {
    const conversation = object(value, "BEAM conversation");
    const conversationId = text(conversation.conversationId, "conversationId");
    for (const question of array(conversation.questions, "BEAM questions")) {
      const q = object(question, "BEAM question");
      const category = text(q.category, "category");
      const ordering = optionalObject(q.ordering);
      const score =
        category === "event_ordering"
          ? number(ordering.tau_norm, "ordering.tau_norm")
          : number(q.llmJudgeScore, "llmJudgeScore");
      items.push(
        item({
          id: `${conversationId}:${category}:${number(q.questionIndex, "questionIndex")}`,
          category,
          question: text(q.question, "question"),
          expected: optionalText(q.goldAnswer),
          answer: text(q.generatedAnswer, "generatedAnswer"),
          score,
          searchMs: number(q.searchMs, "searchMs"),
          answerMs: number(q.answerMs, "answerMs"),
          contextChars: number(q.contextChars, "contextChars"),
          contextTokens: optionalNumber(q.contextTokens, "contextTokens"),
          memoriesUsed: number(q.memoriesUsed, "memoriesUsed"),
          judgeErrors: number(q.judgeErrors, "judgeErrors"),
        }),
      );
    }
  }
  const summary = optionalObject(run.summary);
  assertNativeCount(
    number(summary.totalQuestions, "summary.totalQuestions"),
    items.length,
    "BEAM",
  );
  return evalRun({
    dataset: `beam:${text(config.variant, "config.variant")}`,
    split: splitOf(config, run.dataset),
    system,
    config,
    items,
    ingestMs: number(summary.ingestTotalMs, "summary.ingestTotalMs"),
    memoriesCreated: number(summary.memoriesCreated, "summary.memoriesCreated"),
    failedAdds: 0,
    usage: optionalObject(run.usage),
    diagnostics: optionalObject(summary.diagnostics),
  });
}

function evalRun(input: {
  dataset: string;
  split: EvalSplit;
  system: string;
  config: ObjectValue;
  items: EvalItemResult[];
  ingestMs: number;
  memoriesCreated: number;
  failedAdds: number;
  usage: ObjectValue;
  diagnostics: ObjectValue;
}): EvalRun {
  ensureUniqueIds(input.items);
  return {
    dataset: input.dataset,
    split: input.split,
    system: input.system,
    config: input.config,
    items: input.items,
    summary: summarize(
      input.items,
      input.ingestMs,
      input.memoriesCreated,
      input.failedAdds,
      input.usage,
      input.diagnostics,
      input.config,
    ),
  };
}

function summarize(
  items: EvalItemResult[],
  ingestMs: number,
  memoriesCreated: number,
  failedAdds: number,
  usage: ObjectValue,
  diagnostics: ObjectValue,
  config: ObjectValue,
): EvalSummary {
  const tokenCounts = items.map((result) => result.contextTokens);
  const hasCompleteTokenCounts = tokenCounts.every(
    (value): value is number => value !== undefined,
  );
  const warningCounts = optionalNumberRecord(diagnostics.warningCounts);
  const retries = optionalNumber(diagnostics.retries, "diagnostics.retries");
  const timeouts = optionalNumber(diagnostics.timeouts, "diagnostics.timeouts");
  const providerFailures = optionalNumber(
    usage.failedCalls,
    "usage.failedCalls",
  );
  return {
    quality: { overall: mean(items.map((result) => result.score)) },
    cost: {
      ingestMs,
      memoriesCreated,
      llmCalls: optionalNumber(usage.llmCalls, "usage.llmCalls"),
      embeddingCalls: optionalNumber(
        usage.embeddingCalls,
        "usage.embeddingCalls",
      ),
      inputTokens: optionalNumber(usage.inputTokens, "usage.inputTokens"),
      outputTokens: optionalNumber(usage.outputTokens, "usage.outputTokens"),
      estimatedUsd: optionalNumber(usage.estimatedUsd, "usage.estimatedUsd"),
      unscopedCalls: optionalNumber(usage.unscopedCalls, "usage.unscopedCalls"),
      unmeteredCalls: optionalNumber(
        usage.unmeteredCalls,
        "usage.unmeteredCalls",
      ),
      unpricedCalls: optionalNumber(usage.unpricedCalls, "usage.unpricedCalls"),
      failedCalls: providerFailures,
      priceSnapshot: usage.priceSnapshot,
    },
    latency: {
      searchMsP50: percentile(
        items.map((result) => result.searchMs),
        50,
      ),
      searchMsP95: percentile(
        items.map((result) => result.searchMs),
        95,
      ),
      answerMsP50: percentile(
        items.map((result) => result.answerMs),
        50,
      ),
      answerMsP95: percentile(
        items.map((result) => result.answerMs),
        95,
      ),
    },
    context: {
      meanChars: mean(items.map((result) => result.contextChars)),
      meanTokens: hasCompleteTokenCounts ? mean(tokenCounts) : undefined,
      tokenizer:
        typeof config.contextTokenizer === "string"
          ? config.contextTokenizer
          : undefined,
    },
    reliability: {
      failedAdds,
      judgeErrors: items.reduce((sum, result) => sum + result.judgeErrors, 0),
      warningCounts,
      retries,
      timeouts,
      providerFailures,
      degradationCount:
        warningCounts &&
        retries !== undefined &&
        timeouts !== undefined &&
        providerFailures !== undefined
          ? Object.values(warningCounts).reduce(
              (sum, count) => sum + count,
              0,
            ) +
            retries +
            timeouts +
            providerFailures
          : undefined,
    },
  };
}

function item(value: EvalItemResult): EvalItemResult {
  if (!Number.isFinite(value.score) || value.score < 0 || value.score > 1) {
    throw new Error(`invalid eval score for ${value.id}: ${value.score}`);
  }
  return value;
}

function ensureUniqueIds(items: EvalItemResult[]): void {
  const ids = new Set<string>();
  for (const result of items) {
    if (ids.has(result.id))
      throw new Error(`duplicate eval item id: ${result.id}`);
    ids.add(result.id);
  }
}

function assertSystemMatchesConfig(system: string, config: ObjectValue): void {
  if (typeof config.system === "string" && config.system !== system) {
    throw new Error(
      `benchmark system mismatch: result=${system}, config=${config.system}`,
    );
  }
}

function assertNativeCount(native: number, actual: number, name: string): void {
  if (native !== 0 && native !== actual) {
    throw new Error(
      `${name} result count mismatch: summary=${native}, items=${actual}`,
    );
  }
}

function splitOf(config: ObjectValue, dataset: unknown): EvalSplit {
  if (config.smoke === true || String(dataset).includes("smoke"))
    return "smoke";
  if (
    config.split === "dev" ||
    config.split === "holdout" ||
    config.split === "full"
  ) {
    return config.split;
  }
  return "unspecified";
}

function mean(values: number[]): number {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil((p / 100) * sorted.length) - 1] ?? 0;
}

function object(value: unknown, label: string): ObjectValue {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  return value;
}

function optionalObject(value: unknown): ObjectValue {
  return isObject(value) ? value : {};
}

function isObject(value: unknown): value is ObjectValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalText(value: unknown): string | undefined {
  return value === undefined ? undefined : String(value);
}

function number(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function optionalNumber(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : number(value, label);
}

function optionalNumberRecord(
  value: unknown,
): Record<string, number> | undefined {
  if (value === undefined) return undefined;
  const record = object(value, "diagnostics.warningCounts");
  return Object.fromEntries(
    Object.entries(record).map(([key, count]) => [
      key,
      number(count, `diagnostics.warningCounts.${key}`),
    ]),
  );
}
