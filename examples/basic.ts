/**
 * Basic usage with persistent SQLite (libSQL) graph + vector stores.
 *
 *   OPENAI_API_KEY=sk-... npx tsx examples/basic.ts
 *
 * Without an API key it falls back to the offline mock LLM/embedder, so it
 * still runs end-to-end (recall quality will be lexical, not semantic).
 */
import { Memory } from "../src/index.js";

async function main() {
  const memory = await Memory.create({
    // Persist the graph + history to a local SQLite file.
    graphStore: { provider: "sqlite", config: { url: "file:./fishmem.db" } },
    // Persist embeddings to a local SQLite file (separate table).
    vectorStore: {
      provider: "sqlite",
      config: { url: "file:./fishmem-vectors.db" },
    },
    // llm/embedder default to OpenAI if OPENAI_API_KEY is set, else mock.
  });

  await memory.add(
    [
      {
        role: "user",
        content: "I'm Sam. I love climbing and I'm based in Berlin.",
      },
      { role: "assistant", content: "Great to meet you, Sam!" },
    ],
    { userId: "sam" },
  );

  await memory.add("Sam decided to switch to a standing desk.", {
    userId: "sam",
    memoryType: "decision",
    infer: false,
  });

  console.log("\nAll memories for sam:");
  for (const mem of (await memory.getAll({ userId: "sam" })).results) {
    console.log(` • [${mem.memoryType}] ${mem.content}`);
  }

  console.log("\nSearch 'where does sam live and what does he enjoy':");
  const { results } = await memory.search(
    "where does sam live and what does he enjoy",
    { userId: "sam" },
  );
  for (const r of results) {
    console.log(` • ${r.score.toFixed(3)}  ${r.memory.content}`);
  }

  await memory.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
