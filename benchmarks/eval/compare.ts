import type { EvalItemResult, EvalRun } from "./schema.js";

export interface EvalComparison {
  dataset: string;
  split: string;
  systemA: string;
  systemB: string;
  n: number;
  scoreA: number;
  scoreB: number;
  difference: number;
  ci95: { low: number; high: number };
  mcnemar?: { aOnly: number; bOnly: number; p: number };
}

const MAX_PROVIDER_FAILURE_RATE = 0.02;

export function compareEvalRuns(a: EvalRun, b: EvalRun): EvalComparison {
  assertComparable(a, b, true);
  return buildComparison(a, b);
}

export function compareEvalRunsDraft(a: EvalRun, b: EvalRun): EvalComparison {
  assertComparable(a, b, false);
  return buildComparison(a, b);
}

function buildComparison(a: EvalRun, b: EvalRun): EvalComparison {
  const bById = new Map(b.items.map((result) => [result.id, result]));
  const pairs = a.items.map((left) => ({ left, right: bById.get(left.id)! }));
  const differences = pairs.map(({ left, right }) => left.score - right.score);
  const binary = pairs.every(
    ({ left, right }) =>
      left.correct !== undefined && right.correct !== undefined,
  );
  return {
    dataset: a.dataset,
    split: a.split,
    systemA: a.system,
    systemB: b.system,
    n: pairs.length,
    scoreA: mean(pairs.map(({ left }) => left.score)),
    scoreB: mean(pairs.map(({ right }) => right.score)),
    difference: mean(differences),
    ci95: bootstrapMean(differences),
    ...(binary ? { mcnemar: mcnemar(pairs) } : {}),
  };
}

export function assertPublishableRun(run: EvalRun): void {
  if (run.split === "unspecified" || run.split === "smoke") {
    throw new Error(
      `${run.dataset}/${run.system} is not publishable: split=${run.split}`,
    );
  }
  if (run.items.length === 0) {
    throw new Error(`${run.dataset}/${run.system} has no eval items`);
  }
  if (run.summary.reliability.failedAdds !== 0) {
    throw new Error(
      `${run.dataset}/${run.system} has ${run.summary.reliability.failedAdds} failed adds`,
    );
  }
  if (run.summary.reliability.judgeErrors !== 0) {
    throw new Error(
      `${run.dataset}/${run.system} has ${run.summary.reliability.judgeErrors} judge errors`,
    );
  }
  const answerManifest = run.config.answerManifest;
  const answerManifestRecord =
    answerManifest !== null &&
    typeof answerManifest === "object" &&
    !Array.isArray(answerManifest)
      ? (answerManifest as Record<string, unknown>)
      : undefined;
  if (answerManifestRecord?.publishable === false) {
    throw new Error(
      `${run.dataset}/${run.system} answer provider is marked non-publishable`,
    );
  }
  const codexSubscriptionAnswer =
    answerManifestRecord?.provider === "codex-cli" &&
    answerManifestRecord.publishable === true &&
    answerManifestRecord.billing === "chatgpt-subscription" &&
    answerManifestRecord.transport === "codex-app-server";
  if (answerManifestRecord?.provider === "codex-cli") {
    const runtime = answerManifestRecord.runtime;
    const isolation = answerManifestRecord.isolation;
    if (
      !codexSubscriptionAnswer ||
      runtime === null ||
      typeof runtime !== "object" ||
      Array.isArray(runtime) ||
      typeof (runtime as Record<string, unknown>).codexCli !== "string" ||
      typeof (runtime as Record<string, unknown>).codexProviderPackage !==
        "string" ||
      typeof (runtime as Record<string, unknown>).instructionsSha256 !==
        "string" ||
      isolation === null ||
      typeof isolation !== "object" ||
      Array.isArray(isolation) ||
      (isolation as Record<string, unknown>).threadMode !== "stateless" ||
      (isolation as Record<string, unknown>).sandbox !== "read-only" ||
      (isolation as Record<string, unknown>).tools !== "disabled"
    ) {
      throw new Error(
        `${run.dataset}/${run.system} Codex answer manifest is not reproducible`,
      );
    }
  }
  const missing = [
    ["config.systemVersion", run.config.systemVersion],
    ["config.usageSchema", run.config.usageSchema],
    ["config.providerEndpoint", run.config.providerEndpoint],
    ["cost.llmCalls", run.summary.cost.llmCalls],
    ["cost.embeddingCalls", run.summary.cost.embeddingCalls],
    ["cost.inputTokens", run.summary.cost.inputTokens],
    ["cost.outputTokens", run.summary.cost.outputTokens],
    ["cost.estimatedUsd", run.summary.cost.estimatedUsd],
    ["cost.unscopedCalls", run.summary.cost.unscopedCalls],
    ["cost.unmeteredCalls", run.summary.cost.unmeteredCalls],
    ["cost.unpricedCalls", run.summary.cost.unpricedCalls],
    ["cost.failedCalls", run.summary.cost.failedCalls],
    ["cost.priceSnapshot", run.summary.cost.priceSnapshot],
    ["context.meanTokens", run.summary.context.meanTokens],
    ["context.tokenizer", run.summary.context.tokenizer],
    ["reliability.warningCounts", run.summary.reliability.warningCounts],
    ["reliability.retries", run.summary.reliability.retries],
    ["reliability.timeouts", run.summary.reliability.timeouts],
    ["reliability.degradationCount", run.summary.reliability.degradationCount],
  ]
    .filter(([, value]) => value === undefined)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `${run.dataset}/${run.system} missing required evidence metrics: ${missing.join(", ")}`,
    );
  }
  for (const [name, value] of [
    ["unscoped", run.summary.cost.unscopedCalls],
    ["unmetered", run.summary.cost.unmeteredCalls],
  ] as const) {
    if (value !== 0) {
      throw new Error(
        `${run.dataset}/${run.system} has ${value} ${name} provider calls`,
      );
    }
  }
  const unpricedCalls = run.summary.cost.unpricedCalls ?? 0;
  if (
    (codexSubscriptionAnswer && unpricedCalls !== run.items.length) ||
    (!codexSubscriptionAnswer && unpricedCalls !== 0)
  ) {
    throw new Error(
      `${run.dataset}/${run.system} has ${unpricedCalls} unpriced provider calls; expected ${codexSubscriptionAnswer ? `one Codex answer call per item (${run.items.length})` : "zero"}`,
    );
  }
  const successfulCalls =
    (run.summary.cost.llmCalls ?? 0) + (run.summary.cost.embeddingCalls ?? 0);
  const failedCalls = run.summary.cost.failedCalls ?? 0;
  const providerAttempts = successfulCalls + failedCalls;
  const failureRate = providerAttempts > 0 ? failedCalls / providerAttempts : 0;
  if (failureRate > MAX_PROVIDER_FAILURE_RATE) {
    throw new Error(
      `${run.dataset}/${run.system} has ${failedCalls} failed provider calls (${(failureRate * 100).toFixed(2)}% of attempts; maximum ${(MAX_PROVIDER_FAILURE_RATE * 100).toFixed(2)}%)`,
    );
  }
}

