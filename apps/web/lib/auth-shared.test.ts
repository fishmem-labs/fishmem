import { describe, expect, it } from "vitest";
import type { RuntimeEnv } from "@/lib/cloudflare";
import { loginMethodAvailability } from "./auth-shared";

function runtimeEnv(values: Partial<RuntimeEnv>): RuntimeEnv {
  return values as RuntimeEnv;
}

describe("login method availability", () => {
  it("hides an OAuth provider until both credentials exist", () => {
    const availability = loginMethodAvailability(
      runtimeEnv({
        BETTER_AUTH_URL: "https://fishmem.com",
        GOOGLE_CLIENT_ID: "client-id",
        GOOGLE_CLIENT_SECRET: "",
        GITHUB_CLIENT_ID: "",
        GITHUB_CLIENT_SECRET: "",
      }),
    );

    expect(availability.googleAuthEnabled).toBe(false);
    expect(availability.githubAuthEnabled).toBe(false);
  });

  it("offers complete OAuth providers and zero-config local magic links", () => {
    const deployed = loginMethodAvailability(
      runtimeEnv({
        BETTER_AUTH_URL: "https://fishmem.com",
        GOOGLE_CLIENT_ID: "client-id",
        GOOGLE_CLIENT_SECRET: "client-secret",
        GITHUB_CLIENT_ID: "",
        GITHUB_CLIENT_SECRET: "",
      }),
    );
    const local = loginMethodAvailability(
      runtimeEnv({
        BETTER_AUTH_URL: "http://localhost:3000",
        GOOGLE_CLIENT_ID: "",
        GOOGLE_CLIENT_SECRET: "",
        GITHUB_CLIENT_ID: "",
        GITHUB_CLIENT_SECRET: "",
      }),
    );

    expect(deployed.googleAuthEnabled).toBe(true);
    expect(local.magicLinkEnabled).toBe(true);
  });
});
