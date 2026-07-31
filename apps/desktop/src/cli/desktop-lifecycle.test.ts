import { describe, expect, it, vi } from "vitest";
import { startDesktop } from "./desktop-lifecycle";

describe("FishMem Desktop lifecycle", () => {
  it("is idempotent when Desktop is already ready", async () => {
    const launch = vi.fn();
    await expect(
      startDesktop(
        {},
        {
          status: vi.fn().mockResolvedValue({ database: "ready" }),
          launch,
          now: () => 100,
          wait: vi.fn(),
        },
      ),
    ).resolves.toEqual({
      status: "ready",
      launched: false,
      waited_ms: 0,
      desktop: { database: "ready" },
    });
    expect(launch).not.toHaveBeenCalled();
  });

  it("launches the app and waits for socket readiness", async () => {
    let now = 0;
    const status = vi
      .fn()
      .mockRejectedValueOnce(new Error("not running"))
      .mockRejectedValueOnce(new Error("booting"))
      .mockResolvedValueOnce({ database: "ready" });
    const launch = vi.fn().mockResolvedValue(undefined);
    await expect(
      startDesktop(
        { timeoutMs: 1_000 },
        {
          status,
          launch,
          now: () => now,
          wait: vi.fn(async (delayMs) => {
            now += delayMs;
          }),
        },
      ),
    ).resolves.toEqual({
      status: "ready",
      launched: true,
      waited_ms: 250,
      desktop: { database: "ready" },
    });
    expect(launch).toHaveBeenCalledOnce();
  });
});
