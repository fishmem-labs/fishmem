import { readFileSync } from "node:fs";
import { assertPublishableRun, compareEvalRuns } from "./compare.js";
import { normalizeEvalRuns } from "./normalize.js";
import type { EvalRun } from "./schema.js";

export type EvidenceGateResult = {
  publishable: boolean;
  comparisons: ReturnType<typeof compareEvalRuns>[];
  gaps: string[];
};

const REQUIRED_PORTFOLIO = [
  { prefix: "locomo", categories: ["1", "2", "3", "4"] },
  {
    prefix: "longmemeval:",
    categories: ["knowledge-update", "temporal-reasoning", "multi-session"],
  },
  {
    prefix: "beam:",
    categories: [
      "contradiction_resolution",
      "knowledge_update",
      "event_ordering",
      "abstention",
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
    const fishmem = matching.find((run) => run.system === "fishmem");
    const mem0 = matching.find((run) => run.system === "mem0");
    if (!fishmem || !mem0) {
      gaps.push(
        `${requirement.prefix}: same-harness fishmem and mem0 runs required`,
      );
      continue;
    }
    try {
      assertPublishableRun(fishmem);
      assertPublishableRun(mem0);
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
    const stateRuns = runs.filter(
      (run) =>
        run.system === "fishmem" &&
        run.config.derivationEnabled === true &&
        (run.dataset === "locomo" || run.dataset.startsWith("longmemeval:")),
    );
    if (stateRuns.length < 2) {
      gaps.push(
        "state/profile default requires derivation-enabled paired evidence on LOCOMO and LongMemEval",
      );
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
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.publishable) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) main();
