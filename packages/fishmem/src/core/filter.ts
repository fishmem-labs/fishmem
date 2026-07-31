import type {
  Memory,
  MemoryFilterExpression,
  MemoryFilterOperator,
  MemoryFilterValue,
} from "../types.js";

const UNSAFE_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

/** Evaluate a canonical filter expression against one authoritative memory. */
export function matchesMemoryFilter(
  memory: Memory,
  expression?: MemoryFilterExpression,
): boolean {
  if (!expression) return true;
  switch (expression.kind) {
    case "and":
      return expression.conditions.every((condition) =>
        matchesMemoryFilter(memory, condition),
      );
    case "or":
      return expression.conditions.some((condition) =>
        matchesMemoryFilter(memory, condition),
      );
    case "not":
      return !matchesMemoryFilter(memory, expression.condition);
    case "condition":
      return matchesCondition(
        memoryField(memory, expression.field),
        expression.operator,
        expression.value,
      );
  }
}

function memoryField(memory: Memory, field: string): unknown {
  if (field.startsWith("metadata.")) {
    const path = field.slice("metadata.".length).split(".");
    if (path.some((segment) => !segment || UNSAFE_PATH_SEGMENTS.has(segment))) {
      return undefined;
    }
    let current: unknown = memory.metadata;
    for (const segment of path) {
      if (!isRecord(current) || !Object.hasOwn(current, segment)) {
        return undefined;
      }
      current = current[segment];
    }
    return current;
  }
  switch (field) {
    case "id":
      return memory.id;
    case "content":
      return memory.content;
    case "memoryType":
      return memory.memoryType;
    case "importance":
      return memory.importance;
    case "createdAt":
      return memory.createdAt;
    case "updatedAt":
      return memory.updatedAt;
    case "eventDate":
      return memory.eventDate;
    case "lastAccessedAt":
      return memory.lastAccessedAt;
    case "accessCount":
      return memory.accessCount;
    case "subject":
      return memory.subject;
    case "attribute":
      return memory.attribute;
    default:
      return undefined;
  }
}

function matchesCondition(
  actual: unknown,
  operator: MemoryFilterOperator,
  expected: MemoryFilterValue | MemoryFilterValue[],
): boolean {
  if (operator === "exists") {
    return (
      typeof expected === "boolean" &&
      (actual !== undefined && actual !== null) === expected
    );
  }
  if (actual === undefined || actual === null) return false;

  switch (operator) {
    case "eq":
      return equal(actual, expected);
    case "ne":
      return !equal(actual, expected);
    case "in":
      return (
        Array.isArray(expected) &&
        expected.some((candidate) =>
          Array.isArray(actual)
            ? actual.some((value) => equal(value, candidate))
            : equal(actual, candidate),
        )
      );
    case "nin":
      return (
        Array.isArray(expected) &&
        !expected.some((candidate) =>
          Array.isArray(actual)
            ? actual.some((value) => equal(value, candidate))
            : equal(actual, candidate),
        )
      );
    case "contains":
      return contains(actual, expected, false);
    case "icontains":
      return contains(actual, expected, true);
    case "gt":
      return compare(actual, expected, (left, right) => left > right);
    case "gte":
      return compare(actual, expected, (left, right) => left >= right);
    case "lt":
      return compare(actual, expected, (left, right) => left < right);
    case "lte":
      return compare(actual, expected, (left, right) => left <= right);
  }
}

function contains(actual: unknown, expected: unknown, insensitive: boolean) {
  if (typeof actual === "string" && typeof expected === "string") {
    return insensitive
      ? actual.toLowerCase().includes(expected.toLowerCase())
      : actual.includes(expected);
  }
  if (Array.isArray(actual)) {
    return actual.some((value) =>
      insensitive && typeof value === "string" && typeof expected === "string"
        ? value.toLowerCase() === expected.toLowerCase()
        : equal(value, expected),
    );
  }
  return false;
}

function compare(
  actual: unknown,
  expected: unknown,
  test: (left: number | string, right: number | string) => boolean,
) {
  const left = comparable(actual);
  const right = comparable(expected);
  if (
    left === undefined ||
    right === undefined ||
    typeof left !== typeof right
  ) {
    return false;
  }
  return test(left, right);
}

function comparable(value: unknown): number | string | undefined {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") return value;
  return undefined;
}

function equal(left: unknown, right: unknown): boolean {
  if (left instanceof Date || right instanceof Date) {
    return (
      left instanceof Date &&
      right instanceof Date &&
      left.getTime() === right.getTime()
    );
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => equal(value, right[index]))
    );
  }
  return Object.is(left, right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
