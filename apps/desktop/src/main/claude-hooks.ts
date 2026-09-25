/**
 * Merge and remove FishMem's Claude Code hooks in a parsed `settings.json`
 * object. Pure functions: the caller owns reading and writing the file.
 *
 * FishMem installs two command hooks that call the absolute CLI path:
 * - SessionStart  -> `fishmem hook session-start`
 * - UserPromptSubmit -> `fishmem hook prompt`
 * Both fail open (exit 0, no output) when Desktop is unavailable.
 */

export type ClaudeSettings = Record<string, unknown>;

type HookCommand = {
	type: string;
	command?: string;
	timeout?: number;
	[key: string]: unknown;
};

type HookGroup = {
	matcher?: string;
	hooks?: HookCommand[];
	[key: string]: unknown;
};

export const FISHMEM_HOOK_EVENTS = {
	SessionStart: "session-start",
	UserPromptSubmit: "prompt",
} as const;

type HookEvent = keyof typeof FISHMEM_HOOK_EVENTS;

const HOOK_TIMEOUT_SECONDS = 5;

const FISHMEM_COMMAND_PATTERN =
	/fishmem(?:\.exe)?["']?\s+hook\s+(?:session-start|prompt|stop)\b/;

export function fishmemHookCommand(cliPath: string, subcommand: string) {
	return `${quoteCommandPath(cliPath)} hook ${subcommand}`;
}

export function isFishMemHookCommand(command: unknown): boolean {
	return typeof command === "string" && FISHMEM_COMMAND_PATTERN.test(command);
}

/** Add (or refresh) FishMem hooks. Idempotent; other hooks are preserved. */
export function mergeFishMemHooks(
	settings: ClaudeSettings,
	cliPath: string,
): ClaudeSettings {
	const cleaned = removeFishMemHooks(settings);
	const hooks = isRecord(cleaned.hooks) ? { ...cleaned.hooks } : {};
	for (const [event, subcommand] of Object.entries(FISHMEM_HOOK_EVENTS) as Array<
		[HookEvent, string]
	>) {
		const groups = Array.isArray(hooks[event])
			? [...(hooks[event] as HookGroup[])]
			: [];
		groups.push({
			hooks: [
				{
					type: "command",
					command: fishmemHookCommand(cliPath, subcommand),
					timeout: HOOK_TIMEOUT_SECONDS,
				},
			],
		});
		hooks[event] = groups;
	}
	return { ...cleaned, hooks };
}

/** Remove every FishMem hook, dropping groups and events left empty. */
export function removeFishMemHooks(settings: ClaudeSettings): ClaudeSettings {
	if (!isRecord(settings.hooks)) return { ...settings };
	const hooks: Record<string, unknown> = {};
	for (const [event, value] of Object.entries(settings.hooks)) {
		if (!Array.isArray(value)) {
			hooks[event] = value;
			continue;
		}
		const groups: unknown[] = [];
		for (const group of value) {
			if (!isRecord(group) || !Array.isArray(group.hooks)) {
				groups.push(group);
				continue;
			}
			const remaining = group.hooks.filter(
				(hook) => !(isRecord(hook) && isFishMemHookCommand(hook.command)),
			);
			if (remaining.length === group.hooks.length) groups.push(group);
			else if (remaining.length > 0) groups.push({ ...group, hooks: remaining });
		}
		if (groups.length > 0) hooks[event] = groups;
	}
	const { hooks: _hooks, ...rest } = settings;
	return Object.keys(hooks).length > 0 ? { ...rest, hooks } : rest;
}

/** True when every FishMem hook is installed and points at `cliPath`. */
export function hasFishMemHooks(
	settings: ClaudeSettings,
	cliPath: string,
): boolean {
	if (!isRecord(settings.hooks)) return false;
	const hooks = settings.hooks;
	return (Object.entries(FISHMEM_HOOK_EVENTS) as Array<[HookEvent, string]>).every(
		([event, subcommand]) => {
			const groups = hooks[event];
			if (!Array.isArray(groups)) return false;
			const expected = fishmemHookCommand(cliPath, subcommand);
			return groups.some(
				(group) =>
					isRecord(group) &&
					Array.isArray(group.hooks) &&
					group.hooks.some(
						(hook) => isRecord(hook) && hook.command === expected,
					),
			);
		},
	);
}

/** Parse settings text. Empty text is an empty object; invalid JSON throws. */
export function parseClaudeSettings(text: string, path: string): ClaudeSettings {
	if (!text.trim()) return {};
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error(
			`${path} is not valid JSON; FishMem left it unchanged. Fix it and connect again.`,
		);
	}
	if (!isRecord(value)) {
		throw new Error(`${path} must contain a JSON object`);
	}
	return value;
}

function quoteCommandPath(path: string) {
	return /^[\w@%+=:,./-]+$/.test(path) ? path : `"${path.replaceAll('"', '\\"')}"`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
