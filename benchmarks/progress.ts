import { writeFileAtomic } from "./atomic-file.js";

export interface BenchmarkProgressSystem {
  system: string;
  completed: number;
  total: number;
  quality: number | null;
  ingestMs: number;
  llmCalls: number;
  embeddingCalls: number;
  estimatedUsd: number;
  failedCalls: number;
  checkpoint: string;
}

export interface BenchmarkProgressSnapshot {
  benchmark: string;
  status: "running" | "complete" | "failed" | "paused";
  startedAt: string;
  updatedAt: string;
  output: string;
  error?: string;
  systems: BenchmarkProgressSystem[];
  paired: {
    commonUnits: number;
    fishmemQuality: number | null;
    mem0Quality: number | null;
    difference: number | null;
  };
}

/** Write machine-readable and human-readable progress without torn files. */
export function writeBenchmarkProgress(
  outPath: string,
  snapshot: BenchmarkProgressSnapshot,
): void {
  writeFileAtomic(
    `${outPath}.progress.json`,
    `${JSON.stringify(snapshot, null, 2)}\n`,
  );
  writeFileAtomic(`${outPath}.progress.md`, renderBenchmarkProgress(snapshot));
}

export function renderBenchmarkProgress(
  snapshot: BenchmarkProgressSnapshot,
): string {
  const rows = snapshot.systems.map((system) => {
    const percent = system.total > 0 ? system.completed / system.total : 0;
    return `| ${system.system} | ${system.completed}/${system.total} | ${pct(percent)} | ${quality(system.quality)} | ${seconds(system.ingestMs)} | ${system.llmCalls} | ${system.embeddingCalls} | ${system.failedCalls} | $${system.estimatedUsd.toFixed(4)} |`;
  });
  const paired = snapshot.paired;
  const comparison =
    paired.difference === null
      ? `No paired units yet (${paired.commonUnits} common).`
      : `${paired.commonUnits} common units: fishmem ${quality(paired.fishmemQuality)}, mem0 ${quality(paired.mem0Quality)}, delta ${signedQuality(paired.difference)}.`;
  return [
    `# ${snapshot.benchmark} live progress`,
    "",
    `Status: **${snapshot.status}**  `,
    `Updated: ${snapshot.updatedAt}`,
    ...(snapshot.error ? [`Error: ${snapshot.error}`] : []),
    "",
    "| system | completed | progress | quality | ingest | LLM calls | embed calls | failed calls | estimated USD |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...rows,
    "",
    comparison,
    "",
    `Durable unit data is stored in the checkpoint paths listed in ${snapshot.output}.progress.json.`,
    "",
  ].join("\n");
}

export function benchmarkErrorMessage(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  while (current instanceof Error && messages.length < 3) {
    messages.push(`${current.name}: ${current.message}`);
    current = current.cause;
  }
  return messages.join(" <- ") || String(error);
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function quality(value: number | null): string {
  return value === null ? "-" : pct(value);
}

function signedQuality(value: number): string {
  const points = value * 100;
  return `${points >= 0 ? "+" : ""}${points.toFixed(1)} pt`;
}

function seconds(value: number): string {
  return `${(value / 1000).toFixed(1)} s`;
}
