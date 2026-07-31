/**
 * MemBench retrieval-recall harness for fishmem (raw base).
 *
 * Metric: Hit@k = the gold turn (`QA.target_step_id`) is among the top-k retrieved
 * turns. Each conversation turn is one memory tagged with its sid + global index;
 * a retrieved turn hits if either id matches a target (lenient, matching the
 * dataset's dual-key scoring). No answer LLM — isolates retrieval. Comparable to
 * the peers' Hit@5 (hebb-mind 94.6 / MemPalace 80.3).
 *
 * Usage: pnpm exec tsx benchmarks/recall/membench.ts --sample 60 --top-k 5
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
for (const p of [join(HERE, "../../.env")]) {
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]!])
      process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}
const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};

function dataPath(): string {
  const path = arg("data") ?? process.env.MEMBENCH_DATA_PATH;
  if (!path) throw new Error("--data PATH or MEMBENCH_DATA_PATH is required");
  return path;
}
const DATA = dataPath();
const SAMPLE = Number(arg("sample", "60"));
const TOP_K = Number(arg("top-k", "5"));
const CHUNK = Number(arg("chunk-size", "4")); // turns per verbatim memory
const OUT = arg("out", join(HERE, "../results", "membench-recall.json"))!;
const API_KEY = process.env.OPENAI_API_KEY ?? "";
const BASE_URL = process.env.OPENAI_BASE_URL || undefined;
if (!API_KEY) {
  console.error(
    "OPENAI_API_KEY required (embeddings). Set it in the root .env.",
  );
  process.exit(1);
}

type Turn = { sid: number; user_message: string; assistant_message: string };
type Item = {
  tid: number;
  message_list: Turn[][]; // sessions of turns
  QA: { question: string; answer: string; target_step_id: number[][] };
  _category_key: string;
};

const { Memory } = await import("../../packages/fishmem/src/index.js");

const all: Item[] = JSON.parse(readFileSync(DATA, "utf8"));
const stride = Math.max(1, Math.floor(all.length / SAMPLE));
const items = all.filter((_, i) => i % stride === 0).slice(0, SAMPLE);

async function hitAtK(item: Item): Promise<boolean> {
  const memory = await Memory.create({
    embedder: {
      provider: "openai",
      config: {
        apiKey: API_KEY,
        model: "text-embedding-3-small",
        ...(BASE_URL ? { baseURL: BASE_URL } : {}),
      },
    },
    llm: BASE_URL
      ? {
          provider: "openai",
          config: { apiKey: API_KEY, model: "gpt-4o-mini", baseURL: BASE_URL },
        }
      : { provider: "mock" },
    vectorStore: { provider: "memory" },
    graphStore: { provider: "memory" },
  });
  const userId = "u";
  // Chunk turns (fishmem stores chunk-level "drawers", not single turns).
  // Each chunk records the sids + global indices it covers; a retrieved chunk
  // hits if it CONTAINS a target turn (chunk-level Hit@k).
  let gidx = 0;
  for (const session of item.message_list) {
    for (let i = 0; i < session.length; i += CHUNK) {
      const slice = session.slice(i, i + CHUNK);
      const content = slice
        .map(
          (t) => `User: ${t.user_message}\nAssistant: ${t.assistant_message}`,
        )
        .join("\n");
      const sids = slice.map((t) => t.sid);
      const gidxs = slice.map(() => gidx++);
      await memory.add([{ role: "user", content }], {
        userId,
        metadata: { sids, gidxs },
      });
    }
  }
  const targets = new Set<number>((item.QA.target_step_id ?? []).flat());
  const res = await memory.search(item.QA.question, { userId, limit: TOP_K });
  const hit = res.results.some((r) => {
    const md = (r.memory.metadata ?? {}) as {
      sids?: number[];
      gidxs?: number[];
    };
    return (
      (md.sids ?? []).some((s) => targets.has(s)) ||
      (md.gidxs ?? []).some((g) => targets.has(g))
    );
  });
  await memory.close();
  return hit;
}

async function main() {
  console.log(
    `MemBench Hit@${TOP_K} — fishmem verbatim | sample=${items.length}/${all.length} | data=${DATA.split("/").pop()}`,
  );
  const byCat: Record<string, { n: number; hit: number }> = {};
  let hit = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    const ok = await hitAtK(it);
    byCat[it._category_key] ??= { n: 0, hit: 0 };
    byCat[it._category_key]!.n++;
    if (ok) {
      hit++;
      byCat[it._category_key]!.hit++;
    }
    if ((i + 1) % 10 === 0)
      console.log(
        `  ${i + 1}/${items.length} (hit so far ${((hit / (i + 1)) * 100).toFixed(1)}%)`,
      );
  }
  const pct = (a: number, n: number) =>
    `${((a / Math.max(1, n)) * 100).toFixed(1)}%`;
  console.log(
    `\nHit@${TOP_K}: ${pct(hit, items.length)} (${hit}/${items.length})`,
  );
  for (const c of Object.keys(byCat).sort())
    console.log(
      `  ${c.padEnd(20)} ${pct(byCat[c]!.hit, byCat[c]!.n)} (${byCat[c]!.hit}/${byCat[c]!.n})`,
    );
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        dataset: "membench",
        data: DATA,
        architecture: "verbatim",
        topK: TOP_K,
        sample: items.length,
        hit: hit / items.length,
        byCategory: byCat,
      },
      null,
      2,
    ),
  );
  console.log(`\nwritten ${OUT}`);
}

await main();
