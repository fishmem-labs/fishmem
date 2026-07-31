import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  assertPublishableRun,
  compareEvalRuns,
  compareEvalRunsDraft,
} from "./compare.js";
import type { EvalRun } from "./schema.js";

export function renderScorecard(
  runs: EvalRun[],
  options: { draft?: boolean } = {},
): string {
  const groups = new Map<string, EvalRun[]>();
  for (const run of runs) {
    const key = `${run.dataset}\u0000${run.split}`;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  const lines = [
    `# fishmem evaluation scorecard${options.draft ? " (DRAFT - NOT PUBLISHABLE)" : ""}`,
    "",
    options.draft
      ? "Exploratory paired results. This stage report has not passed the complete portfolio release gate; do not use these numbers as benchmark claims."
      : "All rows use paired items and identical disclosed fairness configuration.",
    "",
  ];
  for (const group of groups.values()) {
    const fishmemRuns = group.filter((run) => run.system.startsWith("fishmem"));
    const mem0Runs = group.filter((run) => run.system.startsWith("mem0"));
    if (fishmemRuns.length !== 1 || mem0Runs.length !== 1) {
      throw new Error(
        `${group[0]?.dataset}/${group[0]?.split} requires exactly one fishmem and one mem0 run`,
      );
    }
    const fishmem = fishmemRuns[0]!;
    const mem0 = mem0Runs[0]!;
    const comparison = options.draft
      ? compareEvalRunsDraft(fishmem, mem0)
      : compareEvalRuns(fishmem, mem0);
    lines.push(`## ${comparison.dataset} (${comparison.split})`, "");
    if (options.draft) {
      const issues = [fishmem, mem0]
        .map((run) => publishabilityIssue(run))
        .filter((issue): issue is string => issue !== undefined);
      lines.push("Run-level publication checks:", "");
      lines.push(
        ...(issues.length > 0
          ? issues.map((issue) => `- ${issue}`)
          : [
              "- Passed; complete portfolio coverage and release gate are still required.",
            ]),
        "",
      );
    }
    lines.push(
      "| system | n | quality | ingest | search p95 | context mean | LLM calls | embed calls | failed calls | est. USD | degradations |",
      "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    );
    for (const run of [fishmem, mem0]) {
      lines.push(
        `| ${run.system} | ${run.items.length} | ${pct(run.summary.quality.overall)} | ${seconds(run.summary.cost.ingestMs)} | ${ms(run.summary.latency.searchMsP95)} | ${Math.round(run.summary.context.meanTokens ?? 0)} tok | ${run.summary.cost.llmCalls ?? "n/a"} | ${run.summary.cost.embeddingCalls ?? "n/a"} | ${run.summary.cost.failedCalls ?? "n/a"} | ${usd(run.summary.cost.estimatedUsd)} | ${run.summary.reliability.degradationCount ?? "n/a"} |`,
      );
    }
    lines.push(
      "",
      `Paired quality delta: ${signedPct(comparison.difference)} (95% bootstrap CI ${signedPct(comparison.ci95.low)} to ${signedPct(comparison.ci95.high)})${comparison.mcnemar ? `; McNemar p=${comparison.mcnemar.p.toFixed(4)} (${comparison.mcnemar.aOnly}/${comparison.mcnemar.bOnly} discordant)` : ""}.`,
      "",
    );
  }
  return `${lines.join("\n").trim()}\n`;
}

function publishabilityIssue(run: EvalRun): string | undefined {
  try {
    assertPublishableRun(run);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function writeScorecard(path: string, report: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, report);
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function signedPct(value: number): string {
  const points = value * 100;
  return `${points >= 0 ? "+" : ""}${points.toFixed(1)} pt`;
}

function ms(value: number): string {
  return `${Math.round(value)} ms`;
}

function seconds(value: number): string {
  return `${(value / 1000).toFixed(1)} s`;
}

function usd(value: number | undefined): string {
  return value === undefined ? "n/a" : `$${value.toFixed(4)}`;
}
