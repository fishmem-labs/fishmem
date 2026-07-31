import { describe, expect, it, vi } from "vitest";
import {
  enforcePublicApiRateLimit,
  withPublicApiRateHeaders,
} from "./rate-limit";

describe("public API rate limiting", () => {
  it("uses a stable opaque identity and allows requests below the limit", async () => {
    const limit = vi.fn().mockResolvedValue({ success: true });
    const request = new Request("https://fishmem.test/v1/memories", {
      headers: { authorization: "Bearer fm_secret" },
    });
    await expect(
      enforcePublicApiRateLimit(request, { limit }),
    ).resolves.toBeNull();
    await enforcePublicApiRateLimit(request, { limit });
    expect(limit).toHaveBeenCalledTimes(2);
    expect(limit.mock.calls[0]![0].key).toBe(limit.mock.calls[1]![0].key);
    expect(limit.mock.calls[0]![0].key).not.toContain("fm_secret");
  });

  it("returns a contract error and retry policy when the limit is exceeded", async () => {
    const response = await enforcePublicApiRateLimit(
      new Request("https://fishmem.test/v1/memories", {
        headers: { "cf-connecting-ip": "203.0.113.4" },
      }),
      { limit: vi.fn().mockResolvedValue({ success: false }) },
    );
    expect(response?.status).toBe(429);
    expect(response?.headers.get("Retry-After")).toBe("60");
    expect(response?.headers.get("RateLimit-Policy")).toBe("600;w=60");
    await expect(response?.json()).resolves.toMatchObject({
      code: "RATE_LIMITED",
      request_id: expect.any(String),
    });
  });

  it("adds limit policy headers without mutating the source response", () => {
    const source = Response.json({ ok: true });
    const shaped = withPublicApiRateHeaders(source);
    expect(shaped.headers.get("RateLimit-Limit")).toBe("600");
    expect(source.headers.get("RateLimit-Limit")).toBeNull();
  });
});
