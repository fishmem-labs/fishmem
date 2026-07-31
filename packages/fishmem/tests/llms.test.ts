import { describe, expect, it, vi } from "vitest";
import { OpenAIEmbedder } from "../src/embeddings/openai.js";
import { AnthropicLLM } from "../src/llms/anthropic.js";
import { MockLLM, type MockResponder } from "../src/llms/mock.js";
import { OpenAILLM } from "../src/llms/openai.js";

describe("MockLLM", () => {
  it("extracts deterministic sentence facts for the extraction task", async () => {
    const llm = new MockLLM();

    const raw = await llm.chat(
      [
        { role: "system", content: "FISHMEM_TASK: extract" },
        { role: "user", content: "Sam likes tea. Sam lives in Berlin." },
      ],
      { responseFormat: "json" },
    );

    expect(JSON.parse(raw)).toEqual({
      facts: ["Sam likes tea", "Sam lives in Berlin"],
    });
  });

  it("passes messages and options to a scripted responder", async () => {
    let seenFormat: string | undefined;
    const responder: MockResponder = (_messages, options) => {
      seenFormat = options?.responseFormat;
      return "scripted";
    };

    const llm = new MockLLM(responder);
    await expect(
      llm.chat([{ role: "user", content: "hello" }], {
        responseFormat: "json",
      }),
    ).resolves.toBe("scripted");
    expect(seenFormat).toBe("json");
  });

  it("does not emulate the removed update-decision task", async () => {
    const llm = new MockLLM();

    const raw = await llm.chat(
      [
        { role: "system", content: "FISHMEM_TASK: update" },
        { role: "user", content: '{"facts":["Sam likes tea"]}' },
      ],
      { responseFormat: "json" },
    );

    expect(JSON.parse(raw)).toEqual({ facts: ["Sam likes tea"] });
    expect("memory" in JSON.parse(raw)).toBe(false);
  });
});

describe("provider usage metering", () => {
  it("reports OpenAI chat and embedding usage with call context", async () => {
    const onUsage = vi.fn();
    const llm = new OpenAILLM({ apiKey: "test", model: "chat-model", onUsage });
    (llm as unknown as { client: unknown }).client = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: "ok" } }],
            usage: { prompt_tokens: 11, completion_tokens: 7 },
          }),
        },
      },
    };
    await llm.chat([{ role: "user", content: "hello" }], {
      context: { namespaceId: "workspace", operation: "test.chat" },
    });

    const embedder = new OpenAIEmbedder({
      apiKey: "test",
      dimensions: 2,
      model: "embedding-model",
      onUsage,
    });
    const createEmbedding = vi.fn().mockResolvedValue({
      data: [{ embedding: [1, 0] }],
      usage: { prompt_tokens: 5, total_tokens: 5 },
    });
    (embedder as unknown as { client: unknown }).client = {
      embeddings: {
        create: createEmbedding,
      },
    };
    await embedder.embed("hello", {
      context: { namespaceId: "workspace", operation: "test.embedding" },
    });
    expect(createEmbedding).toHaveBeenCalledWith(
      expect.objectContaining({ encoding_format: "float" }),
    );

    expect(onUsage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        provider: "openai",
        model: "chat-model",
        kind: "chat",
        inputTokens: 11,
        outputTokens: 7,
        context: { namespaceId: "workspace", operation: "test.chat" },
      }),
    );
    expect(onUsage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        model: "embedding-model",
        kind: "embedding",
        inputTokens: 5,
        outputTokens: 0,
      }),
    );
  });

  it("reports Anthropic input and output usage", async () => {
    const onUsage = vi.fn();
    const llm = new AnthropicLLM({
      apiKey: "test",
      model: "claude-test",
      onUsage,
    });
    (llm as unknown as { client: unknown }).client = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 13, output_tokens: 3 },
        }),
      },
    };
    await llm.chat([{ role: "user", content: "hello" }], {
      context: { namespaceId: "workspace" },
    });
    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        inputTokens: 13,
        outputTokens: 3,
      }),
    );
  });
});
