/**
 * Paired significance comparison between two benchmark runs on the SAME
 * question set (LOCOMO result JSONs; works on any file whose systems[] carry
 * questions[{question, category, judgeLabel}]).
 *
 *   pnpm exec tsx benchmarks/compare.ts <runA.json> <runB.json> [systemA] [systemB]
 *
 * Reports, overall and per category:
 *   - paired accuracy difference with a 95% bootstrap CI (10k resamples)
 *   - McNemar exact test on discordant pairs (two-sided binomial)
 *
 * Constitution, law 2: ablations live or die by these numbers, not by
 * eyeballing point deltas (~9% of verdicts flip between identical re-runs).
 */
import { readFileSync } from "node:fs";

type Q = { question: string; category?: number; judgeLabel: string };

function loadSystem(
  path: string,
  systemName?: string,
): { name: string; questions: Q[] } {
  const run = JSON.parse(readFileSync(path, "utf8"));
  const systems: Array<{ system: string; questions: Q[] }> = run.systems ?? [];
  if (!systems.length) throw new Error(`${path}: no systems[]`);
  const sys = systemName
    ? systems.find((s) => s.system === systemName)
    : systems[0];
  if (!sys) throw new Error(`${path}: system "${systemName}" not found`);
  return { name: sys.system, questions: sys.questions };
}

type Pair = { category?: number; a: boolean; b: boolean };

function pairUp(a: Q[], b: Q[]): Pair[] {
  const bMap = new Map(b.map((q) => [q.question, q]));
  const pairs: Pair[] = [];
  for (const qa of a) {
    const qb = bMap.get(qa.question);
    if (!qb) continue;
    pairs.push({
      category: qa.category,
      a: qa.judgeLabel === "CORRECT",
      b: qb.judgeLabel === "CORRECT",
    });
  }
  return pairs;
}

/** Deterministic xorshift PRNG so reruns reproduce exactly. */
function makeRng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0xffffffff;
  };
}

function bootstrapDiff(pairs: Pair[], resamples = 10_000) {
  const n = pairs.length;
  const rng = makeRng(0xf157e);
  const diffs: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let accA = 0;
    let accB = 0;
    for (let i = 0; i < n; i++) {
      const p = pairs[Math.floor(rng() * n)]!;
      if (p.a) accA++;
      if (p.b) accB++;
    }
    diffs.push((accA - accB) / n);
  }
  diffs.sort((x, y) => x - y);
  return {
    lo: diffs[Math.floor(0.025 * resamples)]!,
    hi: diffs[Math.floor(0.975 * resamples)]!,
  };
}

/** Two-sided exact McNemar: binomial test on discordant pairs at p=0.5. */
function mcnemar(pairs: Pair[]) {
  const aOnly = pairs.filter((p) => p.a && !p.b).length;
  const bOnly = pairs.filter((p) => !p.a && p.b).length;
  const m = aOnly + bOnly;
  if (m === 0) return { aOnly, bOnly, p: 1 };
  const k = Math.min(aOnly, bOnly);
  // log-space binomial CDF to avoid overflow
  const logC = (nn: number, kk: number) => {
    let v = 0;
    for (let i = 0; i < kk; i++) v += Math.log(nn - i) - Math.log(i + 1);
    return v;
  };
  let tail = 0;
  for (let i = 0; i <= k; i++) {
    tail += Math.exp(logC(m, i) + m * Math.log(0.5));
  }
  return { aOnly, bOnly, p: Math.min(1, 2 * tail) };
}

function report(label: string, pairs: Pair[], nameA: string, nameB: string) {
  if (pairs.length === 0) return;
  const accA = pairs.filter((p) => p.a).length / pairs.length;
  const accB = pairs.filter((p) => p.b).length / pairs.length;
  const ci = bootstrapDiff(pairs);
  const mc = mcnemar(pairs);
  const sig = mc.p < 0.05 ? "SIGNIFICANT" : "not significant";
  console.log(
    `${label.padEnd(22)} n=${String(pairs.length).padEnd(4)} ` +
      `${nameA}=${(accA * 100).toFixed(1)}% ${nameB}=${(accB * 100).toFixed(1)}% ` +
      `Δ=${((accA - accB) * 100).toFixed(1)}pt ` +
      `CI95=[${(ci.lo * 100).toFixed(1)}, ${(ci.hi * 100).toFixed(1)}] ` +
      `McNemar p=${mc.p.toFixed(4)} (${mc.aOnly}/${mc.bOnly} discordant) → ${sig}`,
  );
}

const [, , fileA, fileB, sysA, sysB] = process.argv;
if (!fileA || !fileB) {
  console.error(
    "usage: tsx benchmarks/compare.ts <runA.json> <runB.json> [systemA] [systemB]",
  );
  process.exit(1);
}
const A = loadSystem(fileA, sysA);
const B = loadSystem(fileB, sysB);
const pairs = pairUp(A.questions, B.questions);
console.log(
  `Paired comparison: ${A.name} (${fileA.split("/").pop()}) vs ${B.name} (${fileB.split("/").pop()})`,
);
report("overall", pairs, A.name, B.name);
const categories = [...new Set(pairs.map((p) => p.category))].filter(
  (c): c is number => c !== undefined,
);
for (const c of categories.sort()) {
  report(
    `category ${c}`,
    pairs.filter((p) => p.category === c),
    A.name,
    B.name,
  );
}
