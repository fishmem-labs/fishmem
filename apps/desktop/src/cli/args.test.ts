import { describe, expect, it } from "vitest";
import { parseCliArgs } from "./args";

describe("parseCliArgs", () => {
	it("parses an idempotent Desktop start command", () => {
		expect(
			parseCliArgs(["desktop", "start", "--timeout", "45", "--json"]),
		).toEqual({
			kind: "desktopStart",
			timeoutMs: 45_000,
		});
		expect(() => parseCliArgs(["desktop", "stop"])).toThrow(
			"requires the start command",
		);
	});

	it("parses semantic search arguments", () => {
		expect(
			parseCliArgs([
				"search",
				"--query",
				"deployment decision",
				"--limit",
				"7",
				"--json",
			]),
		).toEqual({
			kind: "invoke",
			method: "search",
			params: { query: "deployment decision", limit: 7 },
		});
	});

	it("parses the stable SDK bridge command without shell interpretation", () => {
		expect(
			parseCliArgs([
				"call",
				"add",
				"--input",
				JSON.stringify({
					content: "Remember $HOME and `literal backticks`",
					user_id: "ada",
				}),
			]),
		).toEqual({
			kind: "invoke",
			method: "add",
			params: {
				content: "Remember $HOME and `literal backticks`",
				user_id: "ada",
			},
		});
		expect(() => parseCliArgs(["call", "unknown", "--input", "{}"])).toThrow(
			"supported Desktop method",
		);
	});

	it("accepts SDK payloads over stdin without putting source text in argv", () => {
		expect(parseCliArgs(["call", "documentIngest", "--input-stdin"])).toEqual({
			kind: "invoke",
			method: "documentIngest",
			inputFromStdin: true,
		});
		expect(() =>
			parseCliArgs([
				"call",
				"documentIngest",
				"--input-stdin",
				"--input",
				"{}",
			]),
		).toThrow("only one");
		expect(parseCliArgs(["call", "exportSnapshot"])).toEqual({
			kind: "invoke",
			method: "exportSnapshot",
		});
		expect(parseCliArgs(["call", "restoreSnapshot", "--input-stdin"])).toEqual({
			kind: "invoke",
			method: "restoreSnapshot",
			inputFromStdin: true,
		});
	});

	it("parses a memory passed positionally", () => {
		expect(parseCliArgs(["add", "Use FishMem branding"])).toEqual({
			kind: "invoke",
			method: "add",
			params: { content: "Use FishMem branding", check_similar: true },
		});
	});

	it("attaches explicit URL provenance to a distilled memory", () => {
		expect(
			parseCliArgs([
				"add",
				"--content",
				"FishMem keeps local memories in SQLite.",
				"--source",
				"https://example.com/fishmem",
				"--title",
				"FishMem architecture",
				"--source-kind",
				"url",
			]),
		).toEqual({
			kind: "invoke",
			method: "add",
			params: {
				content: "FishMem keeps local memories in SQLite.",
				metadata: {
					source: "https://example.com/fishmem",
					title: "FishMem architecture",
					sourceKind: "url",
				},
				check_similar: true,
			},
		});
	});

	it("records the client that submitted a memory without scoping recall", () => {
		expect(
			parseCliArgs([
				"add",
				"--client",
				"codex",
				"--content",
				"One private memory. Every agent.",
			]),
		).toEqual({
			kind: "invoke",
			method: "add",
			params: {
				content: "One private memory. Every agent.",
				metadata: { fishmemClient: "codex" },
				check_similar: true,
			},
		});
	});

	it("only accepts the Desktop integrations that are actually supported", () => {
		expect(() =>
			parseCliArgs([
				"add",
				"--client",
				"openclaw",
				"--content",
				"unsupported client",
			]),
		).toThrow("--client must be codex or claude-code");
	});

	it("rejects unknown commands", () => {
		expect(() => parseCliArgs(["unknown"])).toThrow("Unknown command");
	});

	it("scopes writes to the detected project unless --global or --project is given", () => {
		const options = { defaultProject: "fishmem" };
		expect(parseCliArgs(["add", "Prefer pnpm"], options)).toEqual({
			kind: "invoke",
			method: "add",
			params: { content: "Prefer pnpm", project: "fishmem", check_similar: true },
		});
		expect(
			parseCliArgs(["add", "--global", "--force", "Prefer pnpm"], options),
		).toEqual({
			kind: "invoke",
			method: "add",
			params: { content: "Prefer pnpm", force: true },
		});
		expect(
			parseCliArgs(["add", "--project", "other", "--content", "x"], options),
		).toMatchObject({ params: { project: "other" } });
		expect(() =>
			parseCliArgs(["add", "--global", "--project", "a", "x"], options),
		).toThrow("only one");
	});

	it("parses remember, update, supersede, and invalidate", () => {
		const options = { defaultProject: "fishmem" };
		expect(
			parseCliArgs(["remember", "--content", "Use WAL", "--limit", "3"], options),
		).toEqual({
			kind: "invoke",
			method: "remember",
			params: { content: "Use WAL", limit: 3, project: "fishmem" },
		});
		expect(
			parseCliArgs(["update", "--id", "m1", "--content", "Refined"], options),
		).toEqual({
			kind: "invoke",
			method: "update",
			params: { id: "m1", content: "Refined" },
		});
		expect(
			parseCliArgs(
				["supersede", "--id", "m1", "--client", "codex", "--content", "New"],
				options,
			),
		).toEqual({
			kind: "invoke",
			method: "supersede",
			params: { id: "m1", content: "New", metadata: { fishmemClient: "codex" } },
		});
		expect(
			parseCliArgs(["invalidate", "--id", "m1", "--superseded-by", "m2"]),
		).toEqual({
			kind: "invoke",
			method: "invalidate",
			params: { id: "m1", superseded_by: "m2" },
		});
		expect(() => parseCliArgs(["update", "Refined"])).toThrow("--id");
		expect(() =>
			parseCliArgs(["update", "--id", "m1", "--client", "codex", "x"]),
		).toThrow("Provide memory content");
	});

	it("parses project-scoped search filters and the context output format", () => {
		const now = new Date("2026-09-25T00:00:00.000Z");
		expect(
			parseCliArgs(
				[
					"search",
					"--query",
					"deploy",
					"--min-score",
					"0.8",
					"--type",
					"decision",
					"--since",
					"7d",
					"--format",
					"context",
					"--budget",
					"600",
				],
				{ defaultProject: "fishmem", now },
			),
		).toEqual({
			kind: "invoke",
			method: "search",
			params: {
				query: "deploy",
				limit: 10,
				project: "fishmem",
				min_similarity: 0.8,
				memory_type: "decision",
				since: "2026-09-18T00:00:00.000Z",
			},
			output: { format: "context", budgetTokens: 600, project: "fishmem" },
		});
		expect(
			parseCliArgs(["search", "deploy", "--all-projects"], {
				defaultProject: "fishmem",
			}),
		).toEqual({
			kind: "invoke",
			method: "search",
			params: { query: "deploy", limit: 10, all_projects: true },
		});
		expect(
			parseCliArgs(["search", "x", "--since", "2026-09-01"]),
		).toMatchObject({ params: { since: "2026-09-01T00:00:00.000Z" } });
		expect(() => parseCliArgs(["search", "x", "--min-score", "2"])).toThrow(
			"between 0 and 1",
		);
		expect(() => parseCliArgs(["search", "x", "--format", "xml"])).toThrow(
			"json or context",
		);
		expect(() => parseCliArgs(["search", "x", "--type", "nope"])).toThrow(
			"--type",
		);
		expect(() => parseCliArgs(["search", "x", "--since", "soon"])).toThrow(
			"--since",
		);
	});

	it("lists the current project by default and every project on request", () => {
		expect(parseCliArgs(["list"], { defaultProject: "fishmem" })).toEqual({
			kind: "invoke",
			method: "list",
			params: { limit: 50, project: "fishmem" },
		});
		expect(
			parseCliArgs(["list", "--all-projects"], { defaultProject: "fishmem" }),
		).toEqual({ kind: "invoke", method: "list", params: { limit: 50 } });
		expect(
			parseCliArgs(["duplicates", "--threshold", "0.95"], {
				defaultProject: "fishmem",
			}),
		).toEqual({
			kind: "invoke",
			method: "duplicates",
			params: { limit: 200, threshold: 0.95, project: "fishmem" },
		});
	});

	it("parses hook, maintenance, and integration commands", () => {
		expect(parseCliArgs(["hook", "prompt"])).toEqual({
			kind: "hook",
			event: "prompt",
		});
		expect(parseCliArgs(["hook", "session-start"])).toEqual({
			kind: "hook",
			event: "session-start",
		});
		expect(() => parseCliArgs(["hook", "stop"])).toThrow("session-start");
		expect(parseCliArgs(["maintenance", "run"])).toEqual({
			kind: "invoke",
			method: "maintenance",
		});
		expect(parseCliArgs(["integrations", "install", "--all"])).toEqual({
			kind: "integrations",
			action: "install",
			clients: ["claude-code", "codex"],
		});
		expect(
			parseCliArgs(["integrations", "uninstall", "--client", "codex"]),
		).toEqual({ kind: "integrations", action: "uninstall", clients: ["codex"] });
		expect(parseCliArgs(["integrations", "status"])).toEqual({
			kind: "integrations",
			action: "status",
			clients: [],
		});
		expect(() => parseCliArgs(["integrations", "install"])).toThrow(
			"--all or --client",
		);
		expect(parseCliArgs(["call", "remember", "--input", "{}"])).toEqual({
			kind: "invoke",
			method: "remember",
			params: {},
		});
	});
});
