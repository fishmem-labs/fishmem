import type {
  ProviderCallContext,
  ProviderUsageHandler,
} from "../llms/base.js";

export interface EmbeddingOptions {
  context?: ProviderCallContext;
}

export interface MeteredEmbedderConfig {
  onUsage?: ProviderUsageHandler;
}

/** Generates dense vector embeddings for text. */
export interface Embedder {
  /** Embedding dimensionality. Must be stable for the lifetime of a store. */
  readonly dimensions: number;

  /** Embed a single string. */
  embed(text: string, options?: EmbeddingOptions): Promise<number[]>;

  /** Embed a batch of strings. Default implementations may call `embed` per item. */
  embedBatch(texts: string[], options?: EmbeddingOptions): Promise<number[][]>;
}
