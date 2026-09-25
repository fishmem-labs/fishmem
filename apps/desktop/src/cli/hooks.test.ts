import { describe, expect, it, vi } from "vitest";
import { runHook } from "./hooks";

const memory = {
	id: "m1",
	content: "Deploys use wrangler from the web workspace",
	memoryType: "decision",
	importance: 0.5,
	createdAt: "2026-09-01T00:00:00.000Z",
	updatedAt: "2026-09-01T00:00:00.000Z",
	lastAccessedAt: "2026-09-01T00:00:00.000Z",
	accessCount: 0,
};

describe("Claude Code hooks", () => {
	it("injects project-scoped recall for a user prompt", async () => {
		const invoke = vi.fn().mockResolvedValue({ results: [memory] });
		const output = await runHook("prompt", {
			readStdin: async () =>
				JSON.stringify({
					hook_event_name: "UserPromptSubmit",
					prompt: "How do we deploy the web app?",
					cwd: "/nonexistent/acme-api",
				}),
			invoke,
			cwd: () => "/",
			env: {},
		});
		expect(invoke).toHaveBeenCalledWith(
			"search",
			{
				query: "How do we deploy the web app?",
				limit: 8,
				project: "acme-api",
				min_similarity: 0.8,
			},
			{ timeoutMs: 2_000 },
		);
		const parsed = JSON.parse(output);
		expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
		expect(parsed.hookSpecificOutput.additionalContext).toContain(
			"Deploys use wrangler",
		);
	});

	it("stays silent for short prompts, slash commands, and empty results", async () => {
		const invoke = vi.fn().mockResolvedValue({ results: [] });
		for (const prompt of ["yes", "/compact now please ok", "What changed in the deploy?"]) {
			expect(
				await runHook("prompt", {
					readStdin: async () => JSON.stringify({ prompt }),
					invoke,
					cwd: () => "/tmp/acme",
				}),
			).toBe("");
		}
		expect(invoke).toHaveBeenCalledTimes(1);
	});

	it("fails open when Desktop is not running or stdin is malformed", async () => {
		expect(
			await runHook("prompt", {
				readStdin: async () => JSON.stringify({ prompt: "How do we deploy it?" }),
				invoke: vi.fn().mockRejectedValue(new Error("FishMem Desktop is not running")),
				cwd: () => "/tmp/acme",
			}),
		).toBe("");
		expect(
			await runHook("session-start", {
				readStdin: async () => "{ not json",
				invoke: vi.fn(),
				cwd: () => "/tmp/acme",
			}),
		).toBe("");
	});

	it("adds a recall reminder and recent project memories at session start", async () => {
		const invoke = vi.fn().mockResolvedValue({ results: [memory] });
		const output = await runHook("session-start", {
			readStdin: async () => JSON.stringify({ cwd: "/nonexistent/acme-api", source: "startup" }),
			invoke,
			cwd: () => "/",
		});
		expect(invoke).toHaveBeenCalledWith(
			"list",
			{ limit: 8, project: "acme-api" },
			{ timeoutMs: 2_000 },
		);
		const context = JSON.parse(output).hookSpecificOutput.additionalContext;
		expect(context).toContain("fishmem remember");
		expect(context).toContain("Deploys use wrangler");
	});
});
