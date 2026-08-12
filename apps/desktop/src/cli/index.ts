#!/usr/bin/env bun
import { invokeDesktop } from "../bridge/client";
import { parseCliArgs } from "./args";
import { startDesktop } from "./desktop-lifecycle";

const help = `FishMem CLI

Usage:
  fishmem desktop start [--timeout <seconds>] [--json]
  fishmem status [--json]
  fishmem add --content <text> [--client codex|claude-code]
              [--source <url-or-path>] [--title <text>]
              [--source-kind conversation|url|file] [--json]
  fishmem search --query <text> [--limit <number>] [--json]
  fishmem list [--limit <number>] [--json]
  fishmem delete --id <memory-id> [--json]
  fishmem call exportSnapshot
  fishmem call importSnapshot --input-stdin
  fishmem call restoreSnapshot --input-stdin
  fishmem call <method> [--input <json> | --input-stdin]

The machine-oriented "call" command is the stable bridge used by first-party
SDKs. FishMem Desktop must be running. All command results are JSON.`;

try {
	const action = parseCliArgs(process.argv.slice(2));
	if (action.kind === "help") {
		process.stdout.write(`${help}\n`);
	} else if (action.kind === "desktopStart") {
		const result = await startDesktop({ timeoutMs: action.timeoutMs });
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	} else {
		const params = action.inputFromStdin
			? parseStdinInput(await readStdin())
			: action.params;
		const result = await invokeDesktop(action.method, params);
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	}
} catch (error) {
	process.stderr.write(
		`${JSON.stringify({
			error: error instanceof Error ? error.message : String(error),
		})}\n`,
	);
	process.exitCode = 1;
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
