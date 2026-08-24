import { describe, expect, it } from "vitest";
import {
  EXHAUSTIVE_FACT_EXTRACTION_SYSTEM,
  FACT_EXTRACTION_SYSTEM,
  SELECTIVE_FACT_EXTRACTION_SYSTEM,
} from "../../packages/fishmem/src/index.js";
import { INFERENCE_QUALITY_CASES } from "../inference-quality/cases.js";
import {
  evaluateInferenceCase,
  matchesFact,
  summarizeInferenceQuality,
} from "../inference-quality/evaluate.js";
import { gateInferenceQuality } from "../inference-quality/gate.js";
import {
  type EvaluatedFact,
  INFERENCE_QUALITY_DATASET_VERSION,
  INFERENCE_QUALITY_SCHEMA_VERSION,
  type InferenceCaseResult,
  type InferencePromptRun,
  type InferenceQualityCase,
  type InferenceQualityRun,
} from "../inference-quality/schema.js";
import { countContextTokens } from "../tokens.js";

describe("selective inference scorer", () => {
  it("keeps the revised one-call candidate within its disclosed token budget", () => {
    expect(countContextTokens(EXHAUSTIVE_FACT_EXTRACTION_SYSTEM)).toBe(1_031);
    expect(
      countContextTokens(SELECTIVE_FACT_EXTRACTION_SYSTEM),
    ).toBeLessThanOrEqual(1_450);
    expect(FACT_EXTRACTION_SYSTEM).toBe(SELECTIVE_FACT_EXTRACTION_SYSTEM);
  });

  it("matches normalized text and structured fields", () => {
    const fact: EvaluatedFact = {
      text: "Maya Chen uses PNPM in Atlas",
      memoryType: "decision",
      subject: "Atlas",
      attribute: "package_manager",
    };
    expect(
      matchesFact(
        {
          allText: ["maya chen", "pnpm"],
          subject: "atlas",
          attribute: "PACKAGE_MANAGER",
          memoryTypes: ["decision"],
        },
        fact,
      ),
    ).toBe(true);
    expect(matchesFact({ anyText: ["npm", "yarn"] }, fact)).toBe(false);
  });

  it("does not let one broad fact satisfy two required facts", () => {
    const testCase: InferenceQualityCase = {
      id: "maximum-match",
      category: "durable-recall",
      description: "matching contract",
      messages: [],
      required: [
        {
          match: { allText: ["dark mode"] },
          oracle: { text: "Dark mode A", type: "preference" },
        },
        {
          match: { allText: ["dark mode"] },
          oracle: { text: "Dark mode B", type: "preference" },
        },
      ],
      maxFacts: 2,
    };
    const result = evaluateInferenceCase({
      testCase,
      facts: [{ text: "The user prefers dark mode", memoryType: "preference" }],
      latencyMs: 1,
    });
    expect(result.requiredMatched).toBe(1);
    expect(result.passed).toBe(false);
  });

  it("counts any persisted fact in a critical no-memory case as a leak", () => {
    const testCase = INFERENCE_QUALITY_CASES.find(
      (candidate) => candidate.id === "credential-must-never-be-memory",
    )!;
    const result = evaluateInferenceCase({
      testCase,
      facts: [
        {
          text: "The user supplied an API key",
          memoryType: "observation",
        },
      ],
      latencyMs: 1,
    });
    const summary = summarizeInferenceQuality([testCase], [result]);
    expect(result.passed).toBe(false);
    expect(summary.criticalLeakCount).toBe(1);
    expect(summary.noMemoryAccuracy).toBe(0);
    expect(summary.unwantedFacts).toBe(1);
  });

  it("keeps an unaccepted assistant recommendation out of canonical facts", () => {
    const testCase = INFERENCE_QUALITY_CASES.find(
      (candidate) => candidate.id === "unconfirmed-assistant-suggestion",
    )!;
    const episodicOnly = evaluateInferenceCase({
      testCase,
      facts: [],
      latencyMs: 1,
    });
    expect(episodicOnly.passed).toBe(true);

    const promotedRecommendation = evaluateInferenceCase({
      testCase,
      facts: [
        {
          text: "The assistant recommended that Atlas migrate its cache to Redis.",
          memoryType: "fact",
          subject: "assistant",
        },
      ],
      latencyMs: 1,
    });
    expect(promotedRecommendation.passed).toBe(false);

    const falseDecision = evaluateInferenceCase({
      testCase,
      facts: [
        {
          text: "The user accepted Redis as Atlas's cache backend.",
          memoryType: "decision",
          subject: "user",
        },
      ],
      latencyMs: 1,
    });
    expect(falseDecision.passed).toBe(false);
    expect(falseDecision.forbiddenMatched).toBe(1);
  });
});

describe("selective inference release gate", () => {
  it("rejects smoke output even when every oracle case passes", () => {
    const run = qualityRun("smoke", false);
    expect(gateInferenceQuality(run)).toEqual({
      publishable: false,
      gaps: [
        "a live same-model A/B run is required; smoke output is not evidence",
        "candidate must reduce unwanted facts or improve no-memory accuracy over baseline",
      ],
    });
  });

  it("accepts a complete live candidate that removes a baseline unwanted fact without recall loss", () => {
    const result = gateInferenceQuality(qualityRun("live", true));
    expect(result).toEqual({ publishable: true, gaps: [] });
  });
});

function oracleResults(): InferenceCaseResult[] {
  return INFERENCE_QUALITY_CASES.map((testCase) =>
    evaluateInferenceCase({
      testCase,
      facts: testCase.required.map((required) => ({
        text: required.oracle.text,
        memoryType: required.oracle.type,
        ...(required.oracle.subject
          ? { subject: required.oracle.subject }
          : {}),
        ...(required.oracle.attribute
          ? { attribute: required.oracle.attribute }
          : {}),
      })),
      latencyMs: 1,
    }),
  );
}

function promptRun(
  id: InferencePromptRun["id"],
  results: InferenceCaseResult[],
): InferencePromptRun {
  return {
    id,
    promptSha256: (id === "baseline-exhaustive" ? "0" : "1").repeat(64),
    cases: results,
    summary: summarizeInferenceQuality(INFERENCE_QUALITY_CASES, results),
    usage: {
      calls: results.length,
      inputTokens: 1,
      outputTokens: 1,
      latencyMs: 1,
    },
  };
}

function qualityRun(
  mode: InferenceQualityRun["mode"],
  baselineHasLeak: boolean,
): InferenceQualityRun {
  const candidate = oracleResults();
  const baseline = oracleResults();
  if (baselineHasLeak) {
    const testCase = INFERENCE_QUALITY_CASES.find(
      (candidateCase) => candidateCase.id === "ephemeral-small-talk",
    )!;
    const index = baseline.findIndex((result) => result.id === testCase.id);
    baseline[index] = evaluateInferenceCase({
      testCase,
      facts: [{ text: "The user is tired today", memoryType: "observation" }],
      latencyMs: 1,
    });
  }
  return {
    schemaVersion: INFERENCE_QUALITY_SCHEMA_VERSION,
    datasetVersion: INFERENCE_QUALITY_DATASET_VERSION,
    mode,
    provider: mode === "smoke" ? "mock" : "openai-compatible",
    model: mode === "smoke" ? "mock" : "test-model",
    createdAt: "2026-08-01T00:00:00.000Z",
    prompts: [
      promptRun("baseline-exhaustive", baseline),
      promptRun("selective-v1", candidate),
    ],
  };
}
