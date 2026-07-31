/**
 * Incremental checkpoint / resume for the benchmark harnesses.
 *
 * Long runs (LongMemEval 500 instances, BEAM) only wrote their JSON at the very
 * end, so any interruption (proxy socket drop, kill, crash) lost everything.
 * This makes each independent unit of work — an instance (LongMemEval) or a
 * conversation (LOCOMO/BEAM) — crash-safe:
 *
 *   - As each unit completes, its result is appended as one line to a
 *     `<out>.partial.jsonl` sidecar (synchronous append = durable across kills).
 *   - With `--resume`, a relaunch loads that sidecar, skips already-finished
 *     units (no re-ingest, no re-spend), and continues.
 *   - A config fingerprint (meta) is the first line; resuming onto a run with a
 *     different system/variant/model set is refused, not silently mixed.
 *   - `finalize()` removes the sidecar once the final aggregated JSON is written.
 *
 * The harness picks the unit granularity (whatever is independently re-runnable
 * without redoing ingest); the value stored per key is whatever that harness
 * needs to reconstruct its result rows.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export interface Checkpoint<R> {
  /** Already-completed for this key (from a prior, resumed run)? */
  has(key: string): boolean;
  get(key: string): R | undefined;
  /** Append a completed unit's result; durable immediately. */
  record(key: string, value: R): void;
  /** How many units are already done (loaded + recorded). */
  readonly doneCount: number;
  /** Remove the sidecar (call after the final JSON is written). */
  finalize(): void;
  /** Sidecar path, for logging. */
  readonly path: string;
}

type Meta = Record<string, unknown>;

function stableMeta(meta: Meta): string {
  // Order-independent fingerprint of the run config.
  return JSON.stringify(
    Object.keys(meta)
      .sort()
      .map((k) => [k, meta[k]]),
  );
}

export function openCheckpoint<R>(
  outPath: string,
  opts: { resume: boolean; meta: Meta; enabled?: boolean },
): Checkpoint<R> {
  const path = `${outPath}.partial.jsonl`;
  const done = new Map<string, R>();
  const fingerprint = stableMeta(opts.meta);
  const enabled = opts.enabled ?? true;

  if (!enabled) {
    return {
      has: () => false,
      get: () => undefined,
      record: () => {},
      doneCount: 0,
      finalize: () => {},
      path,
    };
  }

  if (opts.resume && existsSync(path)) {
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.trim());
    const header = lines.shift();
    let headMeta: { __meta__?: Meta; fingerprint?: string };
    try {
      headMeta = JSON.parse(header ?? "");
    } catch (error) {
      throw new Error(`invalid checkpoint header: ${path}`, { cause: error });
    }
    if (!headMeta.__meta__ || !headMeta.fingerprint) {
      throw new Error(`invalid checkpoint header: ${path}`);
    }
    if (headMeta.fingerprint !== fingerprint) {
      throw new Error(
        `--resume refused: ${path} was written with a different config\n` +
          `  existing: ${JSON.stringify(headMeta.__meta__)}\n` +
          `  current:  ${JSON.stringify(opts.meta)}\n` +
          `Delete the sidecar to start fresh, or fix the flags to match.`,
      );
    }
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      try {
        const { key, value } = JSON.parse(line);
        if (key !== undefined) done.set(key, value as R);
      } catch (error) {
        if (index !== lines.length - 1) {
          throw new Error(`invalid checkpoint line ${index + 2}: ${path}`, {
            cause: error,
          });
        }
        console.warn(
          `Ignoring torn final checkpoint line in ${path}; that unit will be rerun.`,
        );
      }
    }
  } else {
    // Fresh start: (re)write the header, truncating any stale sidecar so its
    // lines can't contaminate this run.
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({ __meta__: opts.meta, fingerprint })}\n`,
    );
  }

  return {
    has: (key) => done.has(key),
    get: (key) => done.get(key),
    record(key, value) {
      if (done.has(key)) return;
      done.set(key, value);
      appendFileSync(path, `${JSON.stringify({ key, value })}\n`);
    },
    get doneCount() {
      return done.size;
    },
    finalize() {
      rmSync(path, { force: true });
    },
    path,
  };
}
