import type { DesktopMethod, IntegrationClient } from "../shared/protocol";
import { DEFAULT_CONTEXT_BUDGET_TOKENS } from "./context-format";
import type { HookEvent } from "./hooks";

export type ContextOutput = {
	format: "context";
	budgetTokens: number;
	project?: string;
};

export type CliAction =
	| { kind: "help" }
	| { kind: "desktopStart"; timeoutMs: number }
	| { kind: "hook"; event: HookEvent }
	| {
			kind: "integrations";
			action: "install" | "uninstall" | "status";
			clients: IntegrationClient[];
	  }
	| {
			kind: "invoke";
			method: DesktopMethod;
			params?: unknown;
			inputFromStdin?: boolean;
			output?: ContextOutput;
	  };

export type CliParseOptions = {
	/** Project derived from the working directory (git root name). */
	defaultProject?: string;
	now?: Date;
};

const MEMORY_TYPES = new Set([
	"fact",
	"preference",
	"decision",
	"identity",
	"event",
	"observation",
	"goal",
	"todo",
]);

export function parseCliArgs(
	argv: string[],
	options: CliParseOptions = {},
): CliAction {
	const args = argv.filter((argument) => argument !== "--json");
	const command = args.shift();
	if (
		!command ||
		command === "help" ||
		command === "--help" ||
		command === "-h"
	) {
		return { kind: "help" };
	}
	if (command === "status") {
		requireNoArguments(args, command);
		return { kind: "invoke", method: "status" };
	}
	if (command === "desktop") {
		const action = args.shift();
		if (action !== "start") {
			throw new Error("desktop requires the start command");
		}
		const timeoutSeconds = optionalPositiveInteger(args, "--timeout", 30);
		requireNoArguments(args, `${command} ${action}`);
		return { kind: "desktopStart", timeoutMs: timeoutSeconds * 1_000 };
	}
	if (command === "call") {
		const method = args.shift();
		if (!method || !isDesktopMethod(method)) {
			throw new Error("call requires a supported Desktop method");
		}
		const inputFromStdin = optionalBoolean(args, "--input-stdin");
		const rawInput = optionalValue(args, "--input");
		if (inputFromStdin && rawInput !== undefined) {
			throw new Error("Use only one of --input or --input-stdin");
		}
		requireNoArguments(args, command);
		if (inputFromStdin) {
			return { kind: "invoke", method, inputFromStdin: true };
		}
		if (rawInput === undefined) {
			return { kind: "invoke", method };
		}
		let params: unknown;
		try {
			params = JSON.parse(rawInput);
		} catch {
			throw new Error("--input must be valid JSON");
		}
		return { kind: "invoke", method, params };
	}
	if (command === "add") {
		const source = optionalValue(args, "--source");
		const title = optionalValue(args, "--title");
		const sourceKind = optionalSourceKind(args);
		const client = optionalClient(args);
		const force = optionalBoolean(args, "--force");
		const project = writeProject(args, options);
		const content = requiredValue(args, "--content", "memory content");
		requireNoArguments(args, command);
		return {
			kind: "invoke",
			method: "add",
			params: {
				content,
				...((source || title || sourceKind || client) && {
					metadata: {
						...(source ? { source } : {}),
						...(title ? { title } : {}),
						...(sourceKind ? { sourceKind } : {}),
						...(client ? { fishmemClient: client } : {}),
					},
				}),
				...(project ? { project } : {}),
				...(force ? { force: true } : { check_similar: true }),
			},
		};
	}
	if (command === "remember") {
		const limit = optionalPositiveInteger(args, "--limit", 5);
		const project = writeProject(args, options);
		const content = requiredValue(args, "--content", "memory content");
		requireNoArguments(args, command);
		return {
			kind: "invoke",
			method: "remember",
			params: { content, limit, ...(project ? { project } : {}) },
		};
	}
	if (command === "update") {
		const id = requiredFlag(args, "--id", "memory id");
		const content = requiredValue(args, "--content", "memory content");
		requireNoArguments(args, command);
		// Content only: metadata (provenance, project scope) is left unchanged.
		return { kind: "invoke", method: "update", params: { id, content } };
	}
	if (command === "supersede") {
		const id = requiredFlag(args, "--id", "memory id");
		const client = optionalClient(args);
		const content = requiredValue(args, "--content", "replacement content");
		requireNoArguments(args, command);
		return {
			kind: "invoke",
			method: "supersede",
			params: {
				id,
				content,
				...(client ? { metadata: { fishmemClient: client } } : {}),
			},
		};
	}
	if (command === "invalidate") {
		const id = requiredFlag(args, "--id", "memory id");
		const supersededBy = optionalValue(args, "--superseded-by");
		requireNoArguments(args, command);
		return {
			kind: "invoke",
			method: "invalidate",
			params: { id, ...(supersededBy ? { superseded_by: supersededBy } : {}) },
		};
	}
	if (command === "search") {
		const limit = optionalPositiveInteger(args, "--limit", 10);
		const minScore = optionalUnitNumber(args, "--min-score");
		const type = optionalMemoryType(args);
		const since = optionalSince(args, options.now ?? new Date());
		const format = optionalFormat(args);
		const budget = optionalPositiveInteger(
			args,
			"--budget",
			DEFAULT_CONTEXT_BUDGET_TOKENS,
		);
		const project = readProject(args, options);
		const query = requiredValue(args, "--query", "search query");
		requireNoArguments(args, command);
		return {
			kind: "invoke",
			method: "search",
			params: {
				query,
				limit,
				...(project.project ? { project: project.project } : {}),
				...(project.allProjects ? { all_projects: true } : {}),
				...(minScore !== undefined ? { min_similarity: minScore } : {}),
				...(type ? { memory_type: type } : {}),
				...(since ? { since } : {}),
			},
			...(format === "context"
				? {
						output: {
							format: "context" as const,
							budgetTokens: budget,
							...(project.project && !project.allProjects
								? { project: project.project }
								: {}),
						},
					}
				: {}),
		};
	}
	if (command === "list") {
		const limit = optionalPositiveInteger(args, "--limit", 50);
		const project = readProject(args, options);
		requireNoArguments(args, command);
		return {
			kind: "invoke",
			method: "list",
			params: {
				limit,
				...(project.project && !project.allProjects
					? { project: project.project }
					: {}),
			},
		};
	}
	if (command === "duplicates") {
		const threshold = optionalUnitNumber(args, "--threshold");
		const limit = optionalPositiveInteger(args, "--limit", 200);
		const project = readProject(args, options);
		requireNoArguments(args, command);
		return {
			kind: "invoke",
			method: "duplicates",
			params: {
				limit,
				...(threshold !== undefined ? { threshold } : {}),
				...(project.project ? { project: project.project } : {}),
				...(project.allProjects ? { all_projects: true } : {}),
			},
		};
	}
	if (command === "delete") {
		const id = requiredValue(args, "--id", "memory id");
		requireNoArguments(args, command);
		return {
			kind: "invoke",
			method: "delete",
			params: { id },
		};
	}
	if (command === "maintenance") {
		const action = args.shift();
		if (action !== "run") throw new Error("maintenance requires the run command");
		requireNoArguments(args, `${command} ${action}`);
		return { kind: "invoke", method: "maintenance" };
	}
	if (command === "hook") {
		const event = args.shift();
		if (event !== "session-start" && event !== "prompt") {
			throw new Error("hook requires session-start or prompt");
		}
		requireNoArguments(args, `${command} ${event}`);
		return { kind: "hook", event };
	}
	if (command === "integrations") {
		const action = args.shift();
		if (action !== "install" && action !== "uninstall" && action !== "status") {
			throw new Error("integrations requires install, uninstall, or status");
		}
		const all = optionalBoolean(args, "--all");
		const client = optionalClient(args);
		requireNoArguments(args, `${command} ${action}`);
		if (action === "status") {
			return { kind: "integrations", action, clients: [] };
		}
		if (all === Boolean(client)) {
			throw new Error(`integrations ${action} requires --all or --client`);
		}
		return {
			kind: "integrations",
			action,
			clients: client ? [client] : ["claude-code", "codex"],
		};
	}
	throw new Error(`Unknown command: ${command}`);
}

