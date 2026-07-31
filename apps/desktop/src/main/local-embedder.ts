import type { Embedder, EmbeddingOptions } from "fishmem";
import { env, pipeline } from "@huggingface/transformers";

const MODEL_ID = "Xenova/multilingual-e5-small";
const MODEL_REVISION = "761b726dd34fb83930e26aab4e9ac3899aa1fa78";
const DIMENSIONS = 384;

export type LocalEmbeddingState =
  | { phase: "idle" }
  | { phase: "downloading"; progress?: number }
  | { phase: "ready" }
  | { phase: "error"; message: string };

type FeatureExtractor = Awaited<
  ReturnType<typeof pipeline<"feature-extraction">>
>;

/**
 * Local multilingual E5 embeddings backed by quantized ONNX weights.
 * The model is downloaded once into FishMem's user-data directory and then
 * remains usable offline.
 */
export class LocalE5Embedder implements Embedder {
  readonly dimensions = DIMENSIONS;
  readonly model = `${MODEL_ID}@${MODEL_REVISION}`;

  private extractor?: Promise<FeatureExtractor>;
  private state_: LocalEmbeddingState = { phase: "idle" };

  constructor(private readonly cacheDirectory: string) {}

  get state(): LocalEmbeddingState {
    return this.state_;
  }

  async prepare(): Promise<void> {
    await this.getExtractor();
  }

  async embed(text: string, options?: EmbeddingOptions): Promise<number[]> {
    const [embedding] = await this.embedBatch([text], options);
    return embedding!;
  }

  async embedBatch(
    texts: string[],
    options?: EmbeddingOptions,
  ): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extractor = await this.getExtractor();
    const inputs = texts.map((text) => `${prefixFor(options)}${text.trim()}`);
    const output = await extractor(inputs, {
      pooling: "mean",
      normalize: true,
    });
    const values = Array.from(output.data as Float32Array);
    return inputs.map((_, index) =>
      values.slice(index * DIMENSIONS, (index + 1) * DIMENSIONS),
    );
  }

  private getExtractor(): Promise<FeatureExtractor> {
    if (!this.extractor) {
      env.cacheDir = this.cacheDirectory;
      env.allowRemoteModels = true;
      this.state_ = { phase: "downloading" };
      this.extractor = pipeline("feature-extraction", MODEL_ID, {
        revision: MODEL_REVISION,
        dtype: "q8",
        cache_dir: this.cacheDirectory,
        progress_callback: (event: unknown) => {
          const progress = readProgress(event);
          this.state_ =
            progress === undefined
              ? { phase: "downloading" }
              : { phase: "downloading", progress };
        },
      })
        .then((extractor) => {
          this.state_ = { phase: "ready" };
          return extractor;
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          this.state_ = { phase: "error", message };
          this.extractor = undefined;
          throw new Error(`Local embedding model could not be loaded: ${message}`, {
            cause: error,
          });
        });
    }
    return this.extractor;
  }
}

function prefixFor(options?: EmbeddingOptions): "query: " | "passage: " {
  const operation = options?.context?.operation ?? "";
  return operation.includes("search") || operation.includes("query")
    ? "query: "
    : "passage: ";
}

function readProgress(event: unknown): number | undefined {
  if (!event || typeof event !== "object") return undefined;
  const value = (event as { progress?: unknown }).progress;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(100, value));
}
