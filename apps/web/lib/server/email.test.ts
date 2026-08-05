import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "@/lib/cloudflare";
import { sendMagicLinkEmail } from "./email";

function runtimeEnv(values: Partial<RuntimeEnv>): RuntimeEnv {
  return values as RuntimeEnv;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("magic-link delivery", () => {
  it("uses the console fallback instead of Wrangler's local EMAIL emulator", async () => {
    const send = vi.fn(async () => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await sendMagicLinkEmail({
      email: "developer@example.com",
      env: runtimeEnv({
        BETTER_AUTH_URL: "http://localhost:3000",
        EMAIL: { send } as unknown as SendEmail,
      }),
      url: "http://localhost:3000/api/auth/magic-link/verify?token=test",
    });

    expect(send).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledOnce();
  });

  it("retains EMAIL binding delivery for deployed runtimes", async () => {
    const send = vi.fn(async () => undefined);

    await sendMagicLinkEmail({
      email: "user@example.com",
      env: runtimeEnv({
        BETTER_AUTH_URL: "https://fishmem.com",
        EMAIL: { send } as unknown as SendEmail,
      }),
      url: "https://fishmem.com/api/auth/magic-link/verify?token=test",
    });

    expect(send).toHaveBeenCalledOnce();
  });
});
