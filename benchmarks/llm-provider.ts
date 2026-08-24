import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateText } from "ai";
import {
  type ReasoningEffort as CodexReasoningEffort,
  createCodexAppServer,
  createCodexExec,
} from "ai-sdk-provider-codex-cli";
import OpenAI from "openai";
import {
  type LLM,
  type LLMChatOptions,
  OpenAILLM,
} from "../packages/fishmem/src/index.js";
import type { Message } from "../packages/fishmem/src/types.js";
import type { OpenAIUsageMeter } from "./usage.js";

export type BenchmarkAnswerProvider =
  | "openai-chat"
  | "openai-responses"
  | "codex-cli";

export type BenchmarkReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type CodexTransport = "exec" | "app-server";

export interface BenchmarkLLMManifest {
  provider: BenchmarkAnswerProvider;
  model: string;
  transport:
    | "chat-completions"
    | "responses"
    | "codex-exec"
    | "codex-app-server";
  reasoningEffort: BenchmarkReasoningEffort | null;
  runtime?: {
    codexCli?: string;
    codexProviderPackage?: string;
    instructionsSha256?: string;
  };
  billing: "api" | "chatgpt-subscription";
  isolation?: {
    cwd: "ephemeral";
    threadMode: "stateless";
    sandbox: "read-only";
    tools: "disabled";
  };
  publishable: boolean;
}

export interface BenchmarkLLMHandle {
  llm: LLM;
  manifest: BenchmarkLLMManifest;
  close(): Promise<void>;
}

export interface CreateBenchmarkLLMInput {
  provider: BenchmarkAnswerProvider;
  model: string;
  apiKey: string;
  baseURL?: string;
  timeoutMs: number;
  maxRetries: number;
  reasoningEffort?: BenchmarkReasoningEffort;
  usageMeter: OpenAIUsageMeter;
  codexPath?: string;
  codexTransport?: CodexTransport;
}

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const CODEX_BENCHMARK_BASE_INSTRUCTIONS =
  "Complete the isolated language-model benchmark prompt. Do not inspect files, use tools, browse, or perform unrelated work. Follow the supplied prompt and return only the requested answer.";
const CODEX_BENCHMARK_DEVELOPER_INSTRUCTIONS =
  "This is a stateless benchmark inference. Use only the supplied messages.";

/**
 * Return the provider endpoint recorded in benchmark evidence without leaking
 * URL credentials, query parameters, or fragments into result artifacts.
 */
