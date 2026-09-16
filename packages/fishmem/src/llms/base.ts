import type { Message } from "../types.js";

export interface ProviderCallContext {
  namespaceId?: string;
  operation?: string;
  requestId?: string;
}

export interface ProviderUsage {
  provider: string;
  model: string;
  kind: "chat" | "embedding";
  inputTokens: number;
  /**
   * The part of `inputTokens` the provider served from its prompt cache and
   * bills at a reduced rate. Absent when the provider does not report it.
   *
   * Recorded separately because the extraction prompt is a fixed prefix
   * re-sent on every write: whether that prefix is cached decides a large
   * share of the product's cost, and the only trustworthy answer is the
   * provider's own count, not an assumption.
   */
  cachedInputTokens?: number;
  outputTokens: number;
  latencyMs: number;
  context?: ProviderCallContext;
}

export type ProviderUsageHandler = (
  usage: ProviderUsage,
) => void | Promise<void>;

export interface LLMJsonSchema {
  name: string;
  description?: string;
  schema: Record<string, unknown>;
  strict?: boolean;
}

export interface LLMChatOptions {
  /** Ask the model to return a JSON object. */
  responseFormat?: "json" | "text";
  /** Provider-enforced JSON schema when structured outputs are supported. */
  jsonSchema?: LLMJsonSchema;
  temperature?: number;
  maxTokens?: number;
  context?: ProviderCallContext;
}

/** A chat-completion LLM used for derivation, profile synthesis, and rerank. */
export interface LLM {
  /** Run a chat completion and return the assistant's text. */
  chat(messages: Message[], options?: LLMChatOptions): Promise<string>;
}
