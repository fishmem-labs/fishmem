import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BeamBatch,
  BeamChatFile,
  BeamConversation,
  BeamProbingQuestions,
} from "./types.js";
import { BEAM_CATEGORIES } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * CLI variants map to the official dataset tier directories.
 * (The paper calls the smallest tier "128K"; the repo/HF split name is 100K.)
 */
export type Variant = "100k" | "500k" | "1m" | "10m";

export const TIER_BY_VARIANT: Record<Variant, string> = {
  "100k": "100K",
  "500k": "500K",
  "1m": "1M",
  "10m": "10M",
};

export const REPO_URL = "https://github.com/mohammadtavakoli78/BEAM";
export const HF_URL = "https://huggingface.co/datasets/Mohammadta/BEAM";
export const HF_10M_URL = "https://huggingface.co/datasets/Mohammadta/BEAM-10M";

export function dataDir(variant: Variant): string {
  return join(HERE, "data", TIER_BY_VARIANT[variant]);
}

/** Sizes from the official repo tree (chat.json + probing_questions.json totals). */
const APPROX_SIZE: Record<Variant, string> = {
  "100k": "~14MB (20 conversations)",
  "500k": "~86MB (35 conversations)",
  "1m": "~175MB (35 conversations)",
  "10m": "~529MB (10 conversations)",
};

function downloadHelp(variant: Variant): string {
  const tier = TIER_BY_VARIANT[variant];
  return `BEAM ${tier} dataset not found under ${dataDir(variant)}.

Download ${APPROX_SIZE[variant]} from the official repo (data license CC BY-SA 4.0)
via a sparse checkout, then copy the tier directory in:

  git clone --depth 1 --filter=blob:none --sparse ${REPO_URL} /tmp/BEAM
  git -C /tmp/BEAM sparse-checkout set chats/${tier}
  mkdir -p benchmarks/beam/data
  cp -R /tmp/BEAM/chats/${tier} benchmarks/beam/data/${tier}

(Alternative: the HuggingFace parquet datasets ${HF_URL} and ${HF_10M_URL}
with the official converter \`python src/beam/download_dataset.py\` produce the
same per-conversation layout.)

Expected layout: benchmarks/beam/data/${tier}/<n>/chat.json
                 benchmarks/beam/data/${tier}/<n>/probing_questions/probing_questions.json`;
}

/**
 * Flatten a chat.json into a single batch list.
 * 100K/500K/1M files are already `BeamBatch[]`; 10M files are
 * `[{ "plan-1": BeamBatch[] }, ...]` — unwrap the plans in order
 * (mirrors the 10M branches in src/answer_probing_questions/long_term_memory_methods.py).
 */
export function flattenChat(chat: BeamChatFile): BeamBatch[] {
  const out: BeamBatch[] = [];
  for (const entry of chat) {
    if (entry && typeof entry === "object" && "turns" in entry) {
      out.push(entry as BeamBatch);
      continue;
    }
    // 10M plan wrapper: single "plan-<n>" key → batches.
    const plans = Object.values(entry as Record<string, BeamBatch[]>);
    for (const batches of plans) for (const b of batches) out.push(b);
  }
  return out;
}

function readProbingQuestions(convDir: string): BeamProbingQuestions {
  const nested = join(convDir, "probing_questions", "probing_questions.json");
  const flat = join(convDir, "probing_questions.json");
  const path = existsSync(nested) ? nested : flat;
  if (!existsSync(path)) {
    throw new Error(`probing_questions.json not found under ${convDir}`);
  }
  const data = JSON.parse(readFileSync(path, "utf8")) as BeamProbingQuestions;
  for (const cat of BEAM_CATEGORIES) {
    const qs = data[cat];
    if (!Array.isArray(qs)) continue; // tolerate partial category sets
    for (const q of qs) {
      if (typeof q.question !== "string" || !Array.isArray(q.rubric)) {
        throw new Error(`malformed ${cat} question in ${path}`);
      }
    }
  }
  return data;
}

/**
 * Load all conversations of a variant from benchmarks/beam/data/<TIER>/.
 * Directory names are numeric ("1".."35") and sorted numerically, matching
 * the official `sorted(dirs, key=lambda x: int(x))`.
 */
export function loadConversations(variant: Variant): BeamConversation[] {
  const dir = dataDir(variant);
  if (!existsSync(dir)) throw new Error(downloadHelp(variant));
  const ids = readdirSync(dir)
    .filter(
      (name) => /^\d+$/.test(name) && statSync(join(dir, name)).isDirectory(),
    )
    .sort((a, b) => Number(a) - Number(b));
  if (ids.length === 0) throw new Error(downloadHelp(variant));

  return ids.map((id) => {
    const convDir = join(dir, id);
    const chatPath = join(convDir, "chat.json");
    if (!existsSync(chatPath)) {
      throw new Error(`chat.json missing for conversation ${id}: ${chatPath}`);
    }
    const chat = JSON.parse(readFileSync(chatPath, "utf8")) as BeamChatFile;
    return {
      id,
      tier: TIER_BY_VARIANT[variant],
      batches: flattenChat(chat),
      questions: readProbingQuestions(convDir),
    };
  });
}

/** Best-effort human-readable reference answer for the results JSON. */
export function goldAnswerOf(q: Record<string, unknown>): string | undefined {
  for (const key of [
    "answer",
    "ideal_response",
    "ideal_answer",
    "ideal_summary",
    "expected_compliance",
  ]) {
    const v = q[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}
