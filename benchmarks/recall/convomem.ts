/**
 * ConvoMem retrieval-recall harness for fishmem (raw base).
 *
 * Metric: recall@k = ALL of an item's gold `message_evidences` appear (substring)
 * in the top-k retrieved chunks. No answer LLM / judge — this isolates RETRIEVAL
 * quality (the architecture signal) and is cheap (embeddings only). Matches the
 * peers' native ConvoMem metric (evidence-substring recall) so the number is
 * comparable to MemPalace 92.9 / hebb-mind 66.3 (their self-reported recall).
 *
 * Usage:
 *   pnpm exec tsx benchmarks/recall/convomem.ts --sample 60 --top-k 10
 * Flags: --sample N (stride-sampled across the file), --top-k, --chunk-size,
 *   --data PATH, --out PATH.
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
  const path = arg("data") ?? process.env.CONVOMEM_DATA_PATH;
  if (!path) throw new Error("--data PATH or CONVOMEM_DATA_PATH is required");
  return path;
}
const DATA = dataPath();
const SAMPLE = Number(arg("sample", "60"));
const TOP_K = Number(arg("top-k", "10"));
const CHUNK = Number(arg("chunk-size", "4"));
const OUT = arg("out", join(HERE, "../results", "convomem-recall.json"))!;
const API_KEY = process.env.OPENAI_API_KEY ?? "";
const BASE_URL = process.env.OPENAI_BASE_URL || undefined;
if (!API_KEY) {
  console.error(
    "OPENAI_API_KEY required (embeddings). Set it in the root .env.",
  );
  process.exit(1);
}

type Msg = { speaker: string; text: string };
type Item = {
  question: string;
  answer: string;
  message_evidences: Msg[];
  conversations: { messages: Msg[] }[];
  category: string;
};

const { Memory } = await import("../../packages/fishmem/src/index.js");

const all: Item[] = JSON.parse(readFileSync(DATA, "utf8"));
// Stride-sample so the sample spans categories (the file is grouped by category).
const stride = Math.max(1, Math.floor(all.length / SAMPLE));
const items = all.filter((_, i) => i % stride === 0).slice(0, SAMPLE);

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

async function ingestAndRecall(item: Item): Promise<boolean> {
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
  for (const conv of item.conversations) {
    const turns = conv.messages.map((m) => `${m.speaker}: ${m.text}`);
    for (let i = 0; i < turns.length; i += CHUNK) {
      const content = turns.slice(i, i + CHUNK).join("\n");
      if (content.trim()) {
        await memory.add([{ role: "user", content }], { userId });
      }
    }
  }
  const res = await memory.search(item.question, { userId, limit: TOP_K });
  const hay = norm(res.results.map((r) => r.memory.content).join("\n"));
  const found = item.message_evidences.every((e) => hay.includes(norm(e.text)));
  await memory.close();
  return found;
}

async function main() {
  console.log(
    `ConvoMem recall — fishmem verbatim | sample=${items.length}/${all.length} | top-k=${TOP_K} | chunk=${CHUNK}`,
  );
  const byCat: Record<string, { n: number; hit: number }> = {};
  let hit = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    const ok = await ingestAndRecall(it);
    byCat[it.category] ??= { n: 0, hit: 0 };
    byCat[it.category]!.n++;
    if (ok) {
      hit++;
      byCat[it.category]!.hit++;
    }
    if ((i + 1) % 10 === 0)
      console.log(
        `  ${i + 1}/${items.length} (recall so far ${((hit / (i + 1)) * 100).toFixed(1)}%)`,
      );
  }
  const pct = (a: number, n: number) =>
    `${((a / Math.max(1, n)) * 100).toFixed(1)}%`;
  console.log(
    `\nrecall@${TOP_K}: ${pct(hit, items.length)} (${hit}/${items.length})`,
  );
  console.log("by category:");
  for (const c of Object.keys(byCat).sort())
    console.log(
      `  ${c.padEnd(22)} ${pct(byCat[c]!.hit, byCat[c]!.n)} (${byCat[c]!.hit}/${byCat[c]!.n})`,
    );
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        dataset: "convomem",
        architecture: "verbatim",
        topK: TOP_K,
        sample: items.length,
        recall: hit / items.length,
        byCategory: byCat,
      },
      null,
      2,
    ),
  );
  console.log(`\nwritten ${OUT}`);
}

await main();
