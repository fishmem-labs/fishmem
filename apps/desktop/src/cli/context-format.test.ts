import { describe, expect, it } from "vitest";
import type { DesktopMemoryRecord } from "../shared/protocol";
import { approximateTokens, formatMemoryContext } from "./context-format";

function record(
	id: string,
	content: string,
	extra: Partial<DesktopMemoryRecord> = {},
): DesktopMemoryRecord {
	return {
		id,
		content,
		memoryType: "decision",
		importance: 0.5,
		createdAt: "2026-09-01T10:00:00.000Z",
		updatedAt: "2026-09-01T10:00:00.000Z",
		lastAccessedAt: "2026-09-01T10:00:00.000Z",
		accessCount: 0,
		...extra,
	};
}

describe("formatMemoryContext", () => {
	it("renders a compact block and omits superseded or expired memories", () => {
		const text = formatMemoryContext(
			[
				record("m1", "Deploy with   wrangler.", {
					metadata: { fishmemProject: "acme" },
				}),
				record("m2", "Old deploy target", { supersededBy: "m1" }),
				record("m3", "Expired fact", { validTo: "2026-01-01T00:00:00.000Z" }),
				record("m4", "Prefer pnpm"),
			],
			{ project: "acme", now: new Date("2026-09-25T00:00:00.000Z") },
		);
		expect(text).toContain("### FishMem memory (project: acme)");
		expect(text).toContain(
			"- Deploy with wrangler. (decision · project · 2026-09-01 · id m1)",
		);
		expect(text).toContain("- Prefer pnpm (decision · global · 2026-09-01 · id m4)");
		expect(text).not.toContain("Old deploy target");
		expect(text).not.toContain("Expired fact");
	});

	it("stays within the token budget and reports omissions", () => {
		const records = Array.from({ length: 30 }, (_, index) =>
			record(`m${index}`, `Memory number ${index} ${"x".repeat(200)}`),
		);
		const text = formatMemoryContext(records, { budgetTokens: 300 });
		expect(approximateTokens(text)).toBeLessThanOrEqual(300);
		expect(text).toMatch(/more results omitted/);
	});

	it("returns an empty string when nothing fits or nothing is current", () => {
		expect(formatMemoryContext([])).toBe("");
		expect(
			formatMemoryContext([record("m1", "x".repeat(400))], { budgetTokens: 20 }),
		).toBe("");
	});
});
