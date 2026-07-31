import type { ProviderUsageHandler } from "../llms/base.js";
import type { Embedder, EmbeddingOptions } from "./base.js";

export interface OpenAIEmbedderConfig {
  apiKey?: string;
  model?: string;
  /** Override dimensions (text-embedding-3-* support shortening). */
  dimensions?: number;
  baseURL?: string;
  onUsage?: ProviderUsageHandler;
  timeoutMs?: number;
  maxRetries?: number;
}

/** Default dims for known models. */
const MODEL_DIMS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
};

/**
 * OpenAI embeddings (also works with any OpenAI-compatible endpoint via
 * `baseURL`). The `openai` package is an optional peer dependency, imported
 * lazily so the core stays edge-importable.
 */
export class OpenAIEmbedder implements Embedder {
  readonly dimensions: number;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly baseURL?: string;
  private client: unknown;
  private readonly onUsage?: ProviderUsageHandler;
  private readonly timeoutMs?: number;
  private readonly maxRetries?: number;

  constructor(config: OpenAIEmbedderConfig = {}) {
    this.model = config.model ?? "text-embedding-3-small";
    this.apiKey = config.apiKey ?? process.env.OPENAI_API_KEY ?? "";
    this.baseURL = config.baseURL;
    this.dimensions = config.dimensions ?? MODEL_DIMS[this.model] ?? 1536;
    this.onUsage = config.onUsage;
    this.timeoutMs = config.timeoutMs;
    this.maxRetries = config.maxRetries;
    if (!this.apiKey) {
      throw new Error(
        "OpenAIEmbedder requires an API key (config.apiKey or OPENAI_API_KEY).",
      );
    }
  }

  private async getClient(): Promise<any> {
    if (this.client) return this.client;
    let mod: any;
    try {
      mod = await import("openai");
    } catch {
      throw new Error(
        "The 'openai' package is required for OpenAIEmbedder. Install it: npm i openai",
      );
    }
    const OpenAI = mod.default ?? mod.OpenAI ?? mod;
    this.client = new OpenAI({
      apiKey: this.apiKey,
      baseURL: this.baseURL,
      ...(this.timeoutMs !== undefined ? { timeout: this.timeoutMs } : {}),
      ...(this.maxRetries !== undefined ? { maxRetries: this.maxRetries } : {}),
    });
    return this.client;
  }

  async embed(text: string, options?: EmbeddingOptions): Promise<number[]> {
    const [vec] = await this.embedBatch([text], options);
    return vec!;
  }

  async embedBatch(
    texts: string[],
    options?: EmbeddingOptions,
  ): Promise<number[][]> {
    if (texts.length === 0) return [];
    const client = await this.getClient();
    const params: Record<string, unknown> = {
      model: this.model,
      input: texts,
      // OpenAI's Node SDK otherwise requests base64 and decodes the response
      // automatically. Some OpenAI-compatible providers ignore that request
      // and still return float arrays, which the SDK then corrupts by treating
      // them as base64. Asking for floats explicitly keeps the wire contract
      // portable across OpenAI, Ollama, Together, and compatible gateways.
      encoding_format: "float",
    };
    // text-embedding-3-* accept a `dimensions` shortening parameter.
    if (this.model.startsWith("text-embedding-3")) {
      params.dimensions = this.dimensions;
    }
    const startedAt = Date.now();
    const res = await client.embeddings.create(params);
    await this.onUsage?.({
      provider: "openai",
      model: this.model,
      kind: "embedding",
      inputTokens: Number(
        res.usage?.prompt_tokens ?? res.usage?.total_tokens ?? 0,
      ),
      outputTokens: 0,
      latencyMs: Date.now() - startedAt,
      context: options?.context,
    });
    return res.data.map((d: { embedding: number[] }) => d.embedding);
  }
}
