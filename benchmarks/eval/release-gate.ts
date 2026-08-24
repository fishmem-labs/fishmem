import { readFileSync } from "node:fs";
import { auditOperationalEvidence } from "./attempt-ledger.js";
import { assertPublishableRun, compareEvalRuns } from "./compare.js";
import { normalizeEvalRuns } from "./normalize.js";
import type { EvalRun } from "./schema.js";

export type EvidenceGateResult = {
  publishable: boolean;
  comparisons: ReturnType<typeof compareEvalRuns>[];
  gaps: string[];
};

const REQUIRED_PORTFOLIO = [
  {
    prefix: "locomo",
    minimumItems: 1_986,
    categories: ["1", "2", "3", "4", "5"],
  },
  {
    prefix: "longmemeval:",
    minimumItems: 500,
    categories: [
      "knowledge-update",
      "temporal-reasoning",
      "multi-session",
      "single-session-user",
      "single-session-assistant",
      "single-session-preference",
    ],
  },
  {
    prefix: "beam:",
    minimumItems: 400,
    categories: [
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
    ],
  },
] as const;

export function auditEvidencePortfolio(runs: EvalRun[]): EvidenceGateResult {
  const gaps: string[] = [];
  const comparisons: ReturnType<typeof compareEvalRuns>[] = [];

  for (const requirement of REQUIRED_PORTFOLIO) {
    const matching = runs.filter((run) =>
      run.dataset.startsWith(requirement.prefix),
    );
    const paired = matching
      .filter((run) => run.split === "full")
      .map((run) => run.dataset)
      .filter((dataset, index, datasets) => datasets.indexOf(dataset) === index)
      .map((dataset) => ({
        fishmem: matching.find(
          (run) =>
            run.dataset === dataset &&
            run.split === "full" &&
            run.system === "fishmem",
        ),
        mem0: matching.find(
          (run) =>
            run.dataset === dataset &&
            run.split === "full" &&
            run.system === "mem0",
        ),
      }))
      .filter(
        (pair): pair is { fishmem: EvalRun; mem0: EvalRun } =>
          pair.fishmem !== undefined && pair.mem0 !== undefined,
      )
      .sort(
        (left, right) =>
          Math.min(right.fishmem.items.length, right.mem0.items.length) -
          Math.min(left.fishmem.items.length, left.mem0.items.length),
      )[0];
    const fishmem = paired?.fishmem;
    const mem0 = paired?.mem0;
    if (!fishmem || !mem0) {
      gaps.push(
        `${requirement.prefix}: same-harness fishmem and mem0 full-split runs required`,
      );
      continue;
    }
    try {
      assertPublishableRun(fishmem);
      assertPublishableRun(mem0);
      if (
        fishmem.items.length < requirement.minimumItems ||
        mem0.items.length < requirement.minimumItems
      ) {
        gaps.push(
          `${fishmem.dataset}: homepage evidence requires at least ${requirement.minimumItems.toLocaleString("en-US")} paired items (fishmem=${fishmem.items.length}, mem0=${mem0.items.length})`,
        );
      }
      const categories = new Set(fishmem.items.map((item) => item.category));
      for (const category of requirement.categories) {
        if (!categories.has(category)) {
          gaps.push(
            `${fishmem.dataset}: missing required category ${category}`,
          );
        }
      }
      comparisons.push(compareEvalRuns(fishmem, mem0));
    } catch (error) {
      gaps.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (comparisons.length === REQUIRED_PORTFOLIO.length) {
    const qualityWins = comparisons.filter(
      (comparison) => comparison.difference > 0 && comparison.ci95.low >= 0,
    ).length;
    if (qualityWins < 2) {
      gaps.push(
        "fishmem must have non-negative paired confidence bounds and positive quality deltas on at least two required datasets",
      );
    }
    const claimsStateProfileDefault = runs.some(
      (run) =>
        run.system === "fishmem" && run.config.derivationEnabled === true,
    );
    if (claimsStateProfileDefault) {
      const stateDatasets = new Set(
        runs
          .filter(
            (run) =>
              run.system === "fishmem" &&
              run.config.derivationEnabled === true &&
              (run.dataset === "locomo" ||
                run.dataset.startsWith("longmemeval:")),
          )
          .map((run) =>
            run.dataset.startsWith("longmemeval:") ? "longmemeval" : "locomo",
          ),
      );
      if (stateDatasets.size < 2) {
        gaps.push(
          "state/profile default claim requires derivation-enabled paired evidence on LOCOMO and LongMemEval",
        );
      }
    }
  }

  return { publishable: gaps.length === 0, comparisons, gaps };
}

export function resultPathsFromArgs(args: string[]): string[] {
  return args.filter((arg) => arg !== "--");
}

function main() {
  const paths = resultPathsFromArgs(process.argv.slice(2));
  if (paths.length === 0) {
    throw new Error(
      "usage: tsx benchmarks/eval/release-gate.ts <result.json...>",
    );
  }
  const runs = paths.flatMap((path) =>
    normalizeEvalRuns(JSON.parse(readFileSync(path, "utf8"))),
  );
  const result = auditEvidencePortfolio(runs);
  const operational = auditOperationalEvidence(paths);
  process.stdout.write(
    `${JSON.stringify(
      {
        ...result,
        operationalMetricsPublishable: operational.publishable,
        operationalGaps: operational.gaps,
        processAttempts: operational.attempts,
      },
      null,
      2,
    )}\n`,
  );
  if (!result.publishable) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) main();