const DESKTOP_METHODS = new Set<DesktopMethod>([
	"status",
	"summary",
	"retryEmbedding",
	"list",
	"add",
	"search",
	"get",
	"update",
	"delete",
	"deleteAll",
	"batchUpdate",
	"batchDelete",
	"history",
	"getFeedback",
	"setFeedback",
	"clearFeedback",
	"entityList",
	"entityGet",
	"entityDelete",
	"documentIngest",
	"documentList",
	"documentSearch",
	"documentGet",
	"documentContent",
	"documentDelete",
	"exportSnapshot",
	"importSnapshot",
	"restoreSnapshot",
	"remember",
	"invalidate",
	"supersede",
	"duplicates",
	"maintenance",
]);

function isDesktopMethod(value: string): value is DesktopMethod {
	return DESKTOP_METHODS.has(value as DesktopMethod);
}

function optionalClient(args: string[]) {
	const value = optionalValue(args, "--client");
	if (value === undefined) return undefined;
	if (value !== "codex" && value !== "claude-code") {
		throw new Error("--client must be codex or claude-code");
	}
	return value;
}

/** Project for a write: --global clears it, --project overrides the default. */
function writeProject(args: string[], options: CliParseOptions) {
	const global = optionalBoolean(args, "--global");
	const project = optionalValue(args, "--project");
	if (global && project) throw new Error("Use only one of --global or --project");
	if (global) return undefined;
	return project ?? options.defaultProject;
}

