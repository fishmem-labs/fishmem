import type { Message } from "../types.js";
import type { LLM, LLMChatOptions, ProviderUsageHandler } from "./base.js";

export interface AnthropicLLMConfig {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  onUsage?: ProviderUsageHandler;
}

/**
 * Anthropic (Claude) chat LLM. The `@anthropic-ai/sdk` package is an optional,
 * lazily-imported peer dependency.
 */
export class AnthropicLLM implements LLM {
  private readonly model: string;
  private readonly apiKey: string;
  private readonly maxTokens: number;
  private readonly temperature: number;
  private client: unknown;
  private readonly onUsage?: ProviderUsageHandler;

  constructor(config: AnthropicLLMConfig = {}) {
    this.model = config.model ?? "claude-haiku-4-5-20251001";
    this.apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "";
    this.maxTokens = config.maxTokens ?? 2048;
    this.temperature = config.temperature ?? 0;
    this.onUsage = config.onUsage;
    if (!this.apiKey) {
      throw new Error(
        "AnthropicLLM requires an API key (config.apiKey or ANTHROPIC_API_KEY).",
      );
    }
  }

  private async getClient(): Promise<any> {
    if (this.client) return this.client;
    let mod: any;
    try {
      mod = await import("@anthropic-ai/sdk");
    } catch {
      throw new Error(
        "The '@anthropic-ai/sdk' package is required for AnthropicLLM. Install it: npm i @anthropic-ai/sdk",
      );
    }
    const Anthropic = mod.default ?? mod.Anthropic ?? mod;
    this.client = new Anthropic({ apiKey: this.apiKey });
    return this.client;
  }

  async chat(messages: Message[], options?: LLMChatOptions): Promise<string> {
    const client = await this.getClient();
    // Anthropic takes system separately and only user/assistant turns.
    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    let turns = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, content: m.content }));
    if (turns.length === 0) turns = [{ role: "user", content: "" }];

    let systemPrompt = system || undefined;
    if (options?.responseFormat === "json") {
      systemPrompt =
        (systemPrompt ? `${systemPrompt}\n\n` : "") +
        "Respond with a single valid JSON object and nothing else.";
    }

    const startedAt = Date.now();
    const res = await client.messages.create({
      model: this.model,
      max_tokens: options?.maxTokens ?? this.maxTokens,
      temperature: options?.temperature ?? this.temperature,
      system: systemPrompt,
      messages: turns,
    });
    await this.onUsage?.({
      provider: "anthropic",
      model: this.model,
      kind: "chat",
      inputTokens: Number(res.usage?.input_tokens ?? 0),
      outputTokens: Number(res.usage?.output_tokens ?? 0),
      latencyMs: Date.now() - startedAt,
      context: options?.context,
    });
    const block = res.content?.[0];
    return block && block.type === "text" ? block.text : "";
  }
}
