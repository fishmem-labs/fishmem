/**
 * Fit per-source fusion calibration curves from trace-enabled benchmark runs.
 *
 *   pnpm exec tsx benchmarks/fit-calibration.ts <traced-run.json...> \
 *       [--out calibration.json] [--min-points 30]
 *
 * Input: run JSONs whose questions[] carry `trace` (per-source candidate
 * lists with raw scores) and `judgeLabel`. Label model (weak supervision,
 * documented limitation): a candidate is labeled useful iff it was SELECTED
 * into the final context AND the question was judged CORRECT. Candidates
 * surfaced by a source but not selected, or on judged-wrong questions, are
 * negatives. This conflates retrieval and answering errors — acceptable for
 * fitting monotone reliability curves, not for memory-level ground truth.
 * Cross-dataset validation is mandatory before shipping fitted tables as
 * defaults (constitution, law 2).
 *
 * Output: CalibrationTables JSON consumable via
 *   Memory.create({ search: { fusion: "calibrated", calibration } })
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fitIsotonic } from "../packages/fishmem/src/core/calibration.js";

type Trace = {
  lists: Record<string, Array<{ id: string; score: number }>>;
  selected: string[];
};
type Q = { judgeLabel: string; trace?: Trace };

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const out =
  outIdx >= 0
    ? args.splice(outIdx, 2)[1]!
    : "benchmarks/results/calibration.json";
const minIdx = args.indexOf("--min-points");
const minPoints = minIdx >= 0 ? Number(args.splice(minIdx, 2)[1]) : 30;
const files = args;
if (!files.length) {
  console.error(
    "usage: tsx benchmarks/fit-calibration.ts <traced-run.json...> [--out f] [--min-points n]",
  );
  process.exit(1);
}

const points: Record<string, Array<{ score: number; label: 0 | 1 }>> = {
  vector: [],
  fts: [],
  graph: [],
  temporal: [],
};

let traced = 0;
for (const file of files) {
  const run = JSON.parse(readFileSync(file, "utf8"));
  for (const sys of run.systems ?? []) {
    for (const q of (sys.questions ?? []) as Q[]) {
      if (!q.trace) continue;
      traced++;
      const correct = q.judgeLabel === "CORRECT";
      const selected = new Set(q.trace.selected);
      for (const [source, list] of Object.entries(q.trace.lists)) {
        if (!(source in points)) continue;
        for (const item of list) {
          points[source]!.push({
            score: item.score,
            label: correct && selected.has(item.id) ? 1 : 0,
          });
        }
      }
    }
  }
}

if (!traced) {
  console.error(
    "No traced questions found. Re-run the benchmark with tracing enabled " +
      "(the harness passes search({trace:true}) when --trace is set).",
  );
  process.exit(1);
}

const tables: Record<string, unknown> = {};
console.log(`Fitted from ${traced} traced questions:`);
for (const [source, pts] of Object.entries(points)) {
  if (pts.length < minPoints) {
    console.log(
      `  ${source.padEnd(8)} skipped (${pts.length} points < ${minPoints})`,
    );
    continue;
  }
  const curve = fitIsotonic(pts);
  tables[source] = curve;
  const pos = pts.filter((p) => p.label === 1).length;
  console.log(
    `  ${source.padEnd(8)} ${pts.length} points (${pos} positive) → ${curve.x.length} isotonic blocks, ` +
      `p ∈ [${Math.min(...curve.y).toFixed(3)}, ${Math.max(...curve.y).toFixed(3)}]`,
  );
}
writeFileSync(out, JSON.stringify(tables, null, 2));
console.log(`\nCalibration tables written to ${out}`);
console.log(
  "Ship discipline: fit on dev traces, validate on hold-out, cross-dataset check before defaulting.",
);
