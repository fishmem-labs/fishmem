import type { Message } from "../types.js";
import type { LLM, LLMChatOptions, ProviderUsageHandler } from "./base.js";

export interface OpenAILLMConfig {
  apiKey?: string;
  model?: string;
  baseURL?: string;
  temperature?: number;
  onUsage?: ProviderUsageHandler;
  timeoutMs?: number;
  maxRetries?: number;
}

/**
 * OpenAI chat-completions LLM (also works with OpenAI-compatible endpoints via
 * `baseURL`). The `openai` package is an optional, lazily-imported peer dep.
 */
export class OpenAILLM implements LLM {
  private readonly model: string;
  private readonly apiKey: string;
  private readonly baseURL?: string;
  private readonly temperature: number;
  private client: unknown;
  private readonly onUsage?: ProviderUsageHandler;
  private readonly timeoutMs?: number;
  private readonly maxRetries?: number;

  constructor(config: OpenAILLMConfig = {}) {
    this.model = config.model ?? "gpt-4o-mini";
    this.apiKey = config.apiKey ?? process.env.OPENAI_API_KEY ?? "";
    this.baseURL = config.baseURL;
    this.temperature = config.temperature ?? 0;
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
    if (options?.maxTokens) params.max_tokens = options.maxTokens;
    if (options?.responseFormat === "json") {
      params.response_format = { type: "json_object" };
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
    return res.choices[0]?.message?.content ?? "";
  }
}
