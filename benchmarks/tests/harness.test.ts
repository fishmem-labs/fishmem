import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { writeJsonAtomic } from "../atomic-file.js";
import { judgeRubric } from "../beam/judge.js";
import { openCheckpoint } from "../checkpoint.js";
import { parseIntegerOption } from "../cli.js";
import { summarizeAttemptLedger } from "../eval/attempt-ledger.js";
import { assertPublishableRun, compareEvalRuns } from "../eval/compare.js";
import { normalizeEvalRuns } from "../eval/normalize.js";
import {
  auditEvidencePortfolio,
  resultPathsFromArgs,
} from "../eval/release-gate.js";
import { parseReportArgs } from "../eval/report.js";
import { renderScorecard, writeScorecard } from "../eval/scorecard.js";
import {
  benchmarkProviderEndpoint,
  parseBenchmarkAnswerProvider,
  parseBenchmarkReasoningEffort,
  parseCodexTransport,
} from "../llm-provider.js";
import { writeBenchmarkProgress } from "../progress.js";
import { openResultCache, systemCodeVersion } from "../result-cache.js";
import { calculateRetryDelayMs, runResumeLoop } from "../resume-run.js";
import { takePerGroup } from "../sampling.js";
import { parseBenchmarkSplit, parseBenchmarkSystem } from "../system.js";
import { CONTEXT_TOKENIZER, countContextTokens } from "../tokens.js";
import {
  assertNoFailedProviderCalls,
  installOpenAIUsageMeter,
  PRICE_SNAPSHOT,
} from "../usage.js";

