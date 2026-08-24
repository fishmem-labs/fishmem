import type { Message } from "../types.js";
import type { LLM, LLMChatOptions, ProviderUsageHandler } from "./base.js";

export interface OpenAILLMConfig {
  apiKey?: string;
  model?: string;
  baseURL?: string;
  temperature?: number;
  /** Reasoning budget for models that support Chat Completions reasoning. */
  reasoningEffort?: OpenAIReasoningEffort;
  onUsage?: ProviderUsageHandler;
  timeoutMs?: number;
  maxRetries?: number;
}

export type OpenAIReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

/**
 * OpenAI chat-completions LLM (also works with OpenAI-compatible endpoints via
 * `baseURL`). The `openai` package is an optional, lazily-imported peer dep.
 */
export class OpenAILLM implements LLM {
  private readonly model: string;
  private readonly apiKey: string;
  private readonly baseURL?: string;
  private readonly temperature: number;
  private readonly reasoningEffort?: OpenAIReasoningEffort;
  private client: unknown;
  private readonly onUsage?: ProviderUsageHandler;
  private readonly timeoutMs?: number;
  private readonly maxRetries?: number;

  constructor(config: OpenAILLMConfig = {}) {
    this.model = config.model ?? "gpt-4o-mini";
    this.apiKey = config.apiKey ?? process.env.OPENAI_API_KEY ?? "";
    this.baseURL = config.baseURL;
    this.temperature = config.temperature ?? 0;
    this.reasoningEffort = config.reasoningEffort;
    this.onUsage = config.onUsage;
    this.timeoutMs = config.timeoutMs;
    this.maxRetries = config.maxRetries;
    if (!this.apiKey) {
      throw new Error(
        "OpenAILLM requires an API key (config.apiKey or OPENAI_API_KEY).",
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
        "The 'openai' package is required for OpenAILLM. Install it: npm i openai",
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

  async chat(messages: Message[], options?: LLMChatOptions): Promise<string> {
    const client = await this.getClient();
    const params: Record<string, unknown> = {
      model: this.model,
      temperature: options?.temperature ?? this.temperature,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    };
    if (this.reasoningEffort) {
      params.reasoning_effort = this.reasoningEffort;
    }
    if (options?.maxTokens) params.max_tokens = options.maxTokens;
    if (options?.responseFormat === "json") {
      params.response_format = options.jsonSchema
        ? {
            type: "json_schema",
            json_schema: options.jsonSchema,
          }
        : { type: "json_object" };
    }
    const startedAt = Date.now();
    const res = await client.chat.completions.create(params);
    await this.onUsage?.({
      provider: "openai",
      model: this.model,
      kind: "chat",
      inputTokens: Number(res.usage?.prompt_tokens ?? 0),
      outputTokens: Number(res.usage?.completion_tokens ?? 0),
      latencyMs: Date.now() - startedAt,
      context: options?.context,
    });
    const choice = res.choices[0];
    const refusal = choice?.message?.refusal;
    if (refusal) {
      throw new Error(`OpenAI refused the structured response: ${refusal}`);
    }
    if (
      choice?.finish_reason &&
      choice.finish_reason !== "stop" &&
      choice.finish_reason !== "tool_calls"
    ) {
      throw new Error(
        `OpenAI response did not complete: finish_reason=${choice.finish_reason}`,
      );
    }
    return choice?.message?.content ?? "";
  }
}
