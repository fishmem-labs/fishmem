import type { DesktopMethod } from "../shared/protocol";

export type CliAction =
	| { kind: "help" }
	| { kind: "desktopStart"; timeoutMs: number }
	| {
			kind: "invoke";
			method: DesktopMethod;
			params?: unknown;
			inputFromStdin?: boolean;
	  };

export function parseCliArgs(argv: string[]): CliAction {
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
		const content = requiredValue(args, "--content", "memory content");
		const source = optionalValue(args, "--source");
		const title = optionalValue(args, "--title");
		const sourceKind = optionalSourceKind(args);
		const client = optionalClient(args);
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
			},
		};
	}
	if (command === "search") {
		const query = requiredValue(args, "--query", "search query");
		const limit = optionalPositiveInteger(args, "--limit", 10);
		requireNoArguments(args, command);
		return { kind: "invoke", method: "search", params: { query, limit } };
	}
	if (command === "list") {
		const limit = optionalPositiveInteger(args, "--limit", 50);
		requireNoArguments(args, command);
		return { kind: "invoke", method: "list", params: { limit } };
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
