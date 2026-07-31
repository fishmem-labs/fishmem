/**
 * Fusion calibration: per-source isotonic score→probability tables and the
 * noisy-OR pooling that consumes them.
 *
 * RRF is rank-only — it discards score magnitude and treats every source as
 * equally reliable. Calibration replaces both assumptions with measured
 * curves: P(useful | score, source), fit offline from retrieval traces
 * (`benchmarks/fit-calibration.ts`), combined per candidate with noisy-OR:
 *
 *   P(d) = 1 − Π_sources (1 − w_s · p_s(score_d))
 *
 * Missing sources simply contribute nothing (noisy-OR's natural handling of
 * absent evidence). Pure computation at query time.
 */

export interface CalibrationCurve {
  /** Score breakpoints, ascending. */
  x: number[];
  /** Calibrated probabilities at the breakpoints (non-decreasing). */
  y: number[];
}

export interface CalibrationTables {
  vector?: CalibrationCurve;
  fts?: CalibrationCurve;
  graph?: CalibrationCurve;
  temporal?: CalibrationCurve;
}

/**
 * Pool-Adjacent-Violators isotonic regression. Input: (score, label 0/1)
 * pairs; output: a non-decreasing step curve mapping score → P(label=1).
 */
export function fitIsotonic(
  points: Array<{ score: number; label: 0 | 1 }>,
): CalibrationCurve {
  if (!points.length) return { x: [0, 1], y: [0, 0] };
  const sorted = [...points].sort((a, b) => a.score - b.score);
  // Blocks of (sum, count, minScore)
  const blocks: Array<{ sum: number; n: number; x: number }> = sorted.map(
    (p) => ({ sum: p.label, n: 1, x: p.score }),
  );
  const merged: Array<{ sum: number; n: number; x: number }> = [];
  for (const b of blocks) {
    merged.push({ ...b });
    while (
      merged.length >= 2 &&
      merged[merged.length - 2]!.sum / merged[merged.length - 2]!.n >=
        merged[merged.length - 1]!.sum / merged[merged.length - 1]!.n
    ) {
      const top = merged.pop()!;
      const prev = merged[merged.length - 1]!;
      prev.sum += top.sum;
      prev.n += top.n;
    }
  }
  return {
    x: merged.map((b) => b.x),
    y: merged.map((b) => b.sum / b.n),
  };
}

/** Piecewise-constant-with-linear-interpolation lookup on a curve. */
export function calibrate(curve: CalibrationCurve, score: number): number {
  const { x, y } = curve;
  if (!x.length) return 0;
  if (score <= x[0]!) return y[0]!;
  if (score >= x[x.length - 1]!) return y[y.length - 1]!;
  for (let i = 1; i < x.length; i++) {
    if (score <= x[i]!) {
      const span = x[i]! - x[i - 1]!;
      const f = span > 0 ? (score - x[i - 1]!) / span : 1;
      return y[i - 1]! + f * (y[i]! - y[i - 1]!);
    }
  }
  return y[y.length - 1]!;
}

/** Noisy-OR pooling of per-source calibrated probabilities. */
export function noisyOr(
  contributions: Array<{ p: number; weight: number }>,
): number {
  let miss = 1;
  for (const { p, weight } of contributions) {
    const effective = Math.min(0.999, Math.max(0, p * weight));
    miss *= 1 - effective;
  }
  return 1 - miss;
}
