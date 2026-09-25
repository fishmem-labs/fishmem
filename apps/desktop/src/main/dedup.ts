import { createHash } from "node:crypto";

/**
 * Metadata key that carries the Desktop project scope. A memory without it is
 * global (visible from every project). A metadata field is used instead of the
 * structural `run_id` because the engine filter AST can express
 * "project = X OR project is absent" on metadata, while structural scope
 * fields are hard top-level predicates that cannot be placed under OR.
 */
export const PROJECT_METADATA_KEY = "fishmemProject";
export const PROJECT_FILTER_FIELD = `metadata.${PROJECT_METADATA_KEY}`;

/** Cosine similarity at or above which an add is treated as a near-duplicate. */
export const NEAR_DUPLICATE_COSINE = 0.92;

const MAX_PROJECT_LENGTH = 200;

/**
 * Normalize memory text for exact-duplicate detection: Unicode NFKC, case
 * folding, collapsed whitespace, and trailing sentence punctuation removed.
 */
export function normalizeMemoryContent(content: string): string {
	return content
		.normalize("NFKC")
		.toLowerCase()
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[\s.!?;。！？；]+$/u, "");
}

export function sha256Hex(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

export function normalizedContentHash(content: string): string {
	return sha256Hex(normalizeMemoryContent(content));
}

/**
 * Vector stores report raw cosine similarity (the SQLite store used to report
 * `(1 + cos) / 2`; the engine now matches every other adapter). Clamp so
 * thresholds mean what they say.
 */
export function cosineFromVectorScore(score: number): number {
	return Math.max(-1, Math.min(1, score));
}

export function stableJson(value: unknown): string {
	if (value === undefined) return "null";
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.filter((key) => record[key] !== undefined)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
		.join(",")}}`;
}

export function optionalProject(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new Error("project must be a string");
	const project = value.trim();
	if (!project) return undefined;
	if (project.length > MAX_PROJECT_LENGTH) {
		throw new Error(
			`project must be at most ${MAX_PROJECT_LENGTH} characters`,
		);
	}
	return project;
}

export function projectOf(memory: {
	metadata?: Record<string, unknown>;
}): string | undefined {
	const value = memory.metadata?.[PROJECT_METADATA_KEY];
	return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * A project view sees its own memories plus global ones. A global view
 * (project undefined) sees only global memories.
 */
export function visibleFromProject(
	memory: { metadata?: Record<string, unknown> },
	project: string | undefined,
): boolean {
	const memoryProject = projectOf(memory);
	return memoryProject === undefined || memoryProject === project;
}

export function isCurrentMemory(memory: {
	forgotten?: boolean;
	validTo?: Date;
	supersededBy?: string;
}): boolean {
	if (memory.forgotten) return false;
	if (memory.supersededBy) return false;
	if (memory.validTo && memory.validTo.getTime() <= Date.now()) return false;
	return true;
}

export type SuggestedMemoryAction = "skip" | "review" | "add";

export function suggestMemoryAction(input: {
	exact: boolean;
	topSimilarity?: number;
}): SuggestedMemoryAction {
	if (input.exact) return "skip";
	if (
		input.topSimilarity !== undefined &&
		input.topSimilarity >= NEAR_DUPLICATE_COSINE
	) {
		return "review";
	}
	return "add";
}

export const SUGGESTION_GUIDANCE: Record<SuggestedMemoryAction, string> = {
	skip: "An equivalent memory already exists in this scope; do not store it again.",
	review:
		"Similar memories exist. If one states the same fact, keep it (or `fishmem update` it with a refined wording). If the new content replaces an outdated fact, use `fishmem supersede --id <old> --content <new>`. If it is genuinely distinct, store it with `fishmem add --force`.",
	add: "No similar memory exists in this scope; store it with `fishmem add`.",
};
