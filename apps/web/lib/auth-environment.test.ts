import { describe, expect, it } from "vitest";
import type { RuntimeEnv } from "@/lib/cloudflare";
import { isLocalAuthEnvironment } from "./auth-environment";

function runtimeEnv(values: Partial<RuntimeEnv>): RuntimeEnv {
  return values as RuntimeEnv;
}

describe("local auth environment", () => {
  it.each([
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://0.0.0.0:3000",
    "http://[::1]:3000",
  ])("recognizes %s", (url) => {
    expect(
      isLocalAuthEnvironment(runtimeEnv({ BETTER_AUTH_URL: url })),
    ).toBe(true);
  });

  it("does not treat a deployed URL as local", () => {
    expect(
      isLocalAuthEnvironment(
        runtimeEnv({ BETTER_AUTH_URL: "https://fishmem.com" }),
      ),
    ).toBe(false);
  });
});
