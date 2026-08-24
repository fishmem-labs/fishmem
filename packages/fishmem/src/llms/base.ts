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
