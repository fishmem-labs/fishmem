export const DEFAULT_MEMORY_INSTRUCTIONS =
  "Store durable user preferences, facts, and project context. Avoid transient conversation details unless the API request explicitly marks them as memory-worthy.";

export const DEFAULT_MEMORY_CATEGORIES: string[] = [
  "User preferences",
  "Profile facts",
  "Long-term context",
  "Agent instructions",
];

const MAX_INSTRUCTIONS_LENGTH = 5_000;
const MAX_CATEGORIES = 24;
const MAX_CATEGORY_LENGTH = 80;

export type MemoryInferencePolicySnapshot = {
  version: 1;
  instructions: string;
  categories: string[];
  source_updated_at: string | null;
};

export function createMemoryInferencePolicySnapshot(input: {
  instructions?: unknown;
  categories?: unknown;
  updatedAt?: Date | string | null;
} = {}): MemoryInferencePolicySnapshot {
  const instructions = normalizeInstructions(input.instructions);
  const categories = normalizeCategories(input.categories);
  return {
    version: 1,
    instructions,
    categories,
    source_updated_at: normalizeTimestamp(input.updatedAt),
  };
}

export function parseMemoryInferencePolicySnapshot(
  value: unknown,
): MemoryInferencePolicySnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid memory inference policy snapshot");
  }
  const snapshot = value as Record<string, unknown>;
  if (
    snapshot.version !== 1 ||
    typeof snapshot.instructions !== "string" ||
    snapshot.instructions.length === 0 ||
    snapshot.instructions.length > MAX_INSTRUCTIONS_LENGTH ||
    !Array.isArray(snapshot.categories) ||
    snapshot.categories.length === 0 ||
    snapshot.categories.length > MAX_CATEGORIES ||
    !snapshot.categories.every(
      (category) =>
        typeof category === "string" &&
        category.trim() === category &&
        category.length > 0 &&
        category.length <= MAX_CATEGORY_LENGTH,
    ) ||
    (snapshot.source_updated_at !== null &&
      (typeof snapshot.source_updated_at !== "string" ||
        Number.isNaN(new Date(snapshot.source_updated_at).getTime())))
  ) {
    throw new Error("Invalid memory inference policy snapshot");
  }
  const unique = new Set(
    snapshot.categories.map((category) => category.toLowerCase()),
  );
  if (unique.size !== snapshot.categories.length) {
    throw new Error("Invalid memory inference policy snapshot");
  }
  return {
    version: 1,
    instructions: snapshot.instructions,
    categories: [...snapshot.categories],
    source_updated_at: snapshot.source_updated_at,
  };
}

function normalizeInstructions(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_MEMORY_INSTRUCTIONS;
  return value.trim().slice(0, MAX_INSTRUCTIONS_LENGTH) || DEFAULT_MEMORY_INSTRUCTIONS;
}

function normalizeCategories(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_MEMORY_CATEGORIES];
  const categories: string[] = [];
  const seen = new Set<string>();
  for (const valueItem of value) {
    if (typeof valueItem !== "string") continue;
    const category = valueItem.trim().slice(0, MAX_CATEGORY_LENGTH);
    const key = category.toLowerCase();
    if (!category || seen.has(key)) continue;
    seen.add(key);
    categories.push(category);
    if (categories.length >= MAX_CATEGORIES) break;
  }
  return categories.length ? categories : [...DEFAULT_MEMORY_CATEGORIES];
}

function normalizeTimestamp(value: Date | string | null | undefined) {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
