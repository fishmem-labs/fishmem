import type {
	DesktopMemoryPage,
	DesktopMethod,
} from "../shared/protocol";
import { formatMemoryContext } from "./context-format";
import { detectProject } from "./project";

export type HookEvent = "session-start" | "prompt";

export type HookDependencies = {
	readStdin(): Promise<string>;
	invoke(
		method: DesktopMethod,
		params: unknown,
		options: { timeoutMs: number },
	): Promise<unknown>;
	cwd(): string;
	env?: Record<string, string | undefined>;
};

/** Time allowed for the Desktop round trip; the hook fails open after it. */
export const HOOK_TIMEOUT_MS = 2_000;
const PROMPT_BUDGET_TOKENS = 800;
const SESSION_BUDGET_TOKENS = 500;
const MIN_PROMPT_CHARS = 12;
const MAX_QUERY_CHARS = 2_000;
/** Minimum query/memory cosine (local E5) for automatic prompt recall. */
export const DEFAULT_HOOK_MIN_SIMILARITY = 0.8;

/**
 * Run a Claude Code hook and return the JSON text to print, or an empty
 * string for "no additional context". Never throws: hooks must fail open so
 * a stopped or not-yet-ready Desktop never blocks the agent.
 */
export async function runHook(
	event: HookEvent,
	dependencies: HookDependencies,
): Promise<string> {
	try {
		const input = parseHookInput(
			await withTimeout(dependencies.readStdin(), HOOK_TIMEOUT_MS),
		);
		const cwd =
			typeof input.cwd === "string" && input.cwd ? input.cwd : dependencies.cwd();
		const project = detectProject(cwd);
		const context =
			event === "prompt"
				? await promptContext(input, project, dependencies)
				: await sessionContext(project, dependencies);
		if (!context) return "";
		return JSON.stringify({
			hookSpecificOutput: {
				hookEventName: event === "prompt" ? "UserPromptSubmit" : "SessionStart",
				additionalContext: context,
			},
		});
	} catch {
		return "";
	}
}

async function promptContext(
	input: Record<string, unknown>,
	project: string | undefined,
	dependencies: HookDependencies,
): Promise<string> {
	const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
	// Slash commands and very short prompts ("yes", "continue") carry no
	// retrievable intent.
	if (prompt.length < MIN_PROMPT_CHARS || prompt.startsWith("/")) return "";
	const minSimilarity = Number(
		dependencies.env?.FISHMEM_HOOK_MIN_SIMILARITY ?? DEFAULT_HOOK_MIN_SIMILARITY,
	);
	const page = (await dependencies.invoke(
		"search",
		{
			query: prompt.slice(0, MAX_QUERY_CHARS),
			limit: 8,
			...(project ? { project } : {}),
			min_similarity: Number.isFinite(minSimilarity)
				? minSimilarity
				: DEFAULT_HOOK_MIN_SIMILARITY,
		},
		{ timeoutMs: HOOK_TIMEOUT_MS },
	)) as DesktopMemoryPage;
	return formatMemoryContext(page.results ?? [], {
		budgetTokens: PROMPT_BUDGET_TOKENS,
		project,
	});
}

async function sessionContext(
	project: string | undefined,
	dependencies: HookDependencies,
): Promise<string> {
	const page = (await dependencies.invoke(
		"list",
		{ limit: 8, ...(project ? { project } : {}) },
		{ timeoutMs: HOOK_TIMEOUT_MS },
	)) as DesktopMemoryPage;
	const recent = formatMemoryContext(page.results ?? [], {
		budgetTokens: SESSION_BUDGET_TOKENS,
		project,
	});
	const reminder = [
		"FishMem is connected: relevant memories are added to each prompt automatically.",
		"Search explicitly (`fishmem search --query ... --format context`) before architecture or convention decisions.",
		"Before finishing a task, save durable decisions or preferences that emerged with `fishmem remember` / `fishmem add`.",
	].join(" ");
	return recent ? `${reminder}\n\nMost recent memories:\n${recent}` : reminder;
}

function parseHookInput(text: string): Record<string, unknown> {
	if (!text.trim()) return {};
	const value: unknown = JSON.parse(text);
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error("hook input timed out")),
			timeoutMs,
		);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}
