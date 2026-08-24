import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Header = {
  __meta__: Record<string, unknown>;
  fingerprint: string;
};

type Row = {
  key: string;
  value: unknown;
};

export function extractLocomoSystemCheckpoint(input: {
  sourceOut: string;
  targetOut: string;
  system: string;
  expectedUnits?: number;
}): { units: number; questions: number } {
  if (input.sourceOut === input.targetOut) {
    throw new Error("source and target outputs must differ");
  }
  const sourceUnitPath = `${input.sourceOut}.partial.jsonl`;
  const sourceQuestionPath = `${input.sourceOut}.questions.partial.jsonl`;
  const targetUnitPath = `${input.targetOut}.partial.jsonl`;
  const targetQuestionPath = `${input.targetOut}.questions.partial.jsonl`;
  for (const path of [sourceUnitPath, sourceQuestionPath]) {
    if (!existsSync(path))
      throw new Error(`source checkpoint not found: ${path}`);
  }
  for (const path of [targetUnitPath, targetQuestionPath, input.targetOut]) {
    if (existsSync(path)) throw new Error(`refusing to overwrite: ${path}`);
  }

  const units = readCheckpoint(sourceUnitPath);
  const questions = readCheckpoint(sourceQuestionPath);
  const selectedUnits = units.rows.filter((row) =>
    row.key.startsWith(`${input.system}:`),
  );
  const selectedQuestions = questions.rows.filter((row) =>
    row.key.startsWith(`${input.system}:`),
  );
  if (
    input.expectedUnits !== undefined &&
    selectedUnits.length !== input.expectedUnits
  ) {
    throw new Error(
      `expected ${input.expectedUnits} ${input.system} units, found ${selectedUnits.length}`,
    );
  }

  const unitMeta = singleSystemMeta(units.header.__meta__, input.system);
  const questionMeta = singleSystemMeta(
    questions.header.__meta__,
    input.system,
  );
  mkdirSync(dirname(targetUnitPath), { recursive: true });
  writeCheckpoint(targetUnitPath, unitMeta, selectedUnits);
  writeCheckpoint(targetQuestionPath, questionMeta, selectedQuestions);
  return { units: selectedUnits.length, questions: selectedQuestions.length };
}

function readCheckpoint(path: string): { header: Header; rows: Row[] } {
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  const header = parseJson<Header>(lines[0], `${path}:1`);
  if (!header.__meta__ || typeof header.fingerprint !== "string") {
    throw new Error(`invalid checkpoint header: ${path}`);
  }
  const rows = lines.slice(1).map((line, index) => {
    const row = parseJson<Row>(line, `${path}:${index + 2}`);
    if (typeof row.key !== "string") {
      throw new Error(`invalid checkpoint row key: ${path}:${index + 2}`);
    }
    return row;
  });
  return { header, rows };
}

function singleSystemMeta(
  source: Record<string, unknown>,
  system: string,
): Record<string, unknown> {
  const systems = source.systems;
  if (!Array.isArray(systems) || !systems.includes(system)) {
    throw new Error(
      `system ${system} is absent from source checkpoint metadata`,
    );
  }
  const versions = source.systemVersions;
  if (!isObject(versions) || typeof versions[system] !== "string") {
    throw new Error(`system version missing for ${system}`);
  }
  return {
    ...source,
    systems: [system],
    systemVersions: { [system]: versions[system] },
  };
}

function writeCheckpoint(
  path: string,
  meta: Record<string, unknown>,
  rows: Row[],
): void {
  const header: Header = { __meta__: meta, fingerprint: stableMeta(meta) };
  const content = [header, ...rows]
    .map((value) => JSON.stringify(value))
    .join("\n");
  writeFileSync(path, `${content}\n`);
}

function stableMeta(meta: Record<string, unknown>): string {
  return JSON.stringify(
    Object.keys(meta)
      .sort()
      .map((key) => [key, meta[key]]),
  );
}

function parseJson<T>(value: string | undefined, location: string): T {
  try {
    return JSON.parse(value ?? "") as T;
  } catch (error) {
    throw new Error(`invalid JSON at ${location}`, { cause: error });
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function option(args: string[], name: string): string {
  const index = args.indexOf(`--${name}`);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("--")) {
    throw new Error(`--${name} requires a value`);
  }
  return value;
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const args = process.argv.slice(2);
  const expected = args.includes("--expected-units")
    ? Number(option(args, "expected-units"))
    : undefined;
  if (expected !== undefined && (!Number.isInteger(expected) || expected < 0)) {
    throw new Error("--expected-units must be a non-negative integer");
  }
  const result = extractLocomoSystemCheckpoint({
    sourceOut: option(args, "source-out"),
    targetOut: option(args, "target-out"),
    system: option(args, "system"),
    ...(expected === undefined ? {} : { expectedUnits: expected }),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
