/**
 * Postgres example: graph memory in Postgres, embeddings in pgvector.
 * Both share one DATABASE_URL.
 *
 *   DATABASE_URL=postgres://user:pass@localhost:5432/fishmem \
 *   OPENAI_API_KEY=sk-... npx tsx examples/postgres.ts
 *
 * Requires the `vector` extension (the pgvector store runs CREATE EXTENSION
 * IF NOT EXISTS vector on init).
 */
import { Memory } from "../src/index.js";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("set DATABASE_URL");

  const memory = await Memory.create({
    graphStore: { provider: "postgres", config: { connectionString: url } },
    vectorStore: { provider: "pgvector", config: { connectionString: url } },
    llm: { provider: "openai" },
    embedder: { provider: "openai" },
  });

  await memory.add("The team uses TypeScript and deploys on Fridays.", {
    agentId: "ops-bot",
    memoryType: "fact",
  });

  const { results } = await memory.search("what language does the team use?", {
    agentId: "ops-bot",
  });
  console.log(results.map((r) => `${r.score.toFixed(3)} ${r.memory.content}`));

  await memory.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
