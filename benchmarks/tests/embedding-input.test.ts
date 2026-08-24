import { countTokens } from "gpt-tokenizer/encoding/cl100k_base";
import { describe, expect, it } from "vitest";
import {
  capOpenAIEmbeddingRequest,
  OPENAI_EMBEDDING_INPUT_TOKEN_LIMIT,
} from "../embedding-input.js";

describe("OpenAI embedding request cap", () => {
  it("caps each known-model string input at 8192 tokens", async () => {
    const result = await capOpenAIEmbeddingRequest(
      "https://example.test/v1/embeddings",
      {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "1" },
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: ["memory ".repeat(8_192), "short"],
        }),
      },
    );
    const body = JSON.parse(String(result.init?.body)) as {
      input: string[];
    };

    expect(result).toMatchObject({
      truncatedInputs: 1,
      maximumInputTokensBefore: 8_193,
      maximumInputTokensAfter: OPENAI_EMBEDDING_INPUT_TOKEN_LIMIT,
    });
    expect(body.input.map((value) => countTokens(value))).toEqual([8_192, 1]);
    expect(new Headers(result.init?.headers).has("content-length")).toBe(false);
  });

  it("leaves in-limit requests byte-for-byte unchanged", async () => {
    const body = JSON.stringify({
      model: "text-embedding-3-small",
      input: "already safe",
    });
    const init = { method: "POST", body };
    const result = await capOpenAIEmbeddingRequest(
      "https://example.test/v1/embeddings",
      init,
    );

    expect(result.truncatedInputs).toBe(0);
    expect(result.init).toBe(init);
    expect(result.init?.body).toBe(body);
  });

  it("does not guess a tokenizer for unknown models", async () => {
    const body = JSON.stringify({
      model: "custom-embedding-model",
      input: "memory ".repeat(8_192),
    });
    const result = await capOpenAIEmbeddingRequest(
      "https://example.test/v1/embeddings",
      { method: "POST", body },
    );

    expect(result.truncatedInputs).toBe(0);
    expect(result.init?.body).toBe(body);
  });
});
