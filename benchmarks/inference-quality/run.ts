import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  FACT_EXTRACTION_SYSTEM,
  InMemoryGraphStore,
  InMemoryVectorStore,
  type LLM,
  Memory,
  MockEmbedder,
  MockLLM,
  OpenAILLM,
  type ProviderUsage,
  SELECTIVE_FACT_EXTRACTION_SYSTEM,
} from "../../packages/fishmem/src/index.js";
import { parseIntegerOption } from "../cli.js";
import { INFERENCE_QUALITY_CASES } from "./cases.js";
import {
  evaluateInferenceCase,
  summarizeInferenceQuality,
} from "./evaluate.js";
import {
  INFERENCE_QUALITY_DATASET_VERSION,
  INFERENCE_QUALITY_SCHEMA_VERSION,
  type InferenceCaseResult,
  type InferencePromptRun,
  type InferenceQualityCase,
  type InferenceQualityRun,
} from "./schema.js";

type Usage = InferencePromptRun["usage"];

function valueAfter(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function transcript(testCase: InferenceQualityCase): string {
  return testCase.messages
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n");
}

function promptHash(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createRuntime(input: {
  smoke: boolean;
  model: string;
  baseURL?: string;
}): { llm: LLM; usage: Usage } {
  const usage: Usage = {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: 0,
  };
  if (input.smoke) {
    const casesByTranscript = new Map(
      INFERENCE_QUALITY_CASES.map((testCase) => [
        transcript(testCase),
        testCase,
      ]),
    );
    return {
      usage,
      llm: new MockLLM((messages) => {
        usage.calls++;
        const content = [...messages]
          .reverse()
          .find((message) => message.role === "user")?.content;
        const testCase = content ? casesByTranscript.get(content) : undefined;
        if (!testCase) throw new Error("smoke received an unknown transcript");
        return JSON.stringify({
          facts: testCase.required.map((required) => required.oracle),
        });
      }),
    };
  }

  const recordUsage = (event: ProviderUsage) => {
    usage.calls++;
    usage.inputTokens += event.inputTokens;
    usage.outputTokens += event.outputTokens;
    usage.latencyMs += event.latencyMs;
  };
  return {
    usage,
    llm: new OpenAILLM({
      model: input.model,
      baseURL: input.baseURL,
      temperature: 0,
      timeoutMs: 60_000,
      // A complete v1 A/B is explicitly bounded to 19 cases x 2 prompts.
      // Record a failed case instead of silently spending extra provider calls.
      maxRetries: 0,
      onUsage: recordUsage,
    }),
  };
}

async function runCase(input: {
  testCase: InferenceQualityCase;
  promptId: InferencePromptRun["id"];
  prompt: string;
  llm: LLM;
}): Promise<InferenceCaseResult> {
  const startedAt = performance.now();
  const memory = await Memory.create({
    embedder: new MockEmbedder(64),
    llm: input.llm,
    vectorStore: new InMemoryVectorStore(),
    graphStore: new InMemoryGraphStore(),
    customFactExtractionPrompt: input.prompt,
  });
  try {
    const added = await memory.add(input.testCase.messages, {
      namespaceId: `inference-quality:${input.promptId}:${input.testCase.id}`,
    });
    const facts = [];
    for (const result of added.results) {
      const record = await memory.get(result.id);
      if (!record) {
        throw new Error(`created memory ${result.id} is missing`);
      }
      facts.push({
        text: record.content,
        memoryType: record.memoryType,
        ...(record.subject ? { subject: record.subject } : {}),
        ...(record.attribute ? { attribute: record.attribute } : {}),
      });
    }
    return evaluateInferenceCase({
      testCase: input.testCase,
      facts,
      latencyMs: Math.round(performance.now() - startedAt),
    });
  } catch (error) {
    return evaluateInferenceCase({
      testCase: input.testCase,
      facts: [],
      latencyMs: Math.round(performance.now() - startedAt),
      error: errorMessage(error),
    });
  } finally {
    await memory.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const smoke = args.includes("--smoke");
  const live = args.includes("--live");
  if (smoke === live) {
    throw new Error(
      "choose exactly one mode: --smoke (offline) or --live (provider calls may incur charges)",
    );
  }
  const model = smoke
    ? "mock"
    : (valueAfter(args, "--model") ??
      process.env.FISHMEM_EVAL_LLM_MODEL ??
      "gpt-4o-mini");
  const baseURL =
    valueAfter(args, "--base-url") ?? process.env.OPENAI_BASE_URL ?? undefined;
  const limitValue = valueAfter(args, "--limit");
  const limit = limitValue
    ? parseIntegerOption(limitValue, "--limit", 1)
    : INFERENCE_QUALITY_CASES.length;
  const testCases = INFERENCE_QUALITY_CASES.slice(0, limit);
  const specs = [
    {
      id: "baseline-exhaustive" as const,
      prompt: FACT_EXTRACTION_SYSTEM,
    },
    { id: "selective-v1" as const, prompt: SELECTIVE_FACT_EXTRACTION_SYSTEM },
  ].map((spec) => ({
    ...spec,
    ...createRuntime({ smoke, model, baseURL }),
    results: [] as InferenceCaseResult[],
  }));

  // Alternate prompt order per case to reduce provider-time ordering bias.
  for (let index = 0; index < testCases.length; index++) {
    const ordered = index % 2 === 0 ? specs : [...specs].reverse();
    for (const spec of ordered) {
      spec.results.push(
        await runCase({
          testCase: testCases[index]!,
          promptId: spec.id,
          prompt: spec.prompt,
          llm: spec.llm,
        }),
      );
    }
  }

  const run: InferenceQualityRun = {
    schemaVersion: INFERENCE_QUALITY_SCHEMA_VERSION,
    datasetVersion: INFERENCE_QUALITY_DATASET_VERSION,
    mode: smoke ? "smoke" : "live",
    provider: smoke ? "mock" : "openai-compatible",
    model,
    createdAt: new Date().toISOString(),
    prompts: specs.map((spec) => {
      const orderedResults = testCases.map(
        (testCase) => spec.results.find((result) => result.id === testCase.id)!,
      );
      return {
        id: spec.id,
        promptSha256: promptHash(spec.prompt),
        cases: orderedResults,
        summary: summarizeInferenceQuality(testCases, orderedResults),
        usage: spec.usage,
      };
    }),
  };
  const json = `${JSON.stringify(run, null, 2)}\n`;
  const out = valueAfter(args, "--out");
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, json);
  }
  process.stdout.write(json);
}

void main().catch((error) => {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exitCode = 1;
});
