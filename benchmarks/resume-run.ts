import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeJsonAtomic } from "./atomic-file.js";
import { parseIntegerOption } from "./cli.js";

type ProgressSummary = {
  status: string;
  updatedAt?: string;
  error?: string;
  systems: Array<{
    system: string;
    completed: number;
    total: number;
    failedCalls: number;
  }>;
};

type Attempt = {
  number: number;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  before?: ProgressSummary;
  after?: ProgressSummary;
  outcome?: "success" | "failed" | "interrupted" | "recovered-interruption";
};

type AttemptLedger = {
  schemaVersion: "benchmark-resume-v1";
  command: string[];
  startedAt: string;
  updatedAt: string;
  status: "running" | "complete" | "exhausted" | "interrupted";
  attempts: Attempt[];
};

export async function runResumeLoop(argv: string[]): Promise<number> {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const separator = args.indexOf("--");
  if (separator < 0 || separator === args.length - 1) {
    throw new Error(
      "usage: resume-run --progress PATH --max-attempts N [--delay-ms N] -- <command...>",
    );
  }
  const options = args.slice(0, separator);
  const command = args.slice(separator + 1);
  const progressPath = option(options, "progress");
  const maxAttempts = parseIntegerOption(
    option(options, "max-attempts"),
    "--max-attempts",
    1,
  );
  const delayMs = parseIntegerOption(
    option(options, "delay-ms", "5000"),
    "--delay-ms",
    0,
  );
  if (!command.includes("--resume")) {
    throw new Error("resumed benchmark command must include --resume");
  }

  const ledgerPath = `${progressPath.replace(/\.progress\.json$/, "")}.attempts.json`;
  const ledger = loadLedger(ledgerPath, command);
  if (recoverInterruptedAttempt(ledger, progressPath)) {
    persistLedger(ledgerPath, ledger, "interrupted");
  }
  let child: ChildProcess | undefined;
  let interrupted = false;
  const forward = (signal: NodeJS.Signals) => {
    interrupted = true;
    child?.kill(signal);
  };
  const onSigint = () => forward("SIGINT");
  const onSigterm = () => forward("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  try {
    for (let index = 0; index < maxAttempts; index++) {
      const attempt: Attempt = {
        number: ledger.attempts.length + 1,
        startedAt: new Date().toISOString(),
        before: readProgress(progressPath),
      };
      ledger.attempts.push(attempt);
      persistLedger(ledgerPath, ledger, "running");
      process.stdout.write(
        `\n===== benchmark resume attempt ${attempt.number} =====\n`,
      );

      const result = await runChild(command, (running) => {
        child = running;
      });
      child = undefined;
      attempt.finishedAt = new Date().toISOString();
      attempt.exitCode = result.exitCode;
      attempt.signal = result.signal;
      attempt.after = readProgress(progressPath);

      if (interrupted) {
        attempt.outcome = "interrupted";
        persistLedger(ledgerPath, ledger, "interrupted");
        return 130;
      }
      if (result.exitCode === 0) {
        attempt.outcome = "success";
        persistLedger(ledgerPath, ledger, "complete");
        return 0;
      }
      attempt.outcome = "failed";
      persistLedger(
        ledgerPath,
        ledger,
        index + 1 === maxAttempts ? "exhausted" : "running",
      );
      if (index + 1 < maxAttempts && delayMs > 0) await sleep(delayMs);
    }
    return 1;
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
}

function recoverInterruptedAttempt(
  ledger: AttemptLedger,
  progressPath: string,
): boolean {
  const attempt = ledger.attempts.at(-1);
  if (!attempt || attempt.finishedAt !== undefined) return false;
  attempt.finishedAt = new Date().toISOString();
  attempt.exitCode = null;
  attempt.signal = null;
  attempt.after = readProgress(progressPath);
  attempt.outcome = "recovered-interruption";
  return true;
}

function option(args: string[], name: string, fallback?: string): string {
  const index = args.indexOf(`--${name}`);
  const value = index >= 0 ? args[index + 1] : fallback;
  if (!value || value.startsWith("--")) {
    throw new Error(`--${name} requires a value`);
  }
  return value;
}

function loadLedger(path: string, command: string[]): AttemptLedger {
  if (!existsSync(path)) {
    const now = new Date().toISOString();
    return {
      schemaVersion: "benchmark-resume-v1",
      command,
      startedAt: now,
      updatedAt: now,
      status: "running",
      attempts: [],
    };
  }
  const ledger = JSON.parse(readFileSync(path, "utf8")) as AttemptLedger;
  if (JSON.stringify(ledger.command) !== JSON.stringify(command)) {
    throw new Error(`attempt ledger command mismatch: ${path}`);
  }
  return ledger;
}

function persistLedger(
  path: string,
  ledger: AttemptLedger,
  status: AttemptLedger["status"],
): void {
  ledger.status = status;
  ledger.updatedAt = new Date().toISOString();
  writeJsonAtomic(path, ledger);
}

function readProgress(path: string): ProgressSummary | undefined {
  if (!existsSync(path)) return undefined;
  const value = JSON.parse(readFileSync(path, "utf8")) as ProgressSummary;
  return {
    status: value.status,
    updatedAt: value.updatedAt,
    error: value.error,
    systems: value.systems.map((system) => ({
      system: system.system,
      completed: system.completed,
      total: system.total,
      failedCalls: system.failedCalls,
    })),
  };
}

function runChild(
  command: string[],
  started: (child: ChildProcess) => void,
): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command[0]!, command.slice(1), {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });
    started(child);
    child.once("error", reject);
    child.once("exit", (exitCode, signal) =>
      resolvePromise({ exitCode, signal }),
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  runResumeLoop(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
