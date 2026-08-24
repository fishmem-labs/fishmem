import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

type AttemptOutcome =
  | "success"
  | "failed"
  | "interrupted"
  | "recovered-interruption";

type AttemptLedger = {
  schemaVersion: string;
  status: string;
  attempts: Array<{
    outcome?: AttemptOutcome;
    after?: { error?: string };
  }>;
};

export interface ProcessAttemptEvidence {
  resultPath: string;
  ledgerPath: string;
  sha256: string;
  status: string;
  attempts: number;
  successful: number;
  failed: number;
  interrupted: number;
  recoveredInterruptions: number;
  incomplete: number;
  costAndWallTimeComplete: boolean;
  errors: string[];
}

export interface OperationalEvidenceAudit {
  publishable: boolean;
  gaps: string[];
  attempts: ProcessAttemptEvidence[];
}

export function readProcessAttemptEvidence(
  resultPath: string,
): ProcessAttemptEvidence | undefined {
  const ledgerPath = `${resultPath}.attempts.json`;
  if (!existsSync(ledgerPath)) return undefined;
  const content = readFileSync(ledgerPath);
  const ledger = JSON.parse(content.toString("utf8")) as unknown;
  return summarizeAttemptLedger(resultPath, ledgerPath, content, ledger);
}

export function auditOperationalEvidence(
  resultPaths: string[],
): OperationalEvidenceAudit {
  const attempts = resultPaths
    .map(readProcessAttemptEvidence)
    .filter((value): value is ProcessAttemptEvidence => value !== undefined);
  const gaps = attempts
    .filter((entry) => !entry.costAndWallTimeComplete)
    .map(
      (entry) =>
        `${entry.resultPath}: process resume ledger contains ${entry.failed} failed, ${entry.interrupted} interrupted, ${entry.recoveredInterruptions} recovered-interruption, and ${entry.incomplete} incomplete attempt(s); quality may reuse durable completed units, but total spend and wall-clock time are incomplete`,
    );
  return { publishable: gaps.length === 0, gaps, attempts };
}

export function summarizeAttemptLedger(
  resultPath: string,
  ledgerPath: string,
  content: Uint8Array,
  input: unknown,
): ProcessAttemptEvidence {
  if (!isObject(input) || input.schemaVersion !== "benchmark-resume-v1") {
    throw new Error(`invalid benchmark attempt ledger: ${ledgerPath}`);
  }
  if (typeof input.status !== "string" || !Array.isArray(input.attempts)) {
    throw new Error(`invalid benchmark attempt ledger: ${ledgerPath}`);
  }
  const ledger = input as AttemptLedger;
  const count = (outcome: AttemptOutcome) =>
    ledger.attempts.filter((attempt) => attempt.outcome === outcome).length;
  const incomplete = ledger.attempts.filter(
    (attempt) => attempt.outcome === undefined,
  ).length;
  const failed = count("failed");
  const interrupted = count("interrupted");
  const recoveredInterruptions = count("recovered-interruption");
  return {
    resultPath,
    ledgerPath,
    sha256: createHash("sha256").update(content).digest("hex"),
    status: ledger.status,
    attempts: ledger.attempts.length,
    successful: count("success"),
    failed,
    interrupted,
    recoveredInterruptions,
    incomplete,
    costAndWallTimeComplete:
      ledger.status === "complete" &&
      failed === 0 &&
      interrupted === 0 &&
      recoveredInterruptions === 0 &&
      incomplete === 0,
    errors: [
      ...new Set(
        ledger.attempts
          .map((attempt) => attempt.after?.error)
          .filter((error): error is string => Boolean(error)),
      ),
    ].slice(0, 3),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
