/**
 * Fit the learned query→statement map from trace-enabled benchmark runs.
 *
 *   OPENAI_API_KEY=... pnpm exec tsx benchmarks/fit-querymap.ts \
 *       <traced-run.json...> [--out querymap.json] [--lambda 10] [--max-pairs 256] \
 *       [--embedder text-embedding-3-small]
 *
 * Questions and stored facts occupy different regions of embedding space.
 * We fit W = I + Δ minimizing Σ‖W·qᵢ − mᵢ‖² + λ‖Δ‖²_F over
 * (question, evidence-memory) pairs, where pairs come from traces: the
 * memories SELECTED into the context of questions the judge marked CORRECT.
 *
 * Kernel-ridge identity keeps it an n×n solve (n = #pairs, not d=1536):
 *   Δ = Rᵀ(K + λI)⁻¹Q,  K = QQᵀ,  R = M − Q
 * applied at query time as q' = normalize(q + U(Vᵀq)) with factor rows
 * U = (K+λI)⁻¹R (mixed) and V = Q — exactly the shape `search.queryMap`
 * consumes. Embedding the pairs costs a few cents; inference cost is two
 * thin mat-vecs (microseconds).
 *
 * Discipline (constitution, law 2): fit on dev traces, validate on
 * hold-out, cross-dataset check before shipping as a default.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OpenAIEmbedder } from "../packages/fishmem/src/embeddings/openai.js";

// .env loader (matches the runners)
const HERE = dirname(fileURLToPath(import.meta.url));
const envPath = join(HERE, "../.env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]!])
      process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

type Trace = {
  selected: string[];
  selectedItems?: Array<{ id: string; content: string }>;
};
type Q = { question: string; judgeLabel: string; trace?: Trace };

const args = process.argv.slice(2);
function takeFlag(name: string, fallback: string): string {
  const i = args.indexOf(`--${name}`);
  if (i >= 0) return args.splice(i, 2)[1]!;
  return fallback;
}
const out = takeFlag("out", "benchmarks/results/querymap.json");
const lambda = Number(takeFlag("lambda", "10"));
const maxPairs = Number(takeFlag("max-pairs", "256"));
const embedderModel = takeFlag("embedder", "text-embedding-3-small");
const files = args;
if (!files.length) {
  console.error(
    "usage: tsx benchmarks/fit-querymap.ts <traced-run.json...> [flags]",
  );
  process.exit(1);
}

// 1. Collect (question, evidence content) pairs from correct, traced questions.
const pairs: Array<{ question: string; content: string }> = [];
for (const file of files) {
  const run = JSON.parse(readFileSync(file, "utf8"));
  for (const sys of run.systems ?? []) {
    for (const q of (sys.questions ?? []) as Q[]) {
      if (q.judgeLabel !== "CORRECT" || !q.trace?.selectedItems) continue;
      for (const item of q.trace.selectedItems) {
        pairs.push({ question: q.question, content: item.content });
      }
    }
  }
}
if (pairs.length < 20) {
  console.error(
    `Only ${pairs.length} pairs — need ≥20. Run benchmarks with --trace first.`,
  );
  process.exit(1);
}
// Deterministic subsample to maxPairs (stride sampling — no RNG needed).
const stride = Math.max(1, Math.floor(pairs.length / maxPairs));
const sample = pairs.filter((_, i) => i % stride === 0).slice(0, maxPairs);
console.log(
  `Pairs: ${pairs.length} collected, ${sample.length} used (λ=${lambda})`,
);

// 2. Embed both sides.
const embedder = new OpenAIEmbedder({
  model: embedderModel,
  ...(process.env.OPENAI_BASE_URL
    ? { baseURL: process.env.OPENAI_BASE_URL }
    : {}),
});
const qVecs = await embedder.embedBatch(sample.map((p) => p.question));
const mVecs = await embedder.embedBatch(sample.map((p) => p.content));
const n = sample.length;
const d = qVecs[0]!.length;

// 3. K = QQᵀ (n×n), solve (K + λI) A = R  →  A = (K+λI)⁻¹R  (R = M − Q, n×d)
const K: number[][] = Array.from({ length: n }, (_, i) =>
  Array.from({ length: n }, (_, j) => {
    let dot = 0;
    for (let t = 0; t < d; t++) dot += qVecs[i]![t]! * qVecs[j]![t]!;
    return dot + (i === j ? lambda : 0);
  }),
);
// Cholesky decomposition K = LLᵀ
const L: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
for (let i = 0; i < n; i++) {
  for (let j = 0; j <= i; j++) {
    let sum = K[i]![j]!;
    for (let t = 0; t < j; t++) sum -= L[i]![t]! * L[j]![t]!;
    if (i === j) {
      if (sum <= 0) throw new Error("K not positive definite — raise --lambda");
      L[i]![i] = Math.sqrt(sum);
    } else {
      L[i]![j] = sum / L[j]![j]!;
    }
  }
}
function solveCholesky(b: number[]): number[] {
  const y = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let sum = b[i]!;
    for (let t = 0; t < i; t++) sum -= L[i]![t]! * y[t]!;
    y[i] = sum / L[i]![i]!;
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = y[i]!;
    for (let t = i + 1; t < n; t++) sum -= L[t]![i]! * x[t]!;
    x[i] = sum / L[i]![i]!;
  }
  return x;
}
// Columns of R solved independently: U[k] rows = (A R) rows.
const U: number[][] = Array.from({ length: n }, () => new Array(d).fill(0));
const col = new Array(n).fill(0);
for (let t = 0; t < d; t++) {
  for (let i = 0; i < n; i++) col[i] = mVecs[i]![t]! - qVecs[i]![t]!;
  const solved = solveCholesky(col);
  for (let i = 0; i < n; i++) U[i]![t] = solved[i]!;
}
const round = (x: number) => Math.round(x * 1e4) / 1e4;
const payload = {
  u: U.map((row) => row.map(round)),
  v: qVecs.map((row) => row.map(round)),
};
writeFileSync(out, JSON.stringify(payload));
console.log(
  `Query map written to ${out} (rank ${n}, dim ${d}). ` +
    `Use via Memory.create({ search: { queryMap } }).`,
);
