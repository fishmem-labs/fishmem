import type { Embedder, EmbeddingOptions } from "./base.js";

/**
 * Mean-centering decorator ("all-but-the-top" lite).
 *
 * Embedding spaces are anisotropic — vectors crowd a narrow cone around a
 * shared mean direction, which compresses cosine contrast. Subtracting the
 * corpus mean (then re-normalizing) restores discriminative geometry.
 *
 * Protocol: the mean is estimated from the first `warmup` embeddings and
 * then FROZEN, so index-time and query-time vectors are always transformed
 * consistently within one store lifetime. Vectors embedded before the
 * freeze pass through uncentered — for long-lived stores, enable this from
 * day one or re-index.
 *
 * Evidence note: the anisotropy results are strongest for older embedding
 * families; modern cosine-trained models may benefit less. Ships OFF by
 * default — enable via `embedder: { provider, centering: true }` and keep
 * it only if ablation pays (design constitution, law 2).
 */
export class CenteredEmbedder implements Embedder {
  readonly dimensions: number;
  private sum: Float64Array;
  private count = 0;
  private mean: number[] | null = null;

  constructor(
    private readonly inner: Embedder,
    private readonly warmup = 256,
  ) {
    this.dimensions = inner.dimensions;
    this.sum = new Float64Array(inner.dimensions);
  }

  async embed(text: string, options?: EmbeddingOptions): Promise<number[]> {
    return this.transform(await this.inner.embed(text, options));
  }

  async embedBatch(
    texts: string[],
    options?: EmbeddingOptions,
  ): Promise<number[][]> {
    const vectors = await this.inner.embedBatch(texts, options);
    return vectors.map((v) => this.transform(v));
  }

  private transform(vector: number[]): number[] {
    if (this.mean === null) {
      for (let i = 0; i < vector.length; i++) this.sum[i]! += vector[i]!;
      this.count++;
      if (this.count >= this.warmup) {
        this.mean = Array.from(this.sum, (s) => s / this.count);
      }
      return vector; // pre-freeze: pass through unchanged
    }
    const centered = vector.map((v, i) => v - this.mean![i]!);
    const norm = Math.hypot(...centered) || 1;
    return centered.map((v) => v / norm);
  }
}
