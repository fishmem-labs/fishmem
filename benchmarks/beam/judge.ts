/**
 * Official BEAM judge, ported from
 * https://github.com/mohammadtavakoli78/BEAM
 *   - src/evaluation/run_evaluation.py   (dispatch, judge model `gpt_llm`)
 *   - src/evaluation/compute_metrics.py  (per-category evaluate_* functions,
 *     parse_json_response, align_with_llm, event_ordering_score)
 *   - src/prompts.py                     (prompt strings — see ./prompts.ts)
 *   - src/llm.py                         (gpt_llm = ChatOpenAI("gpt-4.1-mini", temperature=0))
 *
 * Protocol summary (replicated here):
 *  - Every question carries a `rubric`: a list of atomic criteria ("nuggets").
 *  - Each rubric item is judged independently with `unified_llm_judge_base_prompt`,
 *    which asks for JSON {"score": 1.0 | 0.5 | 0.0, "reason": ...}.
 *  - The per-question score (`llm_judge_score`) is the mean over rubric items.
 *  - event_ordering additionally computes an order-fidelity score: the model
 *    response is split into lines, LLM-aligned against the rubric
 *    (`llm_equivalence` binary classifier), then precision/recall/F1 and a
 *    normalized Kendall tau-b are computed; `final_score = tau_norm * f1`.
 *  - Official aggregation (report_results.py): per category, mean
 *    `llm_judge_score` — EXCEPT event_ordering, which reports mean `tau_norm`.
 *
 * Official quirks preserved deliberately:
 *  1. The judge prompt has a `<question>` slot, but compute_metrics.py only
 *     substitutes `<rubric_item>` and `<llm_response>` — the literal text
 *     "<question>" is sent to the judge. We replicate that substitution.
 *  2. Nine categories aggregate with Python `int(score)` (0.5 floors to 0);
 *     event_ordering uses `float(score)`. Both casts are replicated.
 *  3. evaluate_event_ordering calls extract_facts(...) and then immediately
 *     overwrites the result with `llm_response.split("\n")`; the dead LLM
 *     call is skipped here (zero effect on scores), the split is replicated.
 *  4. scipy.kendalltau returns NaN when one rank vector is constant; the
 *     official code only guards None. We map a non-finite tau to the official
 *     `else 0` branch (tau_norm = 0) instead of propagating NaN.
 */
import type { LLM } from "../../packages/fishmem/src/index.js";
import {
  LLM_EQUIVALENCE_SYSTEM,
  llmEquivalenceUser,
  UNIFIED_LLM_JUDGE_BASE_PROMPT,
} from "./prompts.js";
import type {
  BeamCategory,
  EventOrderingScore,
  RubricItemVerdict,
} from "./types.js";

/** Official judge model (src/llm.py `gpt_llm`), temperature 0. */
export const OFFICIAL_JUDGE_MODEL = "gpt-4.1-mini";

// ── parse_json_response (compute_metrics.py) ─────────────────────────────────

export function parseJudgeJson(raw: string): {
  score: unknown;
  reason?: unknown;
} {
  let response = raw.trim();
  if (response.startsWith("```")) {
    const m = response.match(/```(?:json)?\s*(\[[\s\S]*\]|\{[\s\S]*\})\s*```/);
    if (m) response = m[1]!.trim();
  }
  try {
    return JSON.parse(response);
  } catch {
    /* fall through, as in the official code */
  }
  const m = response.match(/(\{[\s\S]*?\}|\[[\s\S]*?\])/);
  if (m) {
    try {
      return JSON.parse(m[1]!);
    } catch {
      /* fall through to the repair fallback */
    }
  }
  // Official fallback is json_repair.repair_json; our stand-in pulls the
  // score (and best-effort reason) straight out of the malformed text.
  const scoreMatch = response.match(/"score"\s*:\s*"?([0-9]+(?:\.[0-9]+)?)"?/);
  if (scoreMatch) {
    const reasonMatch = response.match(/"reason"\s*:\s*"([\s\S]*?)"\s*[},]/);
    return { score: Number(scoreMatch[1]), reason: reasonMatch?.[1] ?? raw };
  }
  throw new Error("No valid JSON found in response.");
}

// ── unified rubric-item judge ────────────────────────────────────────────────

/**
 * Build the judge prompt with the OFFICIAL substitution: only <rubric_item>
 * and <llm_response> are replaced (quirk #1 — <question> stays literal).
 */
export function buildJudgePrompt(
  rubricItem: string,
  llmResponse: string,
): string {
  return UNIFIED_LLM_JUDGE_BASE_PROMPT.replace(
    "<rubric_item>",
    rubricItem,
  ).replace("<llm_response>", llmResponse);
}

async function judgeRubricItem(
  llm: LLM,
  item: string,
  llmResponse: string,
): Promise<{ rawScore: number; reason: string }> {
  const raw = (
    await llm.chat(
      [{ role: "user", content: buildJudgePrompt(item, llmResponse) }],
      {
        temperature: 0,
      },
    )
  ).trim();
  const parsed = parseJudgeJson(raw);
  const rawScore = Number(parsed.score);
  if (!Number.isFinite(rawScore)) {
    throw new Error(`judge returned non-numeric score: ${raw.slice(0, 200)}`);
  }
  return { rawScore, reason: String(parsed.reason ?? "") };
}

export interface RubricJudgeOutcome {
  /** Mean per official cast (quirk #2): int() for nine cats, float() for event_ordering. */
  llmJudgeScore: number;
  verdicts: RubricItemVerdict[];
  judgeErrors: number;
}