/** Project for a read: --all-projects widens to every project. */
function readProject(args: string[], options: CliParseOptions) {
	const allProjects = optionalBoolean(args, "--all-projects");
	const project = optionalValue(args, "--project");
	if (allProjects && project) {
		throw new Error("Use only one of --all-projects or --project");
	}
	return {
		allProjects,
		project: allProjects ? undefined : (project ?? options.defaultProject),
	};
}

function requiredFlag(args: string[], flag: string, label: string) {
	const value = optionalValue(args, flag);
	if (value === undefined) throw new Error(`Provide ${label} with ${flag}`);
	return value;
}

function optionalUnitNumber(args: string[], flag: string) {
	const raw = optionalValue(args, flag);
	if (raw === undefined) return undefined;
	const value = Number(raw);
	if (!Number.isFinite(value) || value < 0 || value > 1) {
		throw new Error(`${flag} must be a number between 0 and 1`);
	}
	return value;
}

function optionalMemoryType(args: string[]) {
	const value = optionalValue(args, "--type");
	if (value === undefined) return undefined;
	if (!MEMORY_TYPES.has(value)) {
		throw new Error(`--type must be one of ${[...MEMORY_TYPES].join(", ")}`);
	}
	return value;
}

function optionalFormat(args: string[]) {
	const value = optionalValue(args, "--format");
	if (value === undefined || value === "json") return "json";
	if (value !== "context") throw new Error("--format must be json or context");
	return value;
}

/** ISO date/datetime, or a relative window such as 7d, 12h, or 2w. */
function optionalSince(args: string[], now: Date) {
	const value = optionalValue(args, "--since");
	if (value === undefined) return undefined;
	const relative = value.match(/^(\d+)([hdw])$/);
	if (relative) {
		const amount = Number(relative[1]);
		const unitMs =
			relative[2] === "h" ? 3_600_000 : relative[2] === "d" ? 86_400_000 : 604_800_000;
		return new Date(now.getTime() - amount * unitMs).toISOString();
	}
	const date = new Date(value);
	if (!/^\d{4}-\d{2}-\d{2}/.test(value) || Number.isNaN(date.getTime())) {
		throw new Error("--since must be an ISO date or a window such as 7d, 12h, 2w");
	}
	return date.toISOString();
}

function optionalValue(args: string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	if (index < 0) return undefined;
	const value = args[index + 1];
	if (!value) throw new Error(`${flag} requires a value`);
	args.splice(index, 2);
	return value;
}

function optionalBoolean(args: string[], flag: string): boolean {
	const index = args.indexOf(flag);
	if (index < 0) return false;
	args.splice(index, 1);
	return true;
}

function optionalSourceKind(
	args: string[],
): "conversation" | "url" | "file" | undefined {
	const value = optionalValue(args, "--source-kind");
	if (value === undefined) return undefined;
	if (value !== "conversation" && value !== "url" && value !== "file") {
		throw new Error("--source-kind must be conversation, url, or file");
	}
	return value;
}

function requiredValue(args: string[], flag: string, label: string) {
	const flagIndex = args.indexOf(flag);
	if (flagIndex >= 0) {
		const value = args[flagIndex + 1];
		if (!value) throw new Error(`${flag} requires a value`);
		args.splice(flagIndex, 2);
		return value;
	}
	if (args.length !== 1 || !args[0]) {
		throw new Error(`Provide ${label} as one argument or with ${flag}`);
	}
	return args.shift()!;
}

function optionalPositiveInteger(
	args: string[],
	flag: string,
	defaultValue: number,
) {
	const index = args.indexOf(flag);
	if (index < 0) return defaultValue;
	const raw = args[index + 1];
	const value = Number(raw);
	if (!raw || !Number.isInteger(value) || value <= 0) {
		throw new Error(`${flag} must be a positive integer`);
	}
	args.splice(index, 2);
	return value;
}

function requireNoArguments(args: string[], command: string) {
	if (args.length) {
		throw new Error(`Unexpected arguments for ${command}: ${args.join(" ")}`);
	}
}
