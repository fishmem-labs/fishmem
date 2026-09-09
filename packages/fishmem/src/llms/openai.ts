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
 * Extra completion budget handed to reasoning models so hidden reasoning
 * tokens cannot starve the visible answer the caller asked for.
 */
const REASONING_TOKEN_HEADROOM = 2_048;

/**
 * Reasoning budget applied to a reasoning model when the caller names none.
 *
 * Every call this class makes is a bounded structured-output task — extract
 * facts, merge two memories, rank candidates — where the answer is short and
 * schema-constrained. Left at its default effort, a reasoning model spends
 * hundreds of hidden tokens on such a task: measured on one small extraction,
 * 896 reasoning tokens and 7.6s versus 0 tokens and 2.6s at the floor. Those
 * tokens bill as output, so the default quietly costs several times what the
 * visible answer does. Callers with a genuinely hard task set `reasoningEffort`
 * explicitly.
 */
const DEFAULT_REASONING_EFFORT: OpenAIReasoningEffort = "minimal";

/**
 * Whether a model id belongs to a reasoning family, which constrains sampling
 * parameters and renames `max_tokens`. Matching on the id keeps this working
 * for OpenAI-compatible gateways that mirror the same model names.
 */
export function isReasoningModel(model: string): boolean {
  const id = model.toLowerCase().replace(/^.*\//, "");
  return /^(gpt-5|o1|o3|o4)(\b|[-.])/.test(id);
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
    const reasoning = isReasoningModel(this.model);
    const params: Record<string, unknown> = {
      model: this.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    };
    // Reasoning models (gpt-5*, o-series) reject a custom sampling temperature
    // and renamed the completion budget. Sending the classic pair to one of
    // them fails the whole request, so the shape follows the model family.
    if (!reasoning) {
      params.temperature = options?.temperature ?? this.temperature;
    }
    const reasoningEffort =
      this.reasoningEffort ?? (reasoning ? DEFAULT_REASONING_EFFORT : undefined);
    if (reasoningEffort) {
      params.reasoning_effort = reasoningEffort;
    }
    if (options?.maxTokens) {
      // A reasoning model spends part of this budget on hidden reasoning
      // tokens, so the caller's visible-output budget must not cap the total.
      params[reasoning ? "max_completion_tokens" : "max_tokens"] =
        reasoning ? options.maxTokens + REASONING_TOKEN_HEADROOM : options.maxTokens;
    }
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
