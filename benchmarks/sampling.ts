export function takePerGroup<T>(
  items: T[],
  limit: number,
  groupOf: (item: T) => string,
): T[] {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(
      `per-group limit must be a positive integer (got ${limit})`,
    );
  }
  const counts = new Map<string, number>();
  return items.filter((item) => {
    const group = groupOf(item);
    const count = counts.get(group) ?? 0;
    if (count >= limit) return false;
    counts.set(group, count + 1);
    return true;
  });
}
