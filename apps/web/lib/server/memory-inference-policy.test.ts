import { describe, expect, it } from "vitest";
import {
  createMemoryInferencePolicySnapshot,
  DEFAULT_MEMORY_CATEGORIES,
  DEFAULT_MEMORY_INSTRUCTIONS,
  parseMemoryInferencePolicySnapshot,
} from "@/lib/server/memory-inference-policy";

describe("memory inference policy snapshots", () => {
  it("normalizes project settings into a deterministic snapshot", () => {
    const snapshot = createMemoryInferencePolicySnapshot({
      instructions: "  Remember durable preferences.  ",
      categories: [" Preference ", "preference", "", 42],
      updatedAt: "2026-08-22T01:02:03+08:00",
    });

    expect(snapshot).toEqual({
      version: 1,
      instructions: "Remember durable preferences.",
      categories: ["Preference"],
      source_updated_at: "2026-08-21T17:02:03.000Z",
    });
    expect(parseMemoryInferencePolicySnapshot(snapshot)).toEqual(snapshot);
  });

  it("uses safe defaults and rejects ambiguous stored snapshots", () => {
    expect(createMemoryInferencePolicySnapshot()).toEqual({
      version: 1,
      instructions: DEFAULT_MEMORY_INSTRUCTIONS,
      categories: DEFAULT_MEMORY_CATEGORIES,
      source_updated_at: null,
    });
    expect(() =>
      parseMemoryInferencePolicySnapshot({
        version: 1,
        instructions: "Remember preferences.",
        categories: ["Preference", "preference"],
        source_updated_at: null,
      }),
    ).toThrow("Invalid memory inference policy snapshot");
  });
});