describe("benchmark harness integrity", () => {
  it("keeps every report artifact when --out is omitted", () => {
    expect(parseReportArgs(["first.json", "second.json", "--draft"])).toEqual({
      files: ["first.json", "second.json"],
      draft: true,
    });
    expect(
      parseReportArgs([
        "--",
        "first.json",
        "second.json",
        "--out",
        "report.md",
      ]),
    ).toEqual({
      files: ["first.json", "second.json"],
      draft: false,
      out: "report.md",
    });
  });

  it("separates durable quality evidence from incomplete process cost", () => {
    const raw = JSON.stringify({
      schemaVersion: "benchmark-resume-v1",
      status: "complete",
      attempts: [
        { outcome: "failed", after: { error: "503 upstream" } },
        { outcome: "success" },
      ],
    });
    expect(
      summarizeAttemptLedger(
        "run.json",
        "run.json.attempts.json",
        Buffer.from(raw),
        JSON.parse(raw),
      ),
    ).toMatchObject({
      attempts: 2,
      successful: 1,
      failed: 1,
      costAndWallTimeComplete: false,
      errors: ["503 upstream"],
    });
  });

  it("backs process retries off exponentially with a bounded jitter", () => {
    expect(calculateRetryDelayMs(5_000, 60_000, 1_000, 1, () => 0)).toBe(5_000);
    expect(calculateRetryDelayMs(5_000, 60_000, 1_000, 2, () => 1)).toBe(
      11_000,
    );
    expect(calculateRetryDelayMs(5_000, 60_000, 1_000, 99, () => 1)).toBe(
      60_000,
    );
  });

  it("records a sanitized provider endpoint", () => {
    expect(benchmarkProviderEndpoint()).toBe("https://api.openai.com/v1");
    expect(
      benchmarkProviderEndpoint(
        "https://user:secret@example.com/openai/v1/?api-version=secret#token",
      ),
    ).toBe("https://example.com/openai/v1");
  });

  it("bounds process-level resumes and persists an atomic attempt ledger", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fishmem-resume-"));
    const progress = join(dir, "run.progress.json");
    const script = join(dir, "fail.mjs");
    writeFileSync(script, "process.exit(7);\n");
    try {
      const code = await runResumeLoop([
        "--progress",
        progress,
        "--max-attempts",
        "2",
        "--delay-ms",
        "0",
        "--",
        process.execPath,
        script,
        "--resume",
      ]);
      expect(code).toBe(1);
      expect(
        JSON.parse(readFileSync(join(dir, "run.attempts.json"), "utf8")),
      ).toMatchObject({
        status: "exhausted",
        attempts: [
          { number: 1, exitCode: 7 },
          { number: 2, exitCode: 7 },
        ],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recovers an unfinished ledger attempt before starting another", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fishmem-resume-stale-"));
    const progress = join(dir, "run.progress.json");
    const ledger = join(dir, "run.attempts.json");
    const script = join(dir, "pass.mjs");
    const command = [process.execPath, script, "--resume"];
    writeFileSync(script, "process.exit(0);\n");
    writeFileSync(
      ledger,
      JSON.stringify({
        schemaVersion: "benchmark-resume-v1",
        command,
        startedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        status: "running",
        attempts: [{ number: 1, startedAt: "2026-01-01T00:00:00.000Z" }],
      }),
    );
    try {
      expect(
        await runResumeLoop([
          "--progress",
          progress,
          "--max-attempts",
          "1",
          "--delay-ms",
          "0",
          "--",
          ...command,
        ]),
      ).toBe(0);
      expect(JSON.parse(readFileSync(ledger, "utf8"))).toMatchObject({
        status: "complete",
        attempts: [
          { number: 1, outcome: "recovered-interruption" },
          { number: 2, outcome: "success", exitCode: 0 },
        ],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to checkpoint a unit with a swallowed provider failure", () => {
    const usage = completeUsage(1, 1, 0.01);
    usage.failedCalls = 1;
    expect(() => assertNoFailedProviderCalls(usage, "unit-1")).toThrow(
      "unit-1 had 1 failed provider call(s); unit was not checkpointed",
    );
  });

  it("meters OpenAI responses by async benchmark scope", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            model: "gpt-4o-mini",
            usage: { prompt_tokens: 1_000, completion_tokens: 200 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ) as typeof fetch;
    const meter = installOpenAIUsageMeter();
    try {
      await meter.run("fishmem/answer", () =>
        fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
        }),
      );
      expect(meter.summary("fishmem")).toMatchObject({
        llmCalls: 1,
        embeddingCalls: 0,
        inputTokens: 1_000,
        outputTokens: 200,
        unscopedCalls: 0,
        unmeteredCalls: 0,
        estimatedUsd: 0.00027,
      });
      expect(meter.summary("mem0").llmCalls).toBe(0);
    } finally {
      meter.restore();
      globalThis.fetch = originalFetch;
    }
  });

  it("meters Responses API token fields and current model pricing", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            model: "gpt-5.6-terra",
            usage: {
              input_tokens: 1_000,
              input_tokens_details: { cached_tokens: 200 },
              output_tokens: 100,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ) as typeof fetch;
    const meter = installOpenAIUsageMeter();
    try {
      await meter.run("fishmem/answer", () =>
        fetch("https://api.openai.com/v1/responses", { method: "POST" }),
      );
      expect(meter.summary("fishmem")).toMatchObject({
        llmCalls: 1,
        inputTokens: 1_000,
        cachedInputTokens: 200,
        outputTokens: 100,
        unmeteredCalls: 0,
        unpricedCalls: 0,
        estimatedUsd: 0.00284,
      });
    } finally {
      meter.restore();
      globalThis.fetch = originalFetch;
    }
  });

  it("records subscription-backed Codex usage inside the active scope", () => {
    const meter = installOpenAIUsageMeter();
    try {
      meter.run("fishmem/answer", () =>
        meter.record({
          kind: "chat",
          model: "codex-cli:gpt-5.5",
          inputTokens: 40,
          outputTokens: 5,
          failed: false,
        }),
      );
      expect(meter.summary("fishmem")).toMatchObject({
        llmCalls: 1,
        inputTokens: 40,
        outputTokens: 5,
        unpricedCalls: 1,
      });
      expect(meter.summary("mem0").llmCalls).toBe(0);
    } finally {
      meter.restore();
    }
  });

  it("keeps a priced API subtotal alongside unpriced Codex usage", () => {
    const meter = installOpenAIUsageMeter();
    try {
      meter.run("fishmem/mixed", () => {
        meter.record({
          kind: "chat",
          model: "gpt-5.6-luna",
          inputTokens: 1_000,
          outputTokens: 100,
          failed: false,
        });
        meter.record({
          kind: "chat",
          model: "codex-cli:gpt-5.6-sol",
          inputTokens: 10_000,
          outputTokens: 100,
          failed: false,
        });
      });
      expect(meter.summary("fishmem")).toMatchObject({
        llmCalls: 2,
        unpricedCalls: 1,
        estimatedUsd: 0.00032,
      });
    } finally {
      meter.restore();
    }
  });

  it("separates failed provider attempts from billable usage", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: "upstream" } }), {
          status: 502,
          headers: { "content-type": "application/json" },
        }),
    ) as typeof fetch;
    const meter = installOpenAIUsageMeter();
    try {
      await meter.run("fishmem/answer", () =>
        fetch("https://api.openai.com/v1/chat/completions", { method: "POST" }),
      );
      expect(meter.summary("fishmem")).toMatchObject({
        llmCalls: 0,
        failedCalls: 1,
        unmeteredCalls: 0,
        unpricedCalls: 0,
        estimatedUsd: 0,
      });
    } finally {
      meter.restore();
      globalThis.fetch = originalFetch;
    }
  });

  it("meters provider transport exceptions as failed calls", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("socket closed");
    }) as typeof fetch;
    const meter = installOpenAIUsageMeter();
    try {
      await expect(
        meter.run("mem0/memory", () =>
          fetch("https://api.openai.com/v1/embeddings", { method: "POST" }),
        ),
      ).rejects.toThrow("socket closed");
      expect(meter.summary("mem0")).toMatchObject({
        embeddingCalls: 0,
        failedCalls: 1,
        estimatedUsd: 0,
      });
    } finally {
      meter.restore();
      globalThis.fetch = originalFetch;
    }
  });

  it("counts context with one disclosed tokenizer", () => {
    expect(CONTEXT_TOKENIZER).toBe("o200k_base");
    expect(countContextTokens("")).toBe(0);
    expect(countContextTokens("The user requires pnpm.")).toBeGreaterThan(0);
  });

  it("rejects invalid integer CLI options instead of silently clamping", () => {
    expect(parseIntegerOption("2", "--retries", 0)).toBe(2);
    expect(() => parseIntegerOption("NaN", "--retries", 0)).toThrow(
      "--retries must be an integer >= 0",
    );
    expect(() => parseIntegerOption("-1", "--retries", 0)).toThrow();
  });

  it("accepts only explicit benchmark answer providers and reasoning efforts", () => {
    expect(parseBenchmarkAnswerProvider(undefined)).toBe("openai-chat");
    expect(parseBenchmarkAnswerProvider("codex-cli")).toBe("codex-cli");
    expect(parseBenchmarkAnswerProvider("openai-responses")).toBe(
      "openai-responses",
    );
    expect(() => parseBenchmarkAnswerProvider("codex")).toThrow(
      'unknown answer provider "codex"',
    );
    expect(parseBenchmarkReasoningEffort("medium")).toBe("medium");
    expect(parseBenchmarkReasoningEffort(undefined)).toBeUndefined();
    expect(() => parseBenchmarkReasoningEffort("ultra")).toThrow(
      'unknown reasoning effort "ultra"',
    );
    expect(parseCodexTransport(undefined)).toBe("exec");
    expect(parseCodexTransport("app-server")).toBe("app-server");
    expect(() => parseCodexTransport("stdio")).toThrow(
      'unknown Codex transport "stdio"',
    );
  });

  it("takes a stable stratified sample without reordering items", () => {
    const items = ["a1", "a2", "b1", "a3", "b2", "c1"];
    expect(takePerGroup(items, 2, (item) => item[0]!)).toEqual([
      "a1",
      "a2",
      "b1",
      "b2",
      "c1",
    ]);
    expect(() => takePerGroup(items, 0, (item) => item[0]!)).toThrow(
      "positive integer",
    );
  });

  it("accepts only explicitly supported benchmark systems", () => {
    expect(parseBenchmarkSystem("fishmem")).toBe("fishmem");
    expect(parseBenchmarkSystem("mem0")).toBe("mem0");
    expect(() => parseBenchmarkSystem("memo")).toThrow(
      'unknown benchmark system "memo"',
    );
  });

  it("requires every non-smoke run to declare its dataset split", () => {
    expect(parseBenchmarkSplit(undefined, true)).toBe("smoke");
    expect(parseBenchmarkSplit("holdout", false)).toBe("holdout");
    expect(() => parseBenchmarkSplit(undefined, false)).toThrow(
      "--split dev|holdout|full is required",
    );
  });

  it("rejects a corrupt checkpoint header", () => {
    const dir = mkdtempSync(join(tmpdir(), "fishmem-checkpoint-"));
    const out = join(dir, "run.json");
    writeFileSync(`${out}.partial.jsonl`, "not-json\n");
    try {
      expect(() =>
        openCheckpoint(out, { resume: true, meta: { system: "fishmem" } }),
      ).toThrow("invalid checkpoint header");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports and reruns a unit whose final checkpoint line was torn", () => {
    const dir = mkdtempSync(join(tmpdir(), "fishmem-checkpoint-"));
    const out = join(dir, "run.json");
    const meta = { system: "fishmem" };
    const checkpoint = openCheckpoint<{ value: number }>(out, {
      resume: false,
      meta,
    });
    checkpoint.record("complete", { value: 1 });
    appendFileSync(checkpoint.path, '{"key":"torn"');
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const resumed = openCheckpoint<{ value: number }>(out, {
        resume: true,
        meta,
      });
      expect(resumed.get("complete")).toEqual({ value: 1 });
      expect(resumed.has("torn")).toBe(false);
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining("torn final checkpoint line"),
      );
    } finally {
      warning.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes durable live progress artifacts with paired stage data", () => {
    const dir = mkdtempSync(join(tmpdir(), "fishmem-progress-"));
    const out = join(dir, "paired.json");
    try {
      writeBenchmarkProgress(out, {
        benchmark: "longmemeval",
        status: "running",
        startedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:01:00.000Z",
        output: out,
        systems: [
          {
            system: "fishmem",
            completed: 2,
            total: 10,
            quality: 1,
            ingestMs: 1_000,
            llmCalls: 4,
            embeddingCalls: 6,
            estimatedUsd: 0.01,
            failedCalls: 0,
            checkpoint: `${out}.fishmem.partial.jsonl`,
          },
        ],
        paired: {
          commonUnits: 1,
          fishmemQuality: 1,
          mem0Quality: 0,
          difference: 1,
        },
      });
      expect(
        JSON.parse(readFileSync(`${out}.progress.json`, "utf8")),
      ).toMatchObject({
        status: "running",
        paired: { commonUnits: 1, difference: 1 },
      });
      expect(readFileSync(`${out}.progress.md`, "utf8")).toContain(
        "delta +100.0 pt",
      );
      writeBenchmarkProgress(out, {
        ...JSON.parse(readFileSync(`${out}.progress.json`, "utf8")),
        status: "failed",
        updatedAt: "2026-01-01T00:02:00.000Z",
        error:
          "Error: instance failed <- ProviderIntegrityError: provider failed",
      });
      expect(
        JSON.parse(readFileSync(`${out}.progress.json`, "utf8")),
      ).toMatchObject({
        status: "failed",
        error: expect.stringContaining("ProviderIntegrityError"),
        systems: [{ completed: 2 }],
      });
      expect(readFileSync(`${out}.progress.md`, "utf8")).toContain(
        "Status: **failed**",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("atomically replaces final JSON without leaving a temporary file", () => {
    const dir = mkdtempSync(join(tmpdir(), "fishmem-atomic-"));
    const out = join(dir, "nested", "result.json");
    try {
      writeJsonAtomic(out, { version: 1 });
      writeJsonAtomic(out, { version: 2 });
      expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({ version: 2 });
      expect(existsSync(`${out}.tmp`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates missing scorecard output directories", () => {
    const dir = mkdtempSync(join(tmpdir(), "fishmem-scorecard-"));
    const out = join(dir, "nested", "report.md");
    try {
      writeScorecard(out, "# report\n");
      expect(readFileSync(out, "utf8")).toBe("# report\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to cache results for an unversioned system", () => {
    expect(() => systemCodeVersion("memo", process.cwd())).toThrow(
      'cannot version benchmark system "memo"',
    );
  });

  it("pins the mem0 benchmark baseline to the audited package version", () => {
    const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
    expect(systemCodeVersion("mem0", repoRoot)).toMatch(
      /^mem0ai:3\.1\.2\+adapter:[a-f0-9]{16}$/,
    );
  });

  it("reports a corrupt cache entry before treating it as a miss", () => {
    const dir = mkdtempSync(join(tmpdir(), "fishmem-cache-"));
    const cache = openResultCache<{ value: number }>({ dir, enabled: true });
    writeFileSync(join(dir, "bad.json"), "not-json");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(cache.get("bad")).toBeUndefined();
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining("Ignoring corrupt benchmark cache entry"),
      );
    } finally {
      warning.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails a BEAM unit when the official judge call fails", async () => {
    const llm = {
      async chat() {
        throw new Error("judge unavailable");
      },
    };
    await expect(
      judgeRubric(llm, "abstention", ["must abstain"], "I do not know"),
    ).rejects.toThrow("judge unavailable");
  });

  it("normalizes every LOCOMO system into the shared eval schema", () => {
    const runs = normalizeEvalRuns({
      dataset: "/tmp/locomo10.json",
      config: { smoke: false, split: "holdout" },
      systems: [
        {
          system: "fishmem",
          systemVersion: "fishmem-src:test+adapter:test",
          ingest: { failedAdds: 0, totalMs: 100, memoriesCreated: 2 },
          questions: [
            {
              sampleId: "conv-2",
              question: "Where?",
              goldAnswer: "Taipei",
              generatedAnswer: "Taipei",
              category: 4,
              judgeLabel: "CORRECT",
              searchMs: 5,
              answerMs: 10,
              contextChars: 20,
              memoriesUsed: 1,
            },
          ],
          summary: { judgeAccuracy: 1 },
        },
      ],
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      dataset: "locomo",
      split: "holdout",
      system: "fishmem",
      summary: { quality: { overall: 1 }, reliability: { failedAdds: 0 } },
    });
    expect(runs[0]?.items[0]).toMatchObject({
      id: "conv-2:0",
      score: 1,
      correct: true,
    });
  });

  it("assigns distinct stable IDs to duplicate LOCOMO questions", () => {
    const question = {
      sampleId: "conv-48",
      question: "What are the names of Jolene's snakes?",
      goldAnswer: "A and B",
      generatedAnswer: "A and B",
      category: 4,
      judgeLabel: "CORRECT",
      searchMs: 5,
      answerMs: 10,
      contextChars: 20,
      memoriesUsed: 1,
    };
    const [run] = normalizeEvalRuns({
      dataset: "/tmp/locomo10.json",
      config: { smoke: false, split: "holdout" },
      systems: [
        {
          system: "fishmem",
          ingest: { failedAdds: 0, totalMs: 100, memoriesCreated: 2 },
          questions: [question, question],
        },
      ],
    });

    expect(run?.items.map((item) => item.id)).toEqual([
      "conv-48:0",
      "conv-48:1",
    ]);
  });

  it("rejects a result that omits required cost and reliability evidence", () => {
    const [run] = normalizeEvalRuns({
      dataset: "/tmp/locomo10.json",
      config: { split: "holdout" },
      systems: [
        {
          system: "fishmem",
          systemVersion: "fishmem-src:test+adapter:test",
          ingest: { failedAdds: 0, totalMs: 100, memoriesCreated: 2 },
          questions: [
            {
              sampleId: "conv-2",
              question: "Where?",
              goldAnswer: "Taipei",
              generatedAnswer: "Taipei",
              category: 4,
              judgeLabel: "CORRECT",
              searchMs: 5,
              answerMs: 10,
              contextChars: 20,
              contextTokens: 5,
              memoriesUsed: 1,
            },
          ],
        },
      ],
    });
    expect(() => assertPublishableRun(run!)).toThrow(
      "missing required evidence metrics",
    );
  });

  it("keeps the release gate closed for a narrow single-dataset win", () => {
    expect(auditEvidencePortfolio([])).toMatchObject({
      publishable: false,
      comparisons: [],
      gaps: expect.arrayContaining([
        expect.stringContaining("locomo"),
        expect.stringContaining("longmemeval"),
        expect.stringContaining("beam"),
      ]),
    });
  });

  it("rejects tiny full-split samples as homepage evidence", () => {
    const runs = [
      ...portfolioPair("locomo", ["1", "2", "3", "4", "5"]),
      ...portfolioPair("longmemeval:oracle", [
        "knowledge-update",
        "temporal-reasoning",
        "multi-session",
        "single-session-user",
        "single-session-assistant",
        "single-session-preference",
      ]),
      ...portfolioPair("beam:100k", [
        "abstention",
        "contradiction_resolution",
        "event_ordering",
        "information_extraction",
        "instruction_following",
        "knowledge_update",
        "multi_session_reasoning",
        "preference_following",
        "summarization",
        "temporal_reasoning",
      ]),
    ];
    const audit = auditEvidencePortfolio(runs);

    expect(audit.publishable).toBe(false);
    expect(audit.gaps).toEqual(
      expect.arrayContaining([
        expect.stringContaining("at least 1,986 paired items"),
        expect.stringContaining("at least 500 paired items"),
        expect.stringContaining("at least 400 paired items"),
      ]),
    );
    expect(renderScorecard(runs.slice(0, 2))).toContain(
      "LOCOMO standard categories 1–4: 4 paired questions",
    );
  });

  it("accepts pnpm's argument separator before release-gate result paths", () => {
    expect(resultPathsFromArgs(["--", "fishmem.json", "mem0.json"])).toEqual([
      "fishmem.json",
      "mem0.json",
    ]);
  });

  it("rejects a benchmark whose result and config name different systems", () => {
    expect(() =>
      normalizeEvalRuns({
        dataset: "longmemeval_oracle.json",
        system: "fishmem",
        config: { system: "mem0", variant: "oracle" },
        results: [],
        summary: { total: 0 },
      }),
    ).toThrow("benchmark system mismatch");
  });

  it("normalizes a multi-system LongMemEval suite", () => {
    const fishmem = longMemEvalRun("fishmem");
    const mem0 = longMemEvalRun("mem0");
    const runs = normalizeEvalRuns({
      benchmark: "longmemeval",
      systems: [fishmem, mem0],
    });

    expect(runs.map((run) => run.system)).toEqual(["fishmem", "mem0"]);
    expect(runs.every((run) => run.dataset === "longmemeval:oracle")).toBe(
      true,
    );
  });

  it("uses the suite benchmark discriminator for empty BEAM results", () => {
    const runs = normalizeEvalRuns({
      benchmark: "beam",
      systems: [beamRun("fishmem"), beamRun("mem0")],
    });

    expect(runs.map((run) => run.system)).toEqual(["fishmem", "mem0"]);
    expect(runs.every((run) => run.dataset === "beam:100k")).toBe(true);
  });

  it("rejects a multi-system native suite without a benchmark discriminator", () => {
    expect(() =>
      normalizeEvalRuns({
        systems: [longMemEvalRun("fishmem"), longMemEvalRun("mem0")],
      }),
    ).toThrow("multi-system native result requires benchmark");
  });

  it("produces a strict paired scorecard", () => {
    const question = {
      sampleId: "conv-2",
      question: "Where?",
      goldAnswer: "Taipei",
      category: 4,
      searchMs: 5,
      answerMs: 10,
      contextChars: 20,
      contextTokens: 5,
      memoriesUsed: 1,
    };
    const runs = normalizeEvalRuns({
      dataset: "locomo10.json",
      config: {
        split: "holdout",
        topK: 10,
        judge: "judge-v1",
        providerEndpoint: "https://api.openai.com/v1",
        contextTokenizer: "o200k_base",
        usageSchema: "openai-response-v3",
      },
      systems: [
        {
          system: "fishmem",
          systemVersion: "fishmem-src:test+adapter:test",
          ingest: { failedAdds: 0, totalMs: 100, memoriesCreated: 2 },
          usage: completeUsage(2, 2, 0.01),
          diagnostics: { warningCounts: {}, retries: 0, timeouts: 0 },
          questions: [
            {
              ...question,
              generatedAnswer: "Taipei",
              judgeLabel: "CORRECT",
            },
          ],
        },
        {
          system: "mem0",
          systemVersion: "mem0ai:3.0.13+adapter:test",
          ingest: { failedAdds: 0, totalMs: 200, memoriesCreated: 3 },
          usage: completeUsage(3, 3, 0.02),
          diagnostics: { warningCounts: {}, retries: 0, timeouts: 0 },
          questions: [
            {
              ...question,
              generatedAnswer: "Tokyo",
              judgeLabel: "WRONG",
            },
          ],
        },
      ],
    });
    const comparison = compareEvalRuns(runs[0]!, runs[1]!);
    expect(comparison).toMatchObject({ n: 1, difference: 1 });
    expect(renderScorecard(runs)).toContain("Paired quality delta: +100.0 pt");
    expect(renderScorecard(runs)).toContain(
      "| 4 | 1 | 100.0% | 0.0% | +100.0 pt |",
    );
    expect(
      renderScorecard(runs, {
        sources: [{ path: "result.json", sha256: "abc123" }],
      }),
    ).toContain("`result.json` — SHA-256 `abc123`");
    expect(
      renderScorecard(runs, {
        draft: true,
        processAttempts: [
          {
            resultPath: "result.json",
            ledgerPath: "result.json.attempts.json",
            sha256: "ledger123",
            status: "complete",
            attempts: 2,
            successful: 1,
            failed: 1,
            interrupted: 0,
            recoveredInterruptions: 0,
            incomplete: 0,
            costAndWallTimeComplete: false,
            errors: ["503 upstream"],
          },
        ],
      }),
    ).toContain("Do not publish cost or wall-clock claims");
    runs[0]!.summary.cost.unmeteredCalls = 1;
    expect(() => assertPublishableRun(runs[0]!)).toThrow(
      "has 1 unmetered provider calls",
    );
    runs[0]!.summary.cost.unmeteredCalls = 0;
    runs[0]!.summary.cost.failedCalls = 1;
    expect(() => assertPublishableRun(runs[0]!)).toThrow(
      "has 1 failed provider calls",
    );
    expect(() => renderScorecard(runs)).toThrow("has 1 failed provider calls");
    const draft = renderScorecard(runs, { draft: true });
    expect(draft).toContain("DRAFT - NOT PUBLISHABLE");
    expect(draft).toContain("has 1 failed provider calls");
    runs[0]!.summary.cost.failedCalls = 0;
    expect(renderScorecard(runs, { draft: true })).toContain(
      "complete portfolio coverage and release gate are still required",
    );
    runs[0]!.config.answerManifest = {
      provider: "codex-cli",
      model: "gpt-5.6-luna",
      transport: "codex-app-server",
      publishable: false,
    };
    expect(() => assertPublishableRun(runs[0]!)).toThrow(
      "answer provider is marked non-publishable",
    );
  });

  it("allows a disclosed low provider retry rate", () => {
    const [run] = portfolioPair("locomo", ["1"]);
    run!.summary.cost.llmCalls = 99;
    run!.summary.cost.embeddingCalls = 1;
    run!.summary.cost.failedCalls = 1;
    expect(() => assertPublishableRun(run!)).not.toThrow();
  });

  it("allows exactly one reproducible subscription-backed Codex answer per item", () => {
    const [run] = portfolioPair("locomo", ["1"]);
    (run!.config as Record<string, unknown>).answerManifest = {
      provider: "codex-cli",
      model: "gpt-5.6-sol",
      transport: "codex-app-server",
      reasoningEffort: "none",
      runtime: {
        codexCli: "codex-cli 0.149.0",
        codexProviderPackage: "ai-sdk-provider-codex-cli@1.3.1",
        instructionsSha256: "abc123",
      },
      billing: "chatgpt-subscription",
      isolation: {
        cwd: "ephemeral",
        threadMode: "stateless",
        sandbox: "read-only",
        tools: "disabled",
      },
      publishable: true,
    };
    run!.summary.cost.unpricedCalls = 1;
    expect(() => assertPublishableRun(run!)).not.toThrow();
    expect(
      renderScorecard([run!, portfolioPair("locomo", ["1"])[1]!], {
        draft: true,
      }),
    ).toContain("ChatGPT-subscription Codex answer call per item");
  });
});

function completeUsage(
  llmCalls: number,
  embeddingCalls: number,
  estimatedUsd: number,
) {
  return {
    llmCalls,
    embeddingCalls,
    inputTokens: 10,
    cachedInputTokens: 0,
    outputTokens: 5,
    estimatedUsd,
    unscopedCalls: 0,
    unmeteredCalls: 0,
    unpricedCalls: 0,
    failedCalls: 0,
    priceSnapshot: PRICE_SNAPSHOT,
    byModel: {},
  };
}

function portfolioPair(dataset: string, categories: string[]) {
  return (["fishmem", "mem0"] as const).map((system) => ({
    dataset,
    split: "full" as const,
    system,
    config: {
      systemVersion: `${system}:test`,
      usageSchema: "openai-response-v3",
      providerEndpoint: "https://api.openai.com/v1",
    },
    items: categories.map((category, index) => ({
      id: `${dataset}:${index}`,
      category,
      question: `question ${index}`,
      answer: system === "fishmem" ? "correct" : "wrong",
      score: system === "fishmem" ? 1 : 0,
      correct: system === "fishmem",
      searchMs: 1,
      answerMs: 1,
      contextChars: 1,
      contextTokens: 1,
      memoriesUsed: 1,
      judgeErrors: 0,
    })),
    summary: {
      quality: { overall: system === "fishmem" ? 1 : 0 },
      cost: {
        ingestMs: 1,
        memoriesCreated: 1,
        ...completeUsage(1, 1, 0.01),
      },
      latency: {
        searchMsP50: 1,
        searchMsP95: 1,
        answerMsP50: 1,
        answerMsP95: 1,
      },
      context: {
        meanChars: 1,
        meanTokens: 1,
        tokenizer: "o200k_base",
      },
      reliability: {
        failedAdds: 0,
        judgeErrors: 0,
        warningCounts: {},
        retries: 0,
        timeouts: 0,
        degradationCount: 0,
      },
    },
  }));
}

function longMemEvalRun(system: "fishmem" | "mem0") {
  return {
    dataset: "longmemeval_oracle.json",
    system,
    config: {
      system,
      variant: "oracle",
      split: "dev",
      systemVersion: `${system}:test`,
      contextTokenizer: "o200k_base",
      usageSchema: "openai-response-v3",
    },
    results: [],
    summary: {
      total: 0,
      ingestTotalMs: 0,
      memoriesCreated: 0,
      diagnostics: { warningCounts: {}, retries: 0, timeouts: 0 },
    },
    usage: completeUsage(0, 0, 0),
  };
}

function beamRun(system: "fishmem" | "mem0") {
  return {
    dataset: "beam-100k",
    system,
    config: {
      system,
      variant: "100k",
      split: "dev",
      systemVersion: `${system}:test`,
      contextTokenizer: "o200k_base",
      usageSchema: "openai-response-v3",
    },
    results: [{ conversationId: "empty", questions: [] }],
    summary: {
      totalQuestions: 0,
      ingestTotalMs: 0,
      memoriesCreated: 0,
      diagnostics: { warningCounts: {}, retries: 0, timeouts: 0 },
    },
    usage: completeUsage(0, 0, 0),
  };
}
