export type MetricTimeWindow =
  | { kind: "all" }
  | { kind: "today" }
  | { kind: "7d" }
  | { kind: "30d" }
  | { kind: "range"; from: string; to: string };

export type MetricBucket = {
  label: string;
  counts: Record<string, number>;
};

const DAY = 86_400_000;

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

export function bucketizeMetrics(
  window: MetricTimeWindow,
  items: Array<{ t: number; key: string }>,
): MetricBucket[] {
  const now = Date.now();
  let start: number;
  let end = now;

  if (window.kind === "today") start = now - DAY;
  else if (window.kind === "7d") start = now - 7 * DAY;
  else if (window.kind === "30d") start = now - 30 * DAY;
  else if (window.kind === "range") {
    start = new Date(`${window.from}T00:00:00`).getTime();
    end = new Date(`${window.to}T23:59:59`).getTime();
  } else {
    const timestamps = items
      .map((item) => item.t)
      .filter((timestamp) => Number.isFinite(timestamp));
    start = timestamps.length ? Math.min(...timestamps) : now - 7 * DAY;
  }

  if (!(end > start)) end = start + DAY;
  const span = end - start;
  const hourly = span / DAY <= 1.5;
  const count = hourly
    ? 12
    : Math.min(Math.max(Math.round(span / DAY), 2), 30);
  const width = span / count;
  const buckets: MetricBucket[] = Array.from({ length: count }, (_, index) => {
    const date = new Date(start + index * width);
    return {
      label: hourly
        ? `${pad2(date.getHours())}:00`
        : date.toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
          }),
      counts: {},
    };
  });

  for (const item of items) {
    if (!Number.isFinite(item.t) || item.t < start || item.t > end) continue;
    const index = Math.min(
      count - 1,
      Math.max(0, Math.floor((item.t - start) / width)),
    );
    buckets[index]!.counts[item.key] =
      (buckets[index]!.counts[item.key] ?? 0) + 1;
  }

  return buckets;
}
