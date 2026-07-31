import type { Embedder } from "./base.js";

/**
 * Deterministic, dependency-free embedder for offline use and tests.
 *
 * Produces a hashed bag-of-words vector (term frequency hashed into buckets)
 * that is L2-normalised, so cosine similarity tracks lexical overlap. This is
 * obviously not a real semantic model, but it is stable, fast, requires no
 * network or native code, and makes hybrid-search tests reproducible.
 */
export class MockEmbedder implements Embedder {
  readonly dimensions: number;

  constructor(dimensions = 384) {
    this.dimensions = dimensions;
  }

  async embed(text: string): Promise<number[]> {
    return this.embedSync(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedSync(t));
  }

  private embedSync(text: string): number[] {
    const vec = new Array<number>(this.dimensions).fill(0);
    const tokens = tokenize(text);
    if (tokens.length === 0) {
      // Avoid a zero vector — cosine is undefined for it.
      vec[0] = 1;
      return vec;
    }
    for (const token of tokens) {
      const h = hash32(token);
      const idx = h % this.dimensions;
      // Sign bucketing reduces collisions between distinct tokens.
      const sign = h >>> 31 === 1 ? -1 : 1;
      vec[idx]! += sign;
    }
    return l2normalize(vec);
  }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9一-鿿]+/u)
    .filter((t) => t.length > 0);
}

/** FNV-1a 32-bit hash. */
function hash32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function l2normalize(vec: number[]): number[] {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}
