import type { ProviderUsageHandler } from "../llms/base.js";
import type { Embedder, EmbeddingOptions } from "./base.js";

/**
 * Output dimensionality per model. The vector store is created for a fixed
 * width, so this is not a detail the caller may get wrong: an embedder that
 * reports the wrong number produces vectors the index silently rejects or,
 * worse, accepts into the wrong space.
 */
const MODEL_DIMS: Record<string, number> = {
  "@cf/baai/bge-m3": 1024,
  "@cf/baai/bge-large-en-v1.5": 1024,
  "@cf/baai/bge-base-en-v1.5": 768,
  "@cf/baai/bge-small-en-v1.5": 384,
  "@cf/google/embeddinggemma-300m": 768,
  "@cf/qwen/qwen3-embedding-0.6b": 1024,
};

/** Largest batch sent in one binding call. */
const MAX_BATCH = 100;

export interface WorkersAiEmbedderConfig {
  /** The Workers AI binding, `env.AI`. */
  binding: WorkersAiBinding;
  /** Model id, e.g. `@cf/baai/bge-m3`. */
  model?: string;
  /** Override when using a model this build does not know the width of. */
  dimensions?: number;
  onUsage?: ProviderUsageHandler;
}

export interface WorkersAiBinding {
  run(
    model: string,
    input: { text: string[] },
  ): Promise<{
    data?: number[][];
    shape?: number[];
    usage?: { prompt_tokens?: number; total_tokens?: number };
  }>;
}

/**
 * Embeddings from Cloudflare Workers AI, reached through the runtime binding
 * rather than over HTTP.
 *
 * The binding keeps the call inside Cloudflare's network: measured against the
 * same query text, this answers in tens of milliseconds where an external
 * embedding API took several hundred, and the embedding call sits directly on
 * the search critical path.
 */
export class WorkersAiEmbedder implements Embedder {
  readonly dimensions: number;
  private readonly model: string;
  private readonly binding: WorkersAiBinding;
  private readonly onUsage?: ProviderUsageHandler;

  constructor(config: WorkersAiEmbedderConfig) {
    if (!config?.binding?.run) {
      throw new Error("WorkersAiEmbedder requires the Workers AI binding");
    }
    this.binding = config.binding;
    this.model = config.model ?? "@cf/baai/bge-m3";
    const known = MODEL_DIMS[this.model];
    if (!known && config.dimensions === undefined) {
      throw new Error(
        `Unknown embedding width for ${this.model}; pass an explicit \`dimensions\``,
      );
    }
    this.dimensions = config.dimensions ?? known!;
    this.onUsage = config.onUsage;
  }

  async embed(text: string, options?: EmbeddingOptions): Promise<number[]> {
    const [vector] = await this.embedBatch([text], options);
    return vector!;
  }

  async embedBatch(
    texts: string[],
    options?: EmbeddingOptions,
  ): Promise<number[][]> {
    if (texts.length === 0) return [];
    const vectors: number[][] = [];
    for (let offset = 0; offset < texts.length; offset += MAX_BATCH) {
      const batch = texts.slice(offset, offset + MAX_BATCH);
      const startedAt = Date.now();
      const result = await this.binding.run(this.model, { text: batch });
      const data = result?.data;
      if (!Array.isArray(data) || data.length !== batch.length) {
        throw new Error(
          `Workers AI returned ${data?.length ?? 0} embeddings for ${batch.length} inputs`,
        );
      }
      const width = data[0]?.length ?? 0;
      if (width !== this.dimensions) {
        // Storing a differently sized vector would corrupt the index rather
        // than fail, so this must be loud and immediate.
        throw new Error(
          `${this.model} returned ${width}-dimensional vectors, expected ${this.dimensions}`,
        );
      }
      await this.onUsage?.({
        provider: "workers-ai",
        model: this.model,
        kind: "embedding",
        // Not every Workers AI model reports usage; fall back to an estimate
        // so metering stays continuous rather than silently dropping to zero.
        inputTokens:
          result.usage?.prompt_tokens ??
          result.usage?.total_tokens ??
          estimateTokens(batch),
        outputTokens: 0,
        latencyMs: Date.now() - startedAt,
        context: options?.context,
      });
      vectors.push(...data);
    }
    return vectors;
  }
}

/** Rough token count used only when the provider omits usage. */
function estimateTokens(texts: string[]): number {
  let characters = 0;
  for (const text of texts) characters += text.length;
  return Math.max(1, Math.ceil(characters / 4));
}

export { MODEL_DIMS as WORKERS_AI_EMBEDDING_DIMS };
