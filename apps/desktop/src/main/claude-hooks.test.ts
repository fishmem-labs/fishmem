import { describe, expect, it } from "vitest";
import {
	fishmemHookCommand,
	hasFishMemHooks,
	mergeFishMemHooks,
	parseClaudeSettings,
	removeFishMemHooks,
} from "./claude-hooks";

const CLI = "/Users/ada/.fishmem/bin/fishmem";

describe("Claude Code hook settings", () => {
	it("adds FishMem hooks while preserving unrelated settings and hooks", () => {
		const settings = {
			model: "opus",
			hooks: {
				UserPromptSubmit: [
					{ hooks: [{ type: "command", command: "echo other" }] },
				],
				PreToolUse: [
					{ matcher: "Bash", hooks: [{ type: "command", command: "lint" }] },
				],
			},
		};
		const merged = mergeFishMemHooks(settings, CLI);
		expect(merged).toEqual({
			model: "opus",
			hooks: {
				UserPromptSubmit: [
					{ hooks: [{ type: "command", command: "echo other" }] },
					{
						hooks: [
							{
								type: "command",
								command: `${CLI} hook prompt`,
								timeout: 5,
							},
						],
					},
				],
				PreToolUse: [
					{ matcher: "Bash", hooks: [{ type: "command", command: "lint" }] },
				],
				SessionStart: [
					{
						hooks: [
							{
								type: "command",
								command: `${CLI} hook session-start`,
								timeout: 5,
							},
						],
					},
				],
			},
		});
		expect(hasFishMemHooks(merged, CLI)).toBe(true);
		// The input object is not mutated.
		expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
	});

	it("is idempotent and replaces hooks that point at a stale CLI path", () => {
		const once = mergeFishMemHooks({}, CLI);
		expect(mergeFishMemHooks(once, CLI)).toEqual(once);
		const moved = mergeFishMemHooks(once, "/opt/fishmem/bin/fishmem");
		expect(JSON.stringify(moved)).not.toContain(CLI);
		expect(hasFishMemHooks(moved, CLI)).toBe(false);
		expect(hasFishMemHooks(moved, "/opt/fishmem/bin/fishmem")).toBe(true);
	});

	it("removes only FishMem hooks and drops groups and events left empty", () => {
		const merged = mergeFishMemHooks(
			{
				hooks: {
					SessionStart: [
						{
							hooks: [
								{ type: "command", command: "echo keep" },
								{ type: "command", command: `${CLI} hook session-start` },
							],
						},
					],
				},
			},
			CLI,
		);
		expect(removeFishMemHooks(merged)).toEqual({
			hooks: {
				SessionStart: [
					{ hooks: [{ type: "command", command: "echo keep" }] },
				],
			},
		});
		expect(removeFishMemHooks(mergeFishMemHooks({ theme: "dark" }, CLI))).toEqual(
			{ theme: "dark" },
		);
		expect(removeFishMemHooks({ theme: "dark" })).toEqual({ theme: "dark" });
	});

	it("quotes CLI paths that contain spaces", () => {
		expect(fishmemHookCommand("/Users/Ada Lovelace/fishmem", "prompt")).toBe(
			'"/Users/Ada Lovelace/fishmem" hook prompt',
		);
		const merged = mergeFishMemHooks({}, "/Users/Ada Lovelace/fishmem");
		expect(removeFishMemHooks(merged)).toEqual({});
	});

	it("refuses to overwrite invalid settings JSON", () => {
		expect(parseClaudeSettings("", "settings.json")).toEqual({});
		expect(() => parseClaudeSettings("{ nope", "settings.json")).toThrow(
			"not valid JSON",
		);
		expect(() => parseClaudeSettings("[]", "settings.json")).toThrow(
			"JSON object",
		);
	});
});
