import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createAdapter,
  createDiagnosticsTracker,
  createFishmemAdapter,
  createMem0Adapter,
  type MemoryAdapter,
  withOperationTimeoutRetry,
} from "../locomo/adapters.js";
import { installOpenAIUsageMeter } from "../usage.js";

let openAIStub: Server;
let openAIBaseURL: string;

beforeAll(async () => {
  openAIStub = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      input?: string | string[];
      messages?: Array<{ content?: string }>;
      model?: string;
    };

    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/embeddings") {
      const inputs = Array.isArray(body.input)
        ? body.input
        : [body.input ?? ""];
      response.end(
        JSON.stringify({
          object: "list",
          model: body.model,
          data: inputs.map((input, index) => ({
            object: "embedding",
            index,
            embedding: embedding(input),
          })),
          usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
        }),
      );
      return;
    }

    if (request.url === "/v1/chat/completions") {
      const prompt = (body.messages ?? [])
        .map((message) => message.content ?? "")
        .join("\n");
      if (prompt.includes("force provider failure")) {
        response.statusCode = 503;
        response.end(JSON.stringify({ error: { message: "forced failure" } }));
        return;
      }
      const text = prompt.toLowerCase().includes("pnpm")
        ? "User requires pnpm for package management"
        : "User supplied a memory";
      response.end(
        JSON.stringify({
          id: "chatcmpl-contract",
          object: "chat.completion",
          created: 0,
          model: body.model,
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: JSON.stringify({
                  memory: [{ id: "0", text, attributed_to: "user" }],
                }),
              },
            },
          ],
          usage: {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2,
          },
        }),
      );
      return;
    }

    response.statusCode = 404;
    response.end(JSON.stringify({ error: `unexpected path ${request.url}` }));
  });

  await new Promise<void>((resolve) =>
    openAIStub.listen(0, "127.0.0.1", resolve),
  );
  const address = openAIStub.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind OpenAI contract-test server");
  }
  openAIBaseURL = `http://127.0.0.1:${address.port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    openAIStub.close((error) => (error ? reject(error) : resolve())),
  );
});

const adapters: Array<{
  name: string;
  create: () => Promise<MemoryAdapter>;
}> = [
  {
    name: "fishmem",
    create: () =>
      createFishmemAdapter({
        llmModel: "mock",
        embedderModel: "mock",
        apiKey: "contract-test",
        mock: true,
      }),
  },
  {
    name: "mem0",
    create: () =>
      createMem0Adapter({
        llmModel: "gpt-4o-mini",
        embedderModel: "text-embedding-3-small",
        apiKey: "contract-test",
        baseURL: openAIBaseURL,
        usageScope: "mem0/contract",
        providerFetch: globalThis.fetch,
        runWithUsageScope: async (_scope, operation) => operation(),
      }),
  },
];

describe.each(adapters)("$name MemoryAdapter contract", ({ create }) => {
  it("writes and retrieves within the requested tenant and topK", async () => {
    const adapter = await create();
    try {
      await adapter.init();
      await adapter.init();
      const created = await adapter.add(
        [{ role: "user", content: "This repository requires pnpm, not npm." }],
        "tenant-a",
      );
      expect(created).toBeGreaterThan(0);

      const own = await adapter.search(
        "Which package manager is required?",
        "tenant-a",
        1,
      );
      expect(own).toHaveLength(1);
      expect(own[0]?.text.toLowerCase()).toContain("pnpm");

      const other = await adapter.search(
        "Which package manager is required?",
        "tenant-b",
        1,
      );
      expect(other).toEqual([]);
      expect(adapter.drainDiagnostics()).toEqual({
        warningCounts: {},
        retries: 0,
        timeouts: 0,
      });
    } finally {
      await adapter.close();
    }
  });
});

describe("mem0 benchmark metering contract", () => {
  it("applies a separate deadline to a complete adapter operation", async () => {
    const diagnostics = createDiagnosticsTracker();
    await expect(
      withOperationTimeoutRetry(
        () => new Promise<never>(() => {}),
        "test.operation",
        diagnostics,
        5,
        0,
      ),
    ).rejects.toThrow("test.operation timed out after 5ms");
    expect(diagnostics.drain()).toEqual({
      warningCounts: {},
      retries: 0,
      timeouts: 1,
    });
  });

  it("routes mem0's internal providers through the scoped transport", async () => {
    const meter = installOpenAIUsageMeter();
    const scope = "mem0/contract-meter";
    const adapter = await createAdapter("mem0", {
      llmModel: "gpt-4o-mini",
      embedderModel: "text-embedding-3-small",
      apiKey: "contract-test",
      baseURL: openAIBaseURL,
      usageScope: scope,
      providerFetch: globalThis.fetch,
      runWithUsageScope: meter.run,
    });
    try {
      await adapter.init();
      await adapter.add(
        [{ role: "user", content: "This repository requires pnpm." }],
        "meter-tenant",
      );
      await adapter.search("Which package manager?", "meter-tenant", 1);
      expect(meter.summary(scope)).toMatchObject({
        llmCalls: expect.any(Number),
        embeddingCalls: expect.any(Number),
        unscopedCalls: 0,
        unmeteredCalls: 0,
        unpricedCalls: 0,
        failedCalls: 0,
      });
      expect(meter.summary(scope).llmCalls).toBeGreaterThan(0);
      expect(meter.summary(scope).embeddingCalls).toBeGreaterThan(0);
    } finally {
      await adapter.close();
      meter.restore();
    }
  });

  it("rejects an add when mem0 swallows an internal provider failure", async () => {
    const adapter = await createMem0Adapter({
      llmModel: "gpt-4o-mini",
      embedderModel: "text-embedding-3-small",
      apiKey: "contract-test",
      baseURL: openAIBaseURL,
      providerFetch: globalThis.fetch,
      providerRetries: 2,
    });
    try {
      await expect(
        adapter.add(
          [{ role: "user", content: "force provider failure" }],
          "failed-provider-tenant",
        ),
      ).rejects.toThrow(
        "mem0.add had 1 failed provider call(s): POST /v1/chat/completions: HTTP 503",
      );
      expect(adapter.drainDiagnostics()).toEqual({
        warningCounts: { mem0_provider_failure: 1 },
        retries: 0,
        timeouts: 0,
      });
    } finally {
      await adapter.close();
    }
  });
});

function embedding(text: string): number[] {
  const vector = new Array<number>(1536).fill(0);
  vector[0] = 1;
  if (text.toLowerCase().includes("pnpm")) vector[1] = 1;
  return vector;
}
