import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractLocomoSystemCheckpoint } from "../extract-locomo-checkpoint.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("extractLocomoSystemCheckpoint", () => {
  it("filters one system and rewrites both checkpoint fingerprints", () => {
    const dir = mkdtempSync(join(tmpdir(), "fishmem-checkpoint-test-"));
    dirs.push(dir);
    const source = join(dir, "source.json");
    const target = join(dir, "target.json");
    const meta = {
      systems: ["fishmem", "mem0"],
      systemVersions: { fishmem: "fish-v1", mem0: "mem0-v1" },
      split: "full",
    };
    const questionMeta = { ...meta, granularity: "question" };
    writeFileSync(
      `${source}.partial.jsonl`,
      `${JSON.stringify({ __meta__: meta, fingerprint: "old" })}\n${JSON.stringify({ key: "fishmem:conv-1", value: { score: 1 } })}\n${JSON.stringify({ key: "mem0:conv-1", value: { score: 0 } })}\n`,
    );
    writeFileSync(
      `${source}.questions.partial.jsonl`,
      `${JSON.stringify({ __meta__: questionMeta, fingerprint: "old-q" })}\n${JSON.stringify({ key: "fishmem:conv-1:0", value: { score: 1 } })}\n${JSON.stringify({ key: "mem0:conv-1:0", value: { score: 0 } })}\n`,
    );

    expect(
      extractLocomoSystemCheckpoint({
        sourceOut: source,
        targetOut: target,
        system: "fishmem",
        expectedUnits: 1,
      }),
    ).toEqual({ units: 1, questions: 1 });

    const unitLines = readFileSync(`${target}.partial.jsonl`, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const questionLines = readFileSync(
      `${target}.questions.partial.jsonl`,
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(unitLines[0].__meta__).toMatchObject({
      systems: ["fishmem"],
      systemVersions: { fishmem: "fish-v1" },
    });
    expect(unitLines[0].fingerprint).not.toBe("old");
    expect(unitLines.slice(1).map((row) => row.key)).toEqual([
      "fishmem:conv-1",
    ]);
    expect(questionLines[0].__meta__.granularity).toBe("question");
    expect(questionLines[0].fingerprint).not.toBe("old-q");
    expect(questionLines.slice(1).map((row) => row.key)).toEqual([
      "fishmem:conv-1:0",
    ]);
  });

  it("refuses incomplete extraction and target overwrites", () => {
    const dir = mkdtempSync(join(tmpdir(), "fishmem-checkpoint-test-"));
    dirs.push(dir);
    const source = join(dir, "source.json");
    const target = join(dir, "target.json");
    const meta = {
      systems: ["fishmem"],
      systemVersions: { fishmem: "fish-v1" },
    };
    const header = JSON.stringify({ __meta__: meta, fingerprint: "old" });
    writeFileSync(`${source}.partial.jsonl`, `${header}\n`);
    writeFileSync(
      `${source}.questions.partial.jsonl`,
      `${JSON.stringify({ __meta__: { ...meta, granularity: "question" }, fingerprint: "old-q" })}\n`,
    );
    expect(() =>
      extractLocomoSystemCheckpoint({
        sourceOut: source,
        targetOut: target,
        system: "fishmem",
        expectedUnits: 1,
      }),
    ).toThrow("expected 1 fishmem units, found 0");
    writeFileSync(target, "occupied");
    expect(() =>
      extractLocomoSystemCheckpoint({
        sourceOut: source,
        targetOut: target,
        system: "fishmem",
      }),
    ).toThrow("refusing to overwrite");
  });
});
