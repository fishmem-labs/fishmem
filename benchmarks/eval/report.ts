import { readFileSync } from "node:fs";
import { normalizeEvalRuns } from "./normalize.js";
import { renderScorecard, writeScorecard } from "./scorecard.js";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const draft = args.includes("--draft");
const outIndex = args.indexOf("--out");
const out = outIndex >= 0 ? args[outIndex + 1] : undefined;
const files = args.filter(
  (value, index) =>
    value !== "--draft" && index !== outIndex && index !== outIndex + 1,
);
if (files.length === 0 || (outIndex >= 0 && !out)) {
  throw new Error(
    "usage: tsx benchmarks/eval/report.ts <result.json...> [--draft] [--out report.md]",
  );
}
const runs = files.flatMap((path) =>
  normalizeEvalRuns(JSON.parse(readFileSync(path, "utf8"))),
);
const report = renderScorecard(runs, { draft });
if (out) writeScorecard(out, report);
else process.stdout.write(report);
