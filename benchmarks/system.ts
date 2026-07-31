export type BenchmarkSystem = "fishmem" | "mem0";
export type BenchmarkSplit = "smoke" | "dev" | "holdout" | "full";

export function parseBenchmarkSystem(value: string): BenchmarkSystem {
  if (value === "fishmem" || value === "mem0") return value;
  throw new Error(
    `unknown benchmark system "${value}" (expected fishmem|mem0)`,
  );
}

export function parseBenchmarkSplit(
  value: string | undefined,
  smoke: boolean,
): BenchmarkSplit {
  if (smoke) {
    if (value !== undefined && value !== "smoke") {
      throw new Error(
        `--split must be smoke when --smoke is set (got ${value})`,
      );
    }
    return "smoke";
  }
  if (value === "dev" || value === "holdout" || value === "full") return value;
  throw new Error("--split dev|holdout|full is required for non-smoke runs");
}