/**
 * Port of the shared body of evaluate_abstention / evaluate_contradiction_resolution /
 * ... / evaluate_temporal_reasoning (they are identical), plus the
 * event_ordering float() variant.
 *
 * Judge failures abort the unit, matching the official runner. Converting an
 * infrastructure failure into score 0 would corrupt the benchmark result.
 */
export async function judgeRubric(
  llm: LLM,
  category: BeamCategory,
  rubric: string[],
  llmResponse: string,
): Promise<RubricJudgeOutcome> {
  const useFloat = category === "event_ordering";
  const verdicts: RubricItemVerdict[] = [];
  let total = 0;
  for (const item of rubric) {
    const { rawScore, reason } = await judgeRubricItem(llm, item, llmResponse);
    const score = useFloat ? rawScore : Math.trunc(rawScore); // int() vs float()
    verdicts.push({ item, score, rawScore, reason });
    total += score;
  }
  return {
    llmJudgeScore: rubric.length ? total / rubric.length : 0,
    verdicts,
    judgeErrors: 0,
  };
}

// ── event ordering: llm_equivalence + align_with_llm ─────────────────────────

/** Port of llm_equivalence: binary classifier, verdict = "yes" in lowercased reply. */
async function llmEquivalence(
  llm: LLM,
  firstParagraph: string,
  secondParagraph: string,
): Promise<boolean> {
  const response = (
    await llm.chat(
      [
        { role: "system", content: LLM_EQUIVALENCE_SYSTEM },
        {
          role: "user",
          content: llmEquivalenceUser(firstParagraph, secondParagraph),
        },
      ],
      { temperature: 0 },
    )
  ).toLowerCase();
  return response.includes("yes");
}

/**
 * Port of align_with_llm: greedily replace each system line with the first
 * unused reference item the classifier deems equivalent.
 */
export async function alignWithLlm(
  llm: LLM,
  reference: string[],
  system: string[],
): Promise<{ reference: string[]; systemOut: string[] }> {
  const used = new Set<number>();
  const systemOut: string[] = [];
  for (const s of system) {
    let matchedIndex: number | null = null;
    for (let index = 0; index < reference.length; index++) {
      if (used.has(index)) continue;
      if (await llmEquivalence(llm, reference[index]!, s)) {
        matchedIndex = index;
        break;
      }
    }
    if (matchedIndex !== null) {
      systemOut.push(reference[matchedIndex]!);
      used.add(matchedIndex);
    } else {
      systemOut.push(s);
    }
  }
  return { reference, systemOut };
}

/**
 * Kendall tau-b on two equal-length rank vectors (scipy.stats.kendalltau
 * variant="b" semantics). Returns NaN when a denominator term is zero
 * (constant input), like scipy.
 */
export function kendallTauB(x: number[], y: number[]): number {
  const n = x.length;
  let concordant = 0;
  let discordant = 0;
  let tiesXOnly = 0;
  let tiesYOnly = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = x[i]! - x[j]!;
      const dy = y[i]! - y[j]!;
      if (dx === 0 && dy === 0) continue; // tied in both: excluded from both denominators
      if (dx === 0) tiesXOnly++;
      else if (dy === 0) tiesYOnly++;
      else if (dx * dy > 0) concordant++;
      else discordant++;
    }
  }
  const denom = Math.sqrt(
    (concordant + discordant + tiesXOnly) *
      (concordant + discordant + tiesYOnly),
  );
  if (denom === 0) return NaN;
  return (concordant - discordant) / denom;
}

/** Port of event_ordering_score (align_type="llm" path, as dispatched officially). */
export async function eventOrderingScore(
  llm: LLM,
  referenceList: string[],
  systemList: string[],
): Promise<EventOrderingScore> {
  const { reference: referenceCanon, systemOut: systemCanon } =
    await alignWithLlm(llm, referenceList, systemList);

  const refSet = new Set(referenceCanon);
  const sysSet = new Set(systemCanon);
  const tp = [...refSet].filter((x) => sysSet.has(x)).length;
  const fp = systemCanon.filter((x) => !refSet.has(x)).length;
  const fn = referenceCanon.filter((x) => !sysSet.has(x)).length;

  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const f1 =
    precision + recall ? (2 * precision * recall) / (precision + recall) : 0;

  // union = list(dict.fromkeys(reference_canon + system_canon))
  const union = [...new Set([...referenceCanon, ...systemCanon])];
  const tieRank = union.length + 1;
  const toRank = (seq: string[]): number[] => {
    const r = new Map<string, number>();
    // later duplicates win, like the dict comprehension
    seq.forEach((item, i) => {
      r.set(item, i + 1);
    });
    return union.map((u) => r.get(u) ?? tieRank);
  };

  const tau = kendallTauB(toRank(referenceCanon), toRank(systemCanon));
  const tauNorm = Number.isFinite(tau) ? (tau + 1) / 2 : 0; // quirk #4
  const finalScore = tauNorm * f1;

  return { precision, recall, f1, tau_norm: tauNorm, final_score: finalScore };
}

/**
 * Port of evaluate_event_ordering: the system list is the raw response split
 * on newlines (quirk #3 — the official extract_facts call is dead code), and
 * the rubric items are ALSO judged with the unified judge.
 */
export async function evaluateEventOrdering(
  llm: LLM,
  rubric: string[],
  llmResponse: string,
): Promise<{ ordering: EventOrderingScore } & RubricJudgeOutcome> {
  const systemList = llmResponse.split("\n");
  const ordering = await eventOrderingScore(llm, rubric, systemList);
  const judged = await judgeRubric(llm, "event_ordering", rubric, llmResponse);
  return { ordering, ...judged };
}
