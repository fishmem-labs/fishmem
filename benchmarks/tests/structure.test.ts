import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeEvalRuns } from "../eval/normalize.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

describe("benchmark structure contract", () => {
  it("keeps every supported runner and the shared evidence modules", () => {
    const required = [
      "benchmarks/locomo/run.ts",
      "benchmarks/longmemeval/run.ts",
      "benchmarks/beam/run.ts",
      "benchmarks/recall/membench.ts",
      "benchmarks/recall/convomem.ts",
      "benchmarks/inference-quality/run.ts",
      "benchmarks/inference-quality/gate.ts",
      "benchmarks/inference-quality/cases.ts",
      "benchmarks/eval/schema.ts",
      "benchmarks/eval/normalize.ts",
      "benchmarks/eval/compare.ts",
      "benchmarks/eval/report.ts",
      "benchmarks/eval/release-gate.ts",
      "benchmarks/experiments/state-profile-v1.json",
      "benchmarks/checkpoint.ts",
      "benchmarks/result-cache.ts",
      "benchmarks/tokens.ts",
      "benchmarks/usage.ts",
      "benchmarks/progress.ts",
      "benchmarks/resume-run.ts",
      "benchmarks/atomic-file.ts",
      "benchmarks/sampling.ts",
      "benchmarks/cli.ts",
    ];
    expect(required.filter((path) => !existsSync(join(ROOT, path)))).toEqual(
      [],
    );
  });

  it("keeps every runner addressable through the root package", () => {
    const manifest = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    expect(manifest.scripts).toMatchObject({
      "bench:locomo": "tsx benchmarks/locomo/run.ts",
      "bench:longmemeval": "tsx benchmarks/longmemeval/run.ts",
      "bench:beam": "tsx benchmarks/beam/run.ts",
      "bench:membench": "tsx benchmarks/recall/membench.ts",
      "bench:convomem": "tsx benchmarks/recall/convomem.ts",
      "bench:inference": "tsx benchmarks/inference-quality/run.ts",
      "bench:inference:gate": "tsx benchmarks/inference-quality/gate.ts",
      "bench:report": "tsx benchmarks/eval/report.ts",
      "bench:gate": "tsx benchmarks/eval/release-gate.ts",
      "bench:resume": "tsx benchmarks/resume-run.ts",
      "bench:test": expect.any(String),
      "bench:typecheck": expect.any(String),
    });
  });

  it("keeps LOCOMO answers durable at question granularity", () => {
    const runner = readFileSync(join(ROOT, "benchmarks/locomo/run.ts"), "utf8");
    expect(runner).toContain("openCheckpoint<QuestionCheckpoint>");
    expect(runner).toContain(["`", "$", "{OUT}.questions", "`"].join(""));
    expect(runner).toContain("questionCp.record");
    expect(runner).toContain("locomo-question-attempts-v1");
    expect(runner).toContain("questionRetries: QUESTION_RETRIES");
    expect(runner).toContain("questionConcurrency: QUESTION_CONCURRENCY");
    expect(runner).toContain("mapWithConcurrency(");
  });

  it("keeps every offline benchmark smoke in CI", () => {
    const workflow = readFileSync(
      join(ROOT, ".github/workflows/ci.yml"),
      "utf8",
    );
    for (const command of [
      "pnpm bench:locomo -- --smoke",
      "pnpm bench:longmemeval -- --smoke",
      "pnpm bench:beam -- --smoke",
      "pnpm bench:inference -- --smoke",
    ]) {
      expect(workflow).toContain(command);
    }
  });

  it("keeps the inference A/B provider budget bounded without retries", () => {
    const runner = readFileSync(
      join(ROOT, "benchmarks/inference-quality/run.ts"),
      "utf8",
    );
    expect(runner).toContain("maxRetries: 0");
  });

  it("keeps browser and Cloudflare release gates in CI", () => {
    const workflow = readFileSync(
      join(ROOT, ".github/workflows/ci.yml"),
      "utf8",
    );
    expect(workflow).toContain("pnpm --filter @fishmem/web test:e2e");
    expect(workflow).toContain("pnpm --filter @fishmem/web build:prod");
  });

  it.each([
    ["locomo", locomoFixture(), "locomo", "conversation:0"],
    ["longmemeval", longMemEvalFixture(), "longmemeval:oracle", "lme-q1"],
    ["beam", beamFixture(), "beam:100k", "beam-c1:abstention:0"],
  ])("preserves the %s native result contract", (_, fixture, dataset, itemId) => {
    const [run] = normalizeEvalRuns(fixture);
    expect(run).toMatchObject({
      dataset,
      split: "holdout",
      system: "fishmem",
      config: {
        systemVersion: "fishmem-src:test+adapter:test",
        contextTokenizer: "o200k_base",
      },
      items: [{ id: itemId, contextTokens: 5 }],
      summary: {
        context: { meanTokens: 5, tokenizer: "o200k_base" },
        reliability: {
          failedAdds: 0,
          judgeErrors: 0,
          warningCounts: {},
          retries: 0,
          timeouts: 0,
        },
      },
    });
  });
});

const config = {
  split: "holdout",
  system: "fishmem",
  systemVersion: "fishmem-src:test+adapter:test",
  contextTokenizer: "o200k_base",
};

const diagnostics = { warningCounts: {}, retries: 0, timeouts: 0 };

function locomoFixture() {
  return {
    dataset: "locomo10.json",
    config,
    systems: [
      {
        system: "fishmem",
        systemVersion: config.systemVersion,
        ingest: { failedAdds: 0, totalMs: 10, memoriesCreated: 1 },
        diagnostics,
        questions: [
          {
            sampleId: "conversation",
            category: "q1",
            question: "Question",
            goldAnswer: "Answer",
            generatedAnswer: "Answer",
            judgeLabel: "CORRECT",
            searchMs: 1,
            answerMs: 2,
            contextChars: 20,
            contextTokens: 5,
            memoriesUsed: 1,
          },
        ],
      },
    ],
  };
}

function longMemEvalFixture() {
  return {
    dataset: "longmemeval_oracle.json",
    system: "fishmem",
    config: { ...config, variant: "oracle" },
    results: [
      {
        questionId: "lme-q1",
        questionType: "knowledge-update",
        question: "Question",
        goldAnswer: "Answer",
        generatedAnswer: "Answer",
        judgeLabel: "yes",
        ingest: { totalMs: 10 },
        searchMs: 1,
        answerMs: 2,
        contextChars: 20,
        contextTokens: 5,
        memoriesUsed: 1,
      },
    ],
    summary: {
      total: 1,
      ingestTotalMs: 10,
      memoriesCreated: 1,
      diagnostics,
    },
  };
}

function beamFixture() {
  return {
    dataset: "beam-100k",
    system: "fishmem",
    config: { ...config, variant: "100k" },
    results: [
      {
        conversationId: "beam-c1",
        questions: [
          {
            category: "abstention",
            questionIndex: 0,
            question: "Question",
            goldAnswer: "Answer",
            generatedAnswer: "Answer",
            llmJudgeScore: 1,
            searchMs: 1,
            answerMs: 2,
            contextChars: 20,
            contextTokens: 5,
            memoriesUsed: 1,
            judgeErrors: 0,
          },
        ],
      },
    ],
    summary: {
      totalQuestions: 1,
      ingestTotalMs: 10,
      memoriesCreated: 1,
      diagnostics,
    },
  };
}
