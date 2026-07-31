import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LongMemEvalInstance } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));

export type Variant = "oracle" | "s";

export const DATASET_URL =
  "https://huggingface.co/datasets/xiaowu0162/longmemeval/tree/main";

export function datasetPath(variant: Variant): string {
  return join(HERE, "data", `longmemeval_${variant}.json`);
}

/**
 * Load a LongMemEval variant:
 *  - oracle: evidence-only sessions per instance (~2 sessions) — cheap validation.
 *  - s:      full haystack (~50 sessions per instance, 265MB file).
 *
 * For `s`, the parsed object graph is large; if node runs out of heap, re-run
 * with NODE_OPTIONS=--max-old-space-size=8192.
 */
export function loadDataset(variant: Variant): LongMemEvalInstance[] {
  const path = datasetPath(variant);
  if (!existsSync(path)) {
    throw new Error(
      `LongMemEval dataset not found at ${path}.\nDownload longmemeval_${variant}.json from ${DATASET_URL}`,
    );
  }
  const data = JSON.parse(readFileSync(path, "utf8")) as LongMemEvalInstance[];
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(
      `Unexpected dataset shape at ${path} (expected non-empty array).`,
    );
  }
  return data;
}

/**
 * Official convention (evaluate_qa.py): `abstention='_abs' in entry['question_id']`.
 * Abstention questions are unanswerable — the correct behavior is declining.
 */
export function isAbstention(questionId: string): boolean {
  return questionId.includes("_abs");
}
