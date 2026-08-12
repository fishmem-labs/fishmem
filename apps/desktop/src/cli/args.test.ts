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
			params: { content: "Use FishMem branding" },
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
});
