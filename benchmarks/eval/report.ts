import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { auditOperationalEvidence } from "./attempt-ledger.js";
import { normalizeEvalRuns } from "./normalize.js";
import { renderScorecard, writeScorecard } from "./scorecard.js";

export function parseReportArgs(argv: string[]): {
  files: string[];
  draft: boolean;
  out?: string;
} {
  const args = argv.filter((arg) => arg !== "--");
  const draft = args.includes("--draft");
  const outIndex = args.indexOf("--out");
  const out = outIndex >= 0 ? args[outIndex + 1] : undefined;
  const files = args.filter(
    (value, index) =>
      value !== "--draft" &&
      (outIndex < 0 || (index !== outIndex && index !== outIndex + 1)),
  );
  if (files.length === 0 || (outIndex >= 0 && !out)) {
    throw new Error(
      "usage: tsx benchmarks/eval/report.ts <result.json...> [--draft] [--out report.md]",
    );
  }
  return { files, draft, ...(out ? { out } : {}) };
}

function main(): void {
  const { files, draft, out } = parseReportArgs(process.argv.slice(2));
  const artifacts = files.map((path) => {
    const content = readFileSync(path);
    return {
      path,
      content,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  });
  const runs = artifacts.flatMap(({ content }) =>
    normalizeEvalRuns(JSON.parse(content.toString("utf8"))),
  );
  const operational = auditOperationalEvidence(files);
  const report = renderScorecard(runs, {
    draft,
    sources: artifacts.map(({ path, sha256 }) => ({ path, sha256 })),
    processAttempts: operational.attempts,
  });
  if (out) writeScorecard(out, report);
  else process.stdout.write(report);
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) main();
