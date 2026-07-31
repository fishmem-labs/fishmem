/**
 * Persistent, cross-run result cache for the benchmark harness.
 *
 * The run checkpoint (`checkpoint.ts`) makes ONE run resumable. This goes
 * further: it caches each `(system × conversation)` result on disk keyed by a
 * **fingerprint** of everything that affects it — models, top-k, chunking,
 * categories, overrides, AND a per-system CODE version. So when you iterate on
 * fishmem and re-measure, the unchanged, slow baseline (mem0, a pinned npm
 * package) is reused instead of re-run; only what actually changed re-runs.
 *
 * Code version (the cache-busting part):
 *   - fishmem*: a content hash of `packages/fishmem/src` → any engine edit busts
 *     the cache for fishmem systems (so you never compare against stale results).
 *   - mem0*: the installed `mem0ai` package version (pinned → stable → reusable).
 *
 * Opt-in (`--cache`); content-addressed files under the cache dir; safe to
 * delete the dir at any time (it just forces a clean re-run).
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** Stable JSON (sorted keys) so logically-equal configs hash identically. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

/** 16-hex-char fingerprint of an arbitrary config object. */
export function fingerprint(obj: unknown): string {
  return createHash("sha256")
    .update(stableStringify(obj))
    .digest("hex")
    .slice(0, 16);
}

/** Content hash of every *.ts under a directory (sorted) — bumps when code changes. */
function hashSourceDir(dir: string): string {
  if (!existsSync(dir))
    throw new Error(`fishmem source directory not found: ${dir}`);
  const files: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(name)) files.push(full);
    }
  };
  walk(dir);
  const h = createHash("sha256");
  for (const f of files) h.update(f).update(readFileSync(f));
  return h.digest("hex").slice(0, 16);
}

function hashFile(path: string): string {
  if (!existsSync(path))
    throw new Error(`benchmark source file not found: ${path}`);
  return createHash("sha256")
    .update(readFileSync(path))
    .digest("hex")
    .slice(0, 16);
}

function installedPackageVersion(
  repoRoot: string,
  entrypoint: string,
  packageName: string,
): string {
  const require = createRequire(join(repoRoot, "package.json"));
  let dir = dirname(require.resolve(entrypoint));
  while (dir !== dirname(dir)) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
        name?: string;
        version?: string;
      };
      if (parsed.name === packageName && parsed.version) return parsed.version;
    }
    dir = dirname(dir);
  }
  throw new Error(`cannot determine installed ${packageName} version`);
}

/**
 * The cache-busting code version for a supported system. fishmem uses its
 * source hash; mem0 uses its pinned package version. Both include adapter code.
 */
export function systemCodeVersion(system: string, repoRoot: string): string {
  if (!system.startsWith("fishmem") && !system.startsWith("mem0")) {
    throw new Error(`cannot version benchmark system "${system}"`);
  }
  const adapter = hashFile(join(repoRoot, "benchmarks/locomo/adapters.ts"));
  if (system.startsWith("fishmem")) {
    return `fishmem-src:${hashSourceDir(join(repoRoot, "packages/fishmem/src"))}+adapter:${adapter}`;
  }
  if (system.startsWith("mem0")) {
    const version = installedPackageVersion(repoRoot, "mem0ai/oss", "mem0ai");
    return `mem0ai:${version}+adapter:${adapter}`;
  }
  throw new Error(`cannot version benchmark system "${system}"`);
}

export interface ResultCache<R> {
  /** Cached result for this fingerprint, or undefined on miss/disabled. */
  get(fp: string): R | undefined;
  /** Persist a result under its fingerprint. */
  put(fp: string, label: string, value: R): void;
  readonly enabled: boolean;
  readonly hits: number;
  readonly dir: string;
}

export function openResultCache<R>(opts: {
  dir: string;
  enabled?: boolean;
}): ResultCache<R> {
  const enabled = opts.enabled ?? false;
  let hits = 0;
  const path = (fp: string) => join(opts.dir, `${fp}.json`);
  if (enabled) mkdirSync(opts.dir, { recursive: true });
  return {
    enabled,
    get dir() {
      return opts.dir;
    },
    get hits() {
      return hits;
    },
    get(fp) {
      if (!enabled || !existsSync(path(fp))) return undefined;
      try {
        const entry = JSON.parse(readFileSync(path(fp), "utf8"));
        hits++;
        return entry.value as R;
      } catch (error) {
        console.warn(
          `Ignoring corrupt benchmark cache entry ${path(fp)}: ${(error as Error).message}`,
        );
        return undefined;
      }
    },
    put(fp, label, value) {
      if (!enabled) return;
      writeFileSync(
        path(fp),
        JSON.stringify({ label, fingerprint: fp, value }),
      );
    },
  };
}
