/**
 * Lightweight temporal query analysis (LongMemEval "time-aware indexing"):
 * extract an absolute date range from a query so retrieval can add a
 * date-filtered candidate stream. Regex-based — no LLM call, no locale deps.
 */

export interface DateRange {
  from: Date;
  to: Date;
}

const MONTHS: Record<string, number> = {
  january: 0,
  jan: 0,
  february: 1,
  feb: 1,
  march: 2,
  mar: 2,
  april: 3,
  apr: 3,
  may: 4,
  june: 5,
  jun: 5,
  july: 6,
  jul: 6,
  august: 7,
  aug: 7,
  september: 8,
  sep: 8,
  sept: 8,
  october: 9,
  oct: 9,
  november: 10,
  nov: 10,
  december: 11,
  dec: 11,
};

const MONTH_RE = Object.keys(MONTHS).join("|");

/**
 * Extract a date range from free text. Recognised shapes (first match wins,
 * most-specific first):
 *   - "7 May 2023" / "May 7, 2023" / "2023-05-07"  → that day
 *   - "May 2023" / "in May of 2023"                → that month
 *   - "summer 2023", "fall/autumn of 2023", …      → that season
 *   - "in 2023"                                    → that year
 * Returns null when no absolute date is present (relative references like
 * "last week" need a reference instant and are out of scope here).
 */
export function extractDateRange(text: string): DateRange | null {
  const t = text.toLowerCase();

  // ISO date: 2023-05-07
  let m = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) return dayRange(+m[1]!, +m[2]! - 1, +m[3]!);

  // "7 May 2023" / "7th of May, 2023"
  m = t.match(
    new RegExp(
      `\\b(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+(${MONTH_RE})\\.?,?\\s+(\\d{4})\\b`,
    ),
  );
  if (m) return dayRange(+m[3]!, MONTHS[m[2]!]!, +m[1]!);

  // "May 7, 2023" / "May 7th 2023"
  m = t.match(
    new RegExp(
      `\\b(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`,
    ),
  );
  if (m) return dayRange(+m[3]!, MONTHS[m[1]!]!, +m[2]!);

  // "May 2023" / "May of 2023"
  m = t.match(new RegExp(`\\b(${MONTH_RE})\\.?(?:\\s+of)?\\s+(\\d{4})\\b`));
  if (m) return monthRange(+m[2]!, MONTHS[m[1]!]!);

  // "summer 2023" / "winter of 2023" (northern-hemisphere convention)
  m = t.match(/\b(spring|summer|fall|autumn|winter)(?:\s+of)?\s+(\d{4})\b/);
  if (m) {
    const year = +m[2]!;
    const season = m[1]!;
    const spans: Record<string, [number, number]> = {
      spring: [2, 4],
      summer: [5, 7],
      fall: [8, 10],
      autumn: [8, 10],
      winter: [11, 1],
    };
    const [a, b] = spans[season]!;
    const from = new Date(Date.UTC(year, a, 1));
    const to =
      season === "winter"
        ? new Date(Date.UTC(year + 1, b + 1, 0, 23, 59, 59, 999))
        : new Date(Date.UTC(year, b + 1, 0, 23, 59, 59, 999));
    return { from, to };
  }

  // Bare year with a temporal preposition: "in 2023", "during 2023", "of 2023"
  m = t.match(/\b(?:in|during|since|of|year)\s+(\d{4})\b/);
  if (m) {
    const year = +m[1]!;
    if (year >= 1900 && year <= 2100) {
      return {
        from: new Date(Date.UTC(year, 0, 1)),
        to: new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999)),
      };
    }
  }

  return null;
}

function dayRange(year: number, month: number, day: number): DateRange {
  return {
    from: new Date(Date.UTC(year, month, day)),
    to: new Date(Date.UTC(year, month, day, 23, 59, 59, 999)),
  };
}

function monthRange(year: number, month: number): DateRange {
  return {
    from: new Date(Date.UTC(year, month, 1)),
    to: new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999)),
  };
}

/**
 * Laplace temporal kernel: 1 inside the range, exp(−distance/τ) outside.
 * Replaces boolean range membership with graded time-distance relevance so
 * near-miss dates ("12 July" when the range is "10 July") still score.
 */
export function temporalKernel(
  eventDate: Date,
  range: DateRange,
  tauDays: number,
): number {
  const t = eventDate.getTime();
  if (t >= range.from.getTime() && t <= range.to.getTime()) return 1;
  const distanceMs =
    t < range.from.getTime()
      ? range.from.getTime() - t
      : t - range.to.getTime();
  const tauMs = Math.max(tauDays, 0.01) * 86_400_000;
  return Math.exp(-distanceMs / tauMs);
}

/** Parse an ISO-ish date string from LLM output; null on garbage. */
export function parseEventDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const s = value.trim();
  // Accept YYYY, YYYY-MM, YYYY-MM-DD (anchor partial dates to the start).
  if (/^\d{4}$/.test(s)) return new Date(Date.UTC(+s, 0, 1));
  if (/^\d{4}-\d{2}$/.test(s)) {
    const [y, mo] = s.split("-");
    return new Date(Date.UTC(+y!, +mo! - 1, 1));
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}