function assertComparable(a: EvalRun, b: EvalRun, publishable: boolean): void {
  if (publishable) {
    assertPublishableRun(a);
    assertPublishableRun(b);
  }
  if (a.dataset !== b.dataset || a.split !== b.split) {
    throw new Error(
      `incomparable eval runs: ${a.dataset}/${a.split} vs ${b.dataset}/${b.split}`,
    );
  }
  if (a.system === b.system) {
    throw new Error(`comparison requires different systems, got ${a.system}`);
  }
  if (
    JSON.stringify(a.summary.cost.priceSnapshot) !==
    JSON.stringify(b.summary.cost.priceSnapshot)
  ) {
    throw new Error("fairness config mismatch for provider price snapshot");
  }
  const idsA = a.items.map((result) => result.id).sort();
  const idsB = b.items.map((result) => result.id).sort();
  if (JSON.stringify(idsA) !== JSON.stringify(idsB)) {
    throw new Error(`item sets differ for ${a.dataset}/${a.split}`);
  }
  for (const key of [
    "topK",
    "chunkSize",
    "llm",
    "writeReasoning",
    "answerModel",
    "answerProvider",
    "answerReasoning",
    "answerManifest",
    "embedder",
    "judge",
    "variant",
    "categories",
    "types",
    "questionIds",
    "profileEvery",
    "maxSessions",
    "maxQuestions",
    "usageSchema",
    "providerTimeoutMs",
    "operationTimeoutMs",
    "operationRetries",
    "providerRetries",
    "questionRetries",
    "questionConcurrency",
    "perType",
    "concurrency",
    "providerEndpoint",
  ]) {
    const left = a.config[key];
    const right = b.config[key];
    if (
      left !== undefined &&
      right !== undefined &&
      JSON.stringify(left) !== JSON.stringify(right)
    ) {
      throw new Error(
        `fairness config mismatch for ${key}: ${left} vs ${right}`,
      );
    }
  }
}

function bootstrapMean(
  values: number[],
  samples = 10_000,
): {
  low: number;
  high: number;
} {
  if (!values.length) return { low: 0, high: 0 };
  const random = xorshift(0xf157e);
  const means: number[] = [];
  for (let sample = 0; sample < samples; sample++) {
    let total = 0;
    for (let index = 0; index < values.length; index++) {
      total += values[Math.floor(random() * values.length)]!;
    }
    means.push(total / values.length);
  }
  means.sort((left, right) => left - right);
  return {
    low: means[Math.floor(samples * 0.025)]!,
    high: means[Math.floor(samples * 0.975)]!,
  };
}

function mcnemar(
  pairs: Array<{ left: EvalItemResult; right: EvalItemResult }>,
): { aOnly: number; bOnly: number; p: number } {
  const aOnly = pairs.filter(
    ({ left, right }) => left.correct && !right.correct,
  ).length;
  const bOnly = pairs.filter(
    ({ left, right }) => !left.correct && right.correct,
  ).length;
  const discordant = aOnly + bOnly;
  if (discordant === 0) return { aOnly, bOnly, p: 1 };
  const tail = Math.min(aOnly, bOnly);
  let probability = 0;
  for (let index = 0; index <= tail; index++) {
    probability += Math.exp(
      logCombination(discordant, index) + discordant * Math.log(0.5),
    );
  }
  return { aOnly, bOnly, p: Math.min(1, probability * 2) };
}

function logCombination(n: number, k: number): number {
  let value = 0;
  for (let index = 0; index < k; index++) {
    value += Math.log(n - index) - Math.log(index + 1);
  }
  return value;
}

function xorshift(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0xffffffff;
  };
}

function mean(values: number[]): number {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}
