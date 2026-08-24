import { decode, encode } from "gpt-tokenizer/encoding/cl100k_base";

/** OpenAI's documented per-input limit for the embeddings endpoint. */
export const OPENAI_EMBEDDING_INPUT_TOKEN_LIMIT = 8_192;

export interface EmbeddingRequestCapResult {
  input: Parameters<typeof fetch>[0];
  init: Parameters<typeof fetch>[1];
  truncatedInputs: number;
  maximumInputTokensBefore: number;
  maximumInputTokensAfter: number;
}

/**
 * Cap string inputs sent to OpenAI's embeddings endpoint without changing the
 * source text held by the caller. `text-embedding-3-*` and ada-002 use
 * cl100k_base; unknown models are deliberately left untouched rather than
 * applying a guessed tokenizer.
 */
export async function capOpenAIEmbeddingRequest(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<EmbeddingRequestCapResult> {
  const unchanged = (): EmbeddingRequestCapResult => ({
    input,
    init,
    truncatedInputs: 0,
    maximumInputTokensBefore: 0,
    maximumInputTokensAfter: 0,
  });
  const raw =
    typeof input === "string" || input instanceof URL ? input : input.url;
  if (
    !new URL(String(raw)).pathname.replace(/\/+$/, "").endsWith("/embeddings")
  ) {
    return unchanged();
  }

  const rewrite = (body: string) => {
    const parsed = JSON.parse(body) as Record<string, unknown> & {
      model?: string;
      input?: unknown;
    };
    if (
      parsed.model !== "text-embedding-3-small" &&
      parsed.model !== "text-embedding-3-large" &&
      parsed.model !== "text-embedding-ada-002"
    ) {
      return { body, truncatedInputs: 0, before: 0, after: 0 };
    }
    const values = Array.isArray(parsed.input) ? parsed.input : [parsed.input];
    let truncatedInputs = 0;
    let maximumInputTokensBefore = 0;
    let maximumInputTokensAfter = 0;
    const capped = values.map((value) => {
      if (typeof value !== "string") return value;
      const tokens = encode(value);
      maximumInputTokensBefore = Math.max(
        maximumInputTokensBefore,
        tokens.length,
      );
      if (tokens.length <= OPENAI_EMBEDDING_INPUT_TOKEN_LIMIT) {
        maximumInputTokensAfter = Math.max(
          maximumInputTokensAfter,
          tokens.length,
        );
        return value;
      }
      truncatedInputs++;
      maximumInputTokensAfter = Math.max(
        maximumInputTokensAfter,
        OPENAI_EMBEDDING_INPUT_TOKEN_LIMIT,
      );
      return decode(tokens.slice(0, OPENAI_EMBEDDING_INPUT_TOKEN_LIMIT));
    });
    if (truncatedInputs === 0) {
      return {
        body,
        truncatedInputs,
        before: maximumInputTokensBefore,
        after: maximumInputTokensAfter,
      };
    }
    parsed.input = Array.isArray(parsed.input) ? capped : capped[0];
    return {
      body: JSON.stringify(parsed),
      truncatedInputs,
      before: maximumInputTokensBefore,
      after: maximumInputTokensAfter,
    };
  };

  if (typeof init?.body === "string") {
    const capped = rewrite(init.body);
    if (capped.truncatedInputs === 0) {
      return {
        input,
        init,
        truncatedInputs: 0,
        maximumInputTokensBefore: capped.before,
        maximumInputTokensAfter: capped.after,
      };
    }
    const headers = new Headers(init.headers);
    headers.delete("content-length");
    return {
      input,
      init: { ...init, headers, body: capped.body },
      truncatedInputs: capped.truncatedInputs,
      maximumInputTokensBefore: capped.before,
      maximumInputTokensAfter: capped.after,
    };
  }
  if (input instanceof Request && init?.body === undefined) {
    const capped = rewrite(await input.clone().text());
    if (capped.truncatedInputs === 0) {
      return {
        input,
        init,
        truncatedInputs: 0,
        maximumInputTokensBefore: capped.before,
        maximumInputTokensAfter: capped.after,
      };
    }
    const headers = new Headers(input.headers);
    headers.delete("content-length");
    return {
      input: new Request(input, { headers, body: capped.body }),
      init,
      truncatedInputs: capped.truncatedInputs,
      maximumInputTokensBefore: capped.before,
      maximumInputTokensAfter: capped.after,
    };
  }
  throw new Error(
    "embedding provider contract changed: request body is not rewritable",
  );
}
