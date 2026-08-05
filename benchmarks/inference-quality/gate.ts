import { readFileSync } from "node:fs";
import { INFERENCE_QUALITY_CASES } from "./cases.js";
import type { InferencePromptRun, InferenceQualityRun } from "./schema.js";
import {
  INFERENCE_QUALITY_DATASET_VERSION,
  INFERENCE_QUALITY_SCHEMA_VERSION,
} from "./schema.js";

export interface InferenceQualityGateResult {
  publishable: boolean;
  gaps: string[];
}

function prompt(run: InferenceQualityRun, id: InferencePromptRun["id"]) {
  return run.prompts.find((candidate) => candidate.id === id);
}

export function gateInferenceQuality(
  run: InferenceQualityRun,
): InferenceQualityGateResult {
  const gaps: string[] = [];
  if (run.schemaVersion !== INFERENCE_QUALITY_SCHEMA_VERSION) {
    gaps.push(`unsupported schema version ${run.schemaVersion}`);
  }
  if (run.datasetVersion !== INFERENCE_QUALITY_DATASET_VERSION) {
    gaps.push(`unsupported dataset version ${run.datasetVersion}`);
  }
  if (run.mode !== "live") {
    gaps.push(
      "a live same-model A/B run is required; smoke output is not evidence",
    );
  } else if (run.provider !== "openai-compatible") {
    gaps.push("a live run must use an explicitly metered provider");
  }
  const baseline = prompt(run, "baseline-exhaustive");
  const candidate = prompt(run, "selective-v1");
  if (!baseline || !candidate) {
    gaps.push(
      "baseline-exhaustive and selective-v1 prompt runs are both required",
    );
    return { publishable: false, gaps };
  }
  if (baseline.promptSha256 === candidate.promptSha256) {
    gaps.push("baseline and candidate prompt hashes must differ");
  }
  if (baseline.cases.length !== candidate.cases.length) {
    gaps.push("baseline and candidate must evaluate the same number of cases");
  }
  if (
    baseline.cases.length !== INFERENCE_QUALITY_CASES.length ||
    candidate.cases.length !== INFERENCE_QUALITY_CASES.length
  ) {
    gaps.push(
      `the complete ${INFERENCE_QUALITY_CASES.length}-case dataset is required`,
    );
  }
  const baselineIds = baseline.cases.map((item) => item.id).sort();
  const candidateIds = candidate.cases.map((item) => item.id).sort();
  if (JSON.stringify(baselineIds) !== JSON.stringify(candidateIds)) {
    gaps.push("baseline and candidate must evaluate the same case IDs");
  }

  if (candidate.summary.failedCases !== 0) {
    gaps.push(`candidate has ${candidate.summary.failedCases} failed cases`);
  }
  if (candidate.summary.criticalLeakCount !== 0) {
    gaps.push(
      `candidate has ${candidate.summary.criticalLeakCount} critical memory-control or secret leaks`,
    );
  }
  if (candidate.summary.forbiddenMatched !== 0) {
    gaps.push(
      `candidate emitted ${candidate.summary.forbiddenMatched} explicitly forbidden facts`,
    );
  }
  if (candidate.summary.requiredRecall < 0.9) {
    gaps.push(
      `candidate required recall ${candidate.summary.requiredRecall.toFixed(3)} is below 0.900`,
    );
  }
  if (candidate.summary.noMemoryAccuracy < 0.9) {
    gaps.push(
      `candidate no-memory accuracy ${candidate.summary.noMemoryAccuracy.toFixed(3)} is below 0.900`,
    );
  }
  if (candidate.summary.countCompliance < 0.9) {
    gaps.push(
      `candidate count compliance ${candidate.summary.countCompliance.toFixed(3)} is below 0.900`,
    );
  }
  if (candidate.summary.casePassRate < 0.8) {
    gaps.push(
      `candidate case pass rate ${candidate.summary.casePassRate.toFixed(3)} is below 0.800`,
    );
  }
  if (
    candidate.summary.requiredRecall + 0.02 <
    baseline.summary.requiredRecall
  ) {
    gaps.push(
      "candidate required recall regresses baseline by more than 0.020",
    );
  }
  if (
    candidate.summary.criticalLeakCount > baseline.summary.criticalLeakCount
  ) {
    gaps.push("candidate introduces more critical leaks than baseline");
  }
  if (
    candidate.summary.unwantedFacts >= baseline.summary.unwantedFacts &&
    candidate.summary.noMemoryAccuracy <= baseline.summary.noMemoryAccuracy
  ) {
    gaps.push(
      "candidate must reduce unwanted facts or improve no-memory accuracy over baseline",
    );
  }
  for (const promptRun of [baseline, candidate]) {
    if (promptRun.usage.calls !== INFERENCE_QUALITY_CASES.length) {
      gaps.push(
        `${promptRun.id} must record exactly ${INFERENCE_QUALITY_CASES.length} provider calls`,
      );
    }
    if (run.mode === "live" && promptRun.usage.inputTokens <= 0) {
      gaps.push(`${promptRun.id} is missing metered input tokens`);
    }
  }

  return { publishable: gaps.length === 0, gaps };
}

function main() {
  const path = process.argv.slice(2).find((argument) => argument !== "--");
  if (!path) {
    throw new Error(
      "usage: tsx benchmarks/inference-quality/gate.ts <result.json>",
    );
  }
  const run = JSON.parse(readFileSync(path, "utf8")) as InferenceQualityRun;
  const result = gateInferenceQuality(run);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.publishable) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) main();