export function benchmarkProviderEndpoint(baseURL?: string): string {
  const raw = baseURL?.trim() || DEFAULT_OPENAI_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`invalid OpenAI base URL: ${raw}`);
  }
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  const pathname = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${pathname}`;
}

export function parseBenchmarkAnswerProvider(
  value: string | undefined,
): BenchmarkAnswerProvider {
  const normalized = value?.trim() || "openai-chat";
  if (
    normalized === "openai-chat" ||
    normalized === "openai-responses" ||
    normalized === "codex-cli"
  ) {
    return normalized;
  }
  throw new Error(
    `unknown answer provider "${normalized}" (expected openai-chat|openai-responses|codex-cli)`,
  );
}

export function parseBenchmarkReasoningEffort(
  value: string | undefined,
): BenchmarkReasoningEffort | undefined {
  if (!value) return undefined;
  if (
    value === "none" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  ) {
    return value;
  }
  throw new Error(
    `unknown reasoning effort "${value}" (expected none|minimal|low|medium|high|xhigh|max)`,
  );
}

export function parseCodexTransport(value: string | undefined): CodexTransport {
  const normalized = value?.trim() || "exec";
  if (normalized === "exec" || normalized === "app-server") {
    return normalized;
  }
  throw new Error(
    `unknown Codex transport "${normalized}" (expected exec|app-server)`,
  );
}

export function createBenchmarkLLM(
  input: CreateBenchmarkLLMInput,
): BenchmarkLLMHandle {
  if (input.provider === "openai-chat") {
    if (input.reasoningEffort) {
      throw new Error(
        "--answer-reasoning requires openai-responses or codex-cli",
      );
    }
    return {
      llm: new OpenAILLM({
        apiKey: input.apiKey,
        model: input.model,
        temperature: 0,
        ...(input.baseURL ? { baseURL: input.baseURL } : {}),
        timeoutMs: input.timeoutMs,
        maxRetries: input.maxRetries,
      }),
      manifest: {
        provider: input.provider,
        model: input.model,
        transport: "chat-completions",
        reasoningEffort: null,
        billing: "api",
        publishable: true,
      },
      close: async () => {},
    };
  }

  if (input.provider === "openai-responses") {
    return {
      llm: new OpenAIResponsesLLM(input),
      manifest: {
        provider: input.provider,
        model: input.model,
        transport: "responses",
        reasoningEffort: input.reasoningEffort ?? null,
        billing: "api",
        publishable: true,
      },
      close: async () => {},
    };
  }

  if (input.reasoningEffort === "max") {
    throw new Error(
      "codex-cli provider currently supports reasoning up to xhigh, not max",
    );
  }
  const codexPath = input.codexPath ?? "codex";
  const codexTransport = input.codexTransport ?? "exec";
  const cwd = mkdtempSync(join(tmpdir(), "fishmem-benchmark-codex-"));
  const appServer =
    codexTransport === "app-server"
      ? createCodexAppServer({
          defaultSettings: {
            codexPath,
            cwd,
            approvalPolicy: "never",
            sandboxPolicy: "read-only",
            personality: "none",
            summary: "none",
            baseInstructions: CODEX_BENCHMARK_BASE_INSTRUCTIONS,
            developerInstructions: CODEX_BENCHMARK_DEVELOPER_INSTRUCTIONS,
            threadMode: "stateless",
            autoApprove: false,
            mcpServers: {},
            rmcpClient: false,
            requestTimeoutMs: input.timeoutMs,
            ...(input.reasoningEffort
              ? { effort: input.reasoningEffort as CodexReasoningEffort }
              : {}),
            configOverrides: { "tools.web_search": false },
          },
        })
      : null;
  const execProvider = appServer
    ? null
    : createCodexExec({
        defaultSettings: {
          codexPath,
          cwd,
          approvalMode: "never",
          sandboxMode: "read-only",
          skipGitRepoCheck: true,
          allowNpx: false,
          webSearch: false,
          mcpServers: {},
          rmcpClient: false,
          logger: false,
          ...(input.reasoningEffort
            ? {
                reasoningEffort: input.reasoningEffort as CodexReasoningEffort,
              }
            : {}),
        },
      });
  const model = (appServer ?? execProvider!)(input.model);
  const codexCliVersion = commandVersion(codexPath);
  const codexProviderPackage = packageVersion("ai-sdk-provider-codex-cli");
  const instructionsSha256 = createHash("sha256")
    .update(
      `${CODEX_BENCHMARK_BASE_INSTRUCTIONS}\n${CODEX_BENCHMARK_DEVELOPER_INSTRUCTIONS}`,
    )
    .digest("hex");
  const publishable =
    codexTransport === "app-server" &&
    /^gpt-\d+(?:\.\d+)+(?:-[a-z0-9.-]+)?$/i.test(input.model) &&
    codexCliVersion !== "unavailable" &&
    codexProviderPackage !== "unavailable";
  return {
    llm: new CodexCliLLM({
      model,
      modelId: input.model,
      timeoutMs: input.timeoutMs,
      maxRetries: input.maxRetries,
      usageMeter: input.usageMeter,
    }),
    manifest: {
      provider: input.provider,
      model: input.model,
      transport:
        codexTransport === "app-server" ? "codex-app-server" : "codex-exec",
      reasoningEffort: input.reasoningEffort ?? null,
      runtime: {
        codexCli: codexCliVersion,
        codexProviderPackage,
        instructionsSha256,
      },
      billing: "chatgpt-subscription",
      isolation: {
        cwd: "ephemeral",
        threadMode: "stateless",
        sandbox: "read-only",
        tools: "disabled",
      },
      publishable,
    },
    async close() {
      try {
        await appServer?.close();
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  };
}

class OpenAIResponsesLLM implements LLM {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly reasoningEffort?: BenchmarkReasoningEffort;

  constructor(input: CreateBenchmarkLLMInput) {
    this.model = input.model;
    this.reasoningEffort = input.reasoningEffort;
    this.client = new OpenAI({
      apiKey: input.apiKey,
      ...(input.baseURL ? { baseURL: input.baseURL } : {}),
      timeout: input.timeoutMs,
      maxRetries: input.maxRetries,
    });
  }

  async chat(messages: Message[], options?: LLMChatOptions): Promise<string> {
    const instructions = systemInstructions(messages, options);
    const response = await this.client.responses.create({
      model: this.model,
      input: modelMessages(messages),
      ...(instructions ? { instructions } : {}),
      ...(options?.maxTokens ? { max_output_tokens: options.maxTokens } : {}),
      ...(this.reasoningEffort
        ? { reasoning: { effort: this.reasoningEffort } as never }
        : {}),
      ...(options?.responseFormat === "json"
        ? { text: { format: { type: "json_object" } } }
        : {}),
      store: false,
    });
    return response.output_text;
  }
}

class CodexCliLLM implements LLM {
  private readonly model: Parameters<typeof generateText>[0]["model"];
  private readonly modelId: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly usageMeter: OpenAIUsageMeter;

  constructor(input: {
    model: Parameters<typeof generateText>[0]["model"];
    modelId: string;
    timeoutMs: number;
    maxRetries: number;
    usageMeter: OpenAIUsageMeter;
  }) {
    this.model = input.model;
    this.modelId = input.modelId;
    this.timeoutMs = input.timeoutMs;
    this.maxRetries = input.maxRetries;
    this.usageMeter = input.usageMeter;
  }

  async chat(messages: Message[], options?: LLMChatOptions): Promise<string> {
    try {
      const result = await generateText({
        model: this.model,
        messages: modelMessages(messages),
        ...(systemInstructions(messages, options)
          ? { system: systemInstructions(messages, options) }
          : {}),
        ...(options?.maxTokens ? { maxOutputTokens: options.maxTokens } : {}),
        maxRetries: this.maxRetries,
        abortSignal: AbortSignal.timeout(this.timeoutMs),
      });
      this.usageMeter.record({
        kind: "chat",
        model: `codex-cli:${this.modelId}`,
        inputTokens: result.usage.inputTokens,
        cachedInputTokens: result.usage.inputTokenDetails.cacheReadTokens ?? 0,
        outputTokens: result.usage.outputTokens,
        failed: false,
      });
      return result.text;
    } catch (error) {
      this.usageMeter.record({
        kind: "chat",
        model: `codex-cli:${this.modelId}`,
        failed: true,
      });
      throw error;
    }
  }
}

function systemInstructions(
  messages: Message[],
  options?: LLMChatOptions,
): string {
  const instructions = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content);
  if (options?.responseFormat === "json") {
    instructions.push("Return one valid JSON object without Markdown fences.");
  }
  return instructions.join("\n\n");
}

function modelMessages(messages: Message[]) {
  return messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "tool" ? ("user" as const) : message.role,
      content:
        message.role === "tool"
          ? `[tool output]\n${message.content}`
          : message.content,
    }));
}

function commandVersion(command: string): string {
  try {
    return execFileSync(command, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
  } catch {
    return "unavailable";
  }
}

function packageVersion(name: string): string {
  try {
    const require = createRequire(import.meta.url);
    const packageJson = JSON.parse(
      readFileSync(require.resolve(`${name}/package.json`), "utf8"),
    ) as { version?: string };
    return `${name}@${packageJson.version ?? "unknown"}`;
  } catch {
    return `${name}@unknown`;
  }
}
