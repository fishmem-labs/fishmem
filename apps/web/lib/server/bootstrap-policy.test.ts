import { describe, expect, it } from "vitest";
import { firstUserSetupAuthorized } from "./bootstrap-policy";

describe("first-user bootstrap policy", () => {
  it("allows tokenless local development", async () => {
    await expect(
      firstUserSetupAuthorized({ production: false }),
    ).resolves.toBe(true);
  });

  it("locks a production install when no token is configured", async () => {
    await expect(
      firstUserSetupAuthorized({ production: true }),
    ).resolves.toBe(false);
  });

  it("requires an exact configured token", async () => {
    await expect(
      firstUserSetupAuthorized({
        configuredToken: "correct horse battery staple",
        providedToken: "correct horse battery staple",
        production: true,
      }),
    ).resolves.toBe(true);
    await expect(
      firstUserSetupAuthorized({
        configuredToken: "correct horse battery staple",
        providedToken: "wrong",
        production: true,
      }),
    ).resolves.toBe(false);
  });
});
