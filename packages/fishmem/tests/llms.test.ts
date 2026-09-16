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

describe("OpenAI request shape by model family", () => {
  function stubbedLLM(model: string) {
    const llm = new OpenAILLM({ apiKey: "test", model });
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    (llm as unknown as { client: unknown }).client = {
      chat: { completions: { create } },
    };
    return { llm, create };
  }

  it("sends temperature and max_tokens to a standard chat model", async () => {
    const { llm, create } = stubbedLLM("gpt-4o-mini");

    await llm.chat([{ role: "user", content: "hi" }], { maxTokens: 256 });

    const params = create.mock.calls[0]![0];
    expect(params.temperature).toBe(0);
    expect(params.max_tokens).toBe(256);
    expect(params).not.toHaveProperty("max_completion_tokens");
  });

  it("omits temperature and budgets completion tokens for reasoning models", async () => {
    const { llm, create } = stubbedLLM("gpt-5-nano");

    await llm.chat([{ role: "user", content: "hi" }], { maxTokens: 256 });

    const params = create.mock.calls[0]![0];
    // A reasoning model treats the classic sampling pair differently, and
    // sending `max_tokens` lets hidden reasoning consume the whole budget and
    // return an empty message with finish_reason=length.
    expect(params).not.toHaveProperty("temperature");
    expect(params).not.toHaveProperty("max_tokens");
    // Hidden reasoning tokens draw from the same budget as the answer, so the
    // caller's visible-output budget must not be the ceiling.
    expect(params.max_completion_tokens).toBeGreaterThan(256);
  });

  it("floors the reasoning budget for these bounded structured tasks", async () => {
    const { llm, create } = stubbedLLM("gpt-5-nano");

    await llm.chat([{ role: "user", content: "hi" }]);

    // Reasoning tokens bill as output. Left at the provider default one small
    // extraction spent hundreds of them, so the floor is the default here.
    expect(create.mock.calls[0]![0].reasoning_effort).toBe("minimal");
  });

  it("lets a caller ask for more reasoning explicitly", async () => {
    const llm = new OpenAILLM({
      apiKey: "test",
      model: "gpt-5-nano",
      reasoningEffort: "high",
    });
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    (llm as unknown as { client: unknown }).client = {
      chat: { completions: { create } },
    };

    await llm.chat([{ role: "user", content: "hi" }]);

    expect(create.mock.calls[0]![0].reasoning_effort).toBe("high");
  });

  it("does not send a reasoning budget to a standard model", async () => {
    const { llm, create } = stubbedLLM("gpt-4o-mini");

    await llm.chat([{ role: "user", content: "hi" }]);

    expect(create.mock.calls[0]![0]).not.toHaveProperty("reasoning_effort");
  });

  it("recognises reasoning families behind an OpenAI-compatible gateway prefix", async () => {
    const { llm, create } = stubbedLLM("openai/gpt-5-mini");

    await llm.chat([{ role: "user", content: "hi" }]);

    expect(create.mock.calls[0]![0]).not.toHaveProperty("temperature");
  });
});

describe("prompt cache reporting", () => {
  function llmReturning(usage: Record<string, unknown>) {
    const onUsage = vi.fn();
    const llm = new OpenAILLM({ apiKey: "test", model: "gpt-4o-mini", onUsage });
    (llm as unknown as { client: unknown }).client = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
            usage,
          }),
        },
      },
    };
    return { llm, onUsage };
  }

  it("records the cached part of the prompt the provider reports", async () => {
    const { llm, onUsage } = llmReturning({
      prompt_tokens: 1257,
      completion_tokens: 74,
      prompt_tokens_details: { cached_tokens: 1024 },
    });

    await llm.chat([{ role: "user", content: "hi" }]);

    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 1257, cachedInputTokens: 1024 }),
    );
  });

  it("keeps an unreported cache count distinct from a confirmed zero", async () => {
    // Some OpenAI-compatible gateways omit the details block entirely. That
    // must not be recorded as "nothing was cached", or the cost basis would
    // claim a certainty it does not have.
    const unreported = llmReturning({ prompt_tokens: 1257, completion_tokens: 74 });
    await unreported.llm.chat([{ role: "user", content: "hi" }]);
    expect(unreported.onUsage.mock.calls[0]![0]).not.toHaveProperty(
      "cachedInputTokens",
    );

    const confirmedZero = llmReturning({
      prompt_tokens: 1257,
      completion_tokens: 74,
      prompt_tokens_details: { cached_tokens: 0 },
    });
    await confirmedZero.llm.chat([{ role: "user", content: "hi" }]);
    expect(confirmedZero.onUsage.mock.calls[0]![0].cachedInputTokens).toBe(0);
  });
});

describe("provider usage metering", () => {
  it("reports OpenAI chat and embedding usage with call context", async () => {
    const onUsage = vi.fn();
    const llm = new OpenAILLM({
      apiKey: "test",
      model: "chat-model",
      reasoningEffort: "none",
      onUsage,
    });
    const createChatCompletion = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 11, completion_tokens: 7 },
    });
    (llm as unknown as { client: unknown }).client = {
      chat: {
        completions: {
          create: createChatCompletion,
        },
      },
    };
    await llm.chat([{ role: "user", content: "hello" }], {
      context: { namespaceId: "workspace", operation: "test.chat" },
    });
    expect(createChatCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ reasoning_effort: "none" }),
    );

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

  it("uses strict OpenAI structured outputs when a JSON schema is supplied", async () => {
    const llm = new OpenAILLM({ apiKey: "test", model: "chat-model" });
    const create = vi.fn().mockResolvedValue({
      choices: [
        { finish_reason: "stop", message: { content: '{"facts":[]}' } },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    (llm as unknown as { client: unknown }).client = {
      chat: { completions: { create } },
    };

    await llm.chat([{ role: "user", content: "hello" }], {
      responseFormat: "json",
      jsonSchema: {
        name: "facts",
        strict: true,
        schema: {
          type: "object",
          properties: { facts: { type: "array", items: { type: "string" } } },
          required: ["facts"],
          additionalProperties: false,
        },
      },
    } as never);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        response_format: {
          type: "json_schema",
          json_schema: expect.objectContaining({
            name: "facts",
            strict: true,
          }),
        },
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
