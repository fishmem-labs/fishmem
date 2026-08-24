import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ProcessAttemptEvidence } from "./attempt-ledger.js";
import {
  assertPublishableRun,
  compareEvalRuns,
  compareEvalRunsDraft,
} from "./compare.js";
import type { EvalRun } from "./schema.js";

export function renderScorecard(
  runs: EvalRun[],
  options: {
    draft?: boolean;
    sources?: Array<{ path: string; sha256: string }>;
    processAttempts?: ProcessAttemptEvidence[];
  } = {},
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
  if (options.sources?.length) {
    lines.push("Source result artifacts:", "");
    for (const source of options.sources) {
      lines.push(`- \`${source.path}\` — SHA-256 \`${source.sha256}\``);
    }
    lines.push("");
  }
  if (options.processAttempts?.length) {
    const incomplete = options.processAttempts.filter(
      (entry) => !entry.costAndWallTimeComplete,
    );
    lines.push("Process resume evidence:", "");
    for (const entry of options.processAttempts) {
      lines.push(
        `- \`${entry.ledgerPath}\` — SHA-256 \`${entry.sha256}\`; status \`${entry.status}\`; ${entry.attempts} attempt(s), ${entry.failed} failed, ${entry.interrupted + entry.recoveredInterruptions} interrupted/recovered, ${entry.incomplete} incomplete.`,
      );
    }
    if (incomplete.length > 0) {
      lines.push(
        "",
        "**Operational-metric warning:** quality rows reuse only durable completed units, but failed or interrupted process attempts mean total provider spend and end-to-end wall-clock time are incomplete. Do not publish cost or wall-clock claims from this scorecard; use a clean isolated performance run.",
      );
    }
    lines.push("");
  }
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
      `Configuration: write \`${configValue(fishmem.config.llm)}\` (reasoning \`${configValue(fishmem.config.writeReasoning)}\`); answer \`${configValue(fishmem.config.answerProvider)}:${configValue(fishmem.config.answerModel)}\` (reasoning \`${configValue(fishmem.config.answerReasoning)}\`); embedder \`${configValue(fishmem.config.embedder)}\`; judge \`${configValue(fishmem.config.judge)}\`; endpoint \`${configValue(fishmem.config.providerEndpoint)}\`; top-k \`${configValue(fishmem.config.topK)}\`; chunk size \`${configValue(fishmem.config.chunkSize)}\`.`,
      "",
      `Versions: fishmem \`${configValue(fishmem.config.systemVersion)}\`; mem0 \`${configValue(mem0.config.systemVersion)}\`.`,
      "",
    );
    if (isCodexSubscriptionAnswer(fishmem)) {
      lines.push(
        `Codex answer runtime: \`${configValue(fishmem.config.answerManifest)}\`. Estimated USD below covers metered API calls only; exactly one ChatGPT-subscription Codex answer call per item is excluded from USD cost and retained in call/token evidence.`,
        "",
      );
    }
    lines.push(
      "| system | n | quality | ingest | search p95 | context mean | LLM calls | embed calls | failed calls | metered API USD | degradations |",
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
    const standardLocomo = locomoStandardComparison(fishmem, mem0);
    if (standardLocomo) {
      lines.push(
        `LOCOMO standard categories 1–4: ${standardLocomo.n} paired questions; fishmem ${pct(standardLocomo.scoreA)}, mem0 ${pct(standardLocomo.scoreB)}, delta ${signedPct(standardLocomo.difference)} (95% bootstrap CI ${signedPct(standardLocomo.ci95.low)} to ${signedPct(standardLocomo.ci95.high)}). Category 5 remains visible below as a separate adversarial result.`,
        "",
      );
    }
    lines.push(
      "| category | n | fishmem | mem0 | paired delta |",
      "|---|---:|---:|---:|---:|",
    );
    for (const row of categoryRows(fishmem, mem0)) {
      lines.push(
        `| ${row.category} | ${row.n} | ${pct(row.fishmem)} | ${pct(row.mem0)} | ${signedPct(row.difference)} |`,
      );
    }
    lines.push("");
  }
  return `${lines.join("\n").trim()}\n`;
}

function isCodexSubscriptionAnswer(run: EvalRun): boolean {
  const manifest = run.config.answerManifest;
  return (
    manifest !== null &&
    typeof manifest === "object" &&
    !Array.isArray(manifest) &&
    (manifest as Record<string, unknown>).provider === "codex-cli" &&
    (manifest as Record<string, unknown>).billing === "chatgpt-subscription"
  );
}

function locomoStandardComparison(
  fishmem: EvalRun,
  mem0: EvalRun,
): ReturnType<typeof compareEvalRunsDraft> | undefined {
  if (!fishmem.dataset.startsWith("locomo")) return undefined;
  const standard = new Set(["1", "2", "3", "4"]);
  const leftItems = fishmem.items.filter((item) => standard.has(item.category));
  const rightItems = mem0.items.filter((item) => standard.has(item.category));
  if (!leftItems.length || leftItems.length === fishmem.items.length) {
    return undefined;
  }
  return compareEvalRunsDraft(
    { ...fishmem, items: leftItems },
    { ...mem0, items: rightItems },
  );
}

function categoryRows(
  fishmem: EvalRun,
  mem0: EvalRun,
): Array<{
  category: string;
  n: number;
  fishmem: number;
  mem0: number;
  difference: number;
}> {
  const rightById = new Map(mem0.items.map((item) => [item.id, item]));
  const categories = [
    ...new Set(fishmem.items.map((item) => item.category)),
  ].sort((left, right) =>
    left.localeCompare(right, undefined, { numeric: true }),
  );
  return categories.map((category) => {
    const pairs = fishmem.items
      .filter((item) => item.category === category)
      .map((left) => ({ left, right: rightById.get(left.id)! }));
    const fishmemScore = mean(pairs.map((pair) => pair.left.score));
    const mem0Score = mean(pairs.map((pair) => pair.right.score));
    return {
      category,
      n: pairs.length,
      fishmem: fishmemScore,
      mem0: mem0Score,
      difference: fishmemScore - mem0Score,
    };
  });
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

function configValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "default";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function mean(values: number[]): number {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}
