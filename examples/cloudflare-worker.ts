/**
 * Cloudflare Workers example: graph memory in D1, embeddings in Vectorize.
 *
 * wrangler.toml:
 *   [[d1_databases]]
 *   binding = "DB"
 *   database_name = "fishmem"
 *   database_id = "..."
 *
 *   [[vectorize]]
 *   binding = "MEMORIES"
 *   index_name = "fishmem"      # created with: wrangler vectorize create fishmem --dimensions=1536 --metric=cosine
 *
 * Apply the schema once with wrangler migrations (preferred), or set
 * autoMigrate: true on the D1 graph store for quick dev.
 */
import { Memory } from "fishmem";

export interface Env {
  DB: any; // D1Database
  MEMORIES: any; // VectorizeIndex
  OPENAI_API_KEY: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const memory = await Memory.create({
      graphStore: { provider: "d1", config: { binding: env.DB } },
      vectorStore: { provider: "vectorize", config: { index: env.MEMORIES } },
      llm: { provider: "openai", config: { apiKey: env.OPENAI_API_KEY } },
      embedder: { provider: "openai", config: { apiKey: env.OPENAI_API_KEY } },
    });

    const url = new URL(request.url);
    const userId = url.searchParams.get("user") ?? "anon";

    if (request.method === "POST") {
      const { text } = (await request.json()) as { text: string };
      const result = await memory.add(text, { userId });
      return Response.json(result);
    }

    const q = url.searchParams.get("q") ?? "";
    const { results } = await memory.search(q, { userId });
    return Response.json({ results });
  },
};
