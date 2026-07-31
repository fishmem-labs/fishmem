export function parseIntegerOption(
  value: string,
  name: string,
  minimum: number,
): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum} (got ${value})`);
  }
  return parsed;
}
