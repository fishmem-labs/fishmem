#!/usr/bin/env bun
import { invokeDesktop } from "../bridge/client";
import { IntegrationService } from "../main/integration-service";
import type { DesktopMemoryPage } from "../shared/protocol";
import { parseCliArgs } from "./args";
import { formatMemoryContext } from "./context-format";
import { startDesktop } from "./desktop-lifecycle";
import { runHook } from "./hooks";
import { resolveIntegrationSources } from "./integrations";
import { detectProject } from "./project";

const help = `FishMem CLI

Usage:
  fishmem desktop start [--timeout <seconds>] [--json]
  fishmem status [--json]

  Memories (project defaults to the current git repository's root name):
  fishmem add --content <text> [--client codex|claude-code]
              [--project <id> | --global] [--force]
              [--source <url-or-path>] [--title <text>]
              [--source-kind conversation|url|file] [--json]
  fishmem remember --content <text> [--project <id> | --global] [--limit <n>]
  fishmem search --query <text> [--limit <number>]
              [--project <id> | --all-projects] [--min-score <0-1>]
              [--type <memory-type>] [--since <iso-date|7d|12h|2w>]
              [--format json|context] [--budget <tokens>] [--json]
  fishmem list [--limit <number>] [--project <id> | --all-projects] [--json]
  fishmem update --id <memory-id> --content <text>
  fishmem supersede --id <old-memory-id> --content <replacement> [--client ...]
  fishmem invalidate --id <memory-id> [--superseded-by <memory-id>]
  fishmem delete --id <memory-id> [--json]
  fishmem duplicates [--project <id> | --all-projects] [--threshold <0-1>]
  fishmem maintenance run

  Integrations:
  fishmem integrations install (--all | --client codex|claude-code)
  fishmem integrations uninstall (--all | --client codex|claude-code)
  fishmem integrations status
  fishmem hook session-start|prompt   (Claude Code hooks; read hook JSON on stdin)

  SDK bridge:
  fishmem call exportSnapshot
  fishmem call importSnapshot --input-stdin
  fishmem call restoreSnapshot --input-stdin
  fishmem call <method> [--input <json> | --input-stdin]

"add" never stores an exact duplicate, and returns similar memories instead of
writing when a near-duplicate exists (use --force to store anyway). Memories
written inside a project are visible there and nowhere else; --global memories
are visible everywhere. Search results are JSON unless --format context.
FishMem Desktop must be running.`;

try {
	const argv = process.argv.slice(2);
	const action = parseCliArgs(argv, {
		defaultProject:
			argv[0] === "hook" || argv[0] === "call"
				? undefined
				: detectProject(process.cwd()),
	});
	if (action.kind === "help") {
		process.stdout.write(`${help}\n`);
	} else if (action.kind === "hook") {
		const output = await runHook(action.event, {
			readStdin,
			invoke: (method, params, options) =>
				invokeDesktop(method, params, options),
			cwd: () => process.cwd(),
			env: process.env,
		});
		if (output) process.stdout.write(`${output}\n`);
	} else if (action.kind === "desktopStart") {
		const result = await startDesktop({ timeoutMs: action.timeoutMs });
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	} else if (action.kind === "integrations") {
		const sources =
			action.action === "install"
				? resolveIntegrationSources()
				: { cliSourcePath: process.execPath, skillSourcePath: "" };
		const service = new IntegrationService(
			sources.cliSourcePath,
			sources.skillSourcePath,
		);
		let status = await service.status();
		for (const client of action.clients) {
			status =
				action.action === "install"
					? await service.connect(client)
					: await service.disconnect(client);
		}
		process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
	} else {
		const params = action.inputFromStdin
			? parseStdinInput(await readStdin())
			: action.params;
		const result = await invokeDesktop(action.method, params);
		if (action.output?.format === "context") {
			const context = formatMemoryContext(
				(result as DesktopMemoryPage).results ?? [],
				{
					budgetTokens: action.output.budgetTokens,
					project: action.output.project,
				},
			);
			process.stdout.write(
				`${context || "No relevant FishMem memories found."}\n`,
			);
		} else {
			process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		}
	}
} catch (error) {
	if (process.argv[2] === "hook") {
		// Hooks fail open: never block or pollute the agent's prompt.
		process.exitCode = 0;
	} else {
		process.stderr.write(
			`${JSON.stringify({
				error: error instanceof Error ? error.message : String(error),
			})}\n`,
		);
		process.exitCode = 1;
	}
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString("utf8");
}

function parseStdinInput(input: string): unknown {
	try {
		return JSON.parse(input);
	} catch {
		throw new Error("stdin must contain valid JSON");
	}
}
