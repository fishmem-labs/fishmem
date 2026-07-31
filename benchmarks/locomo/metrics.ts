/** Token-overlap metrics (SQuAD-style F1, BLEU-1) and latency percentiles. */

function normalize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** SQuAD-style token F1 between a prediction and the gold answer. */
export function tokenF1(prediction: string, gold: string): number {
  const p = normalize(prediction);
  const g = normalize(gold);
  if (p.length === 0 || g.length === 0) {
    return p.length === g.length ? 1 : 0;
  }
  const goldCounts = new Map<string, number>();
  for (const t of g) goldCounts.set(t, (goldCounts.get(t) ?? 0) + 1);
  let overlap = 0;
  for (const t of p) {
    const c = goldCounts.get(t) ?? 0;
    if (c > 0) {
      overlap++;
      goldCounts.set(t, c - 1);
    }
  }
  if (overlap === 0) return 0;
  const precision = overlap / p.length;
  const recall = overlap / g.length;
  return (2 * precision * recall) / (precision + recall);
}

/** BLEU-1: unigram precision with brevity penalty. */
export function bleu1(prediction: string, gold: string): number {
  const p = normalize(prediction);
  const g = normalize(gold);
  if (p.length === 0) return 0;
  const goldCounts = new Map<string, number>();
  for (const t of g) goldCounts.set(t, (goldCounts.get(t) ?? 0) + 1);
  let overlap = 0;
  for (const t of p) {
    const c = goldCounts.get(t) ?? 0;
    if (c > 0) {
      overlap++;
      goldCounts.set(t, c - 1);
    }
  }
  const precision = overlap / p.length;
  const brevity = p.length >= g.length ? 1 : Math.exp(1 - g.length / p.length);
  return precision * brevity;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[idx]!;
}

export function mean(values: number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((a, b) => a + b, 0) / values.length;
}
