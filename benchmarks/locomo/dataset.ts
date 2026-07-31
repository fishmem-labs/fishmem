import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LocomoSample, LocomoTurn, Session } from "./types.js";

export type LocomoGoldField = "answer" | "adversarial_answer";

export interface SelectedLocomoQuestion {
  qa: LocomoSample["qa"][number];
  questionIndex: number;
  goldAnswer: string;
  goldField: LocomoGoldField;
}

const HERE = dirname(fileURLToPath(import.meta.url));
export const DATASET_PATH = join(HERE, "data", "locomo10.json");
export const DATASET_URL =
  "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json";

export function loadDataset(path = DATASET_PATH): LocomoSample[] {
  if (!existsSync(path)) {
    throw new Error(
      `LOCOMO dataset not found at ${path}.\nDownload it first:\n  curl -L -o ${path} ${DATASET_URL}`,
    );
  }
  return JSON.parse(readFileSync(path, "utf8")) as LocomoSample[];
}

export function resolveLocomoGold(qa: LocomoSample["qa"][number]): {
  answer: string;
  field: LocomoGoldField;
} {
  const field: LocomoGoldField =
    qa.category === 5
      ? "adversarial_answer"
      : qa.category >= 1 && qa.category <= 4
        ? "answer"
        : (() => {
            throw new Error(`unsupported LOCOMO category: ${qa.category}`);
          })();
  const value = qa[field];
  if (value === undefined || String(value).trim() === "") {
    throw new Error(
      `LOCOMO category ${qa.category} requires non-empty ${field}: ${qa.question}`,
    );
  }
  return { answer: String(value), field };
}

export function selectLocomoQuestions(
  sample: LocomoSample,
  categories: ReadonlySet<number>,
  maxQuestions = Number.POSITIVE_INFINITY,
): SelectedLocomoQuestion[] {
  return sample.qa
    .map((qa, questionIndex) => ({ qa, questionIndex }))
    .filter(({ qa }) => categories.has(qa.category))
    .map(({ qa, questionIndex }) => {
      const gold = resolveLocomoGold(qa);
      return {
        qa,
        questionIndex,
        goldAnswer: gold.answer,
        goldField: gold.field,
      };
    })
    .slice(0, maxQuestions);
}

/** Extract ordered sessions (session_1, session_2, ...) from a conversation. */
export function sessionsOf(sample: LocomoSample): Session[] {
  const conv = sample.conversation;
  const sessions: Session[] = [];
  for (let i = 1; ; i++) {
    const turns = conv[`session_${i}`];
    if (!Array.isArray(turns)) break;
    sessions.push({
      index: i,
      dateTime: String(conv[`session_${i}_date_time`] ?? ""),
      turns: turns as LocomoTurn[],
    });
  }
  return sessions;
}

/** Render a turn as plain text, folding image captions in (mem0 eval style). */
export function turnText(turn: LocomoTurn): string {
  const parts: string[] = [];
  if (turn.blip_caption) parts.push(`[shares a photo: ${turn.blip_caption}]`);
  if (turn.text) parts.push(turn.text);
  return parts.join(" ").trim();
}
