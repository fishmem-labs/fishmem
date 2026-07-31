import { describe, expect, it } from "vitest";
import { createSqliteStateSidecar } from "../src/core/sidecar-drizzle.js";

const scope = { userId: "u1" };

describe("DrizzleStateSidecar (libSQL :memory:) — persistent state slots", () => {
  it("upserts, merges, supersedes, keeps history, honours asOf, in SQL", async () => {
    const sc = await createSqliteStateSidecar({ url: ":memory:" });

    await sc.upsert({
      scope,
      subject: "Mel",
      attribute: "residence",
      value: "lives in Beijing",
      validFrom: new Date("2023-01-01"),
      sources: ["r1"],
    });
    expect((await sc.getState(scope, "Mel", "residence"))?.value).toBe(
      "lives in Beijing",
    );

    // identical value → merge provenance, no new slot
    await sc.upsert({
      scope,
      subject: "Mel",
      attribute: "residence",
      value: "lives in Beijing",
      validFrom: new Date("2023-02-01"),
      sources: ["r2"],
    });
    expect(await sc.getStateHistory(scope, "Mel", "residence")).toHaveLength(1);
    expect(
      (await sc.getState(scope, "Mel", "residence"))?.sources.sort(),
    ).toEqual(["r1", "r2"]);

    // different value → supersede (close old, open new)
    await sc.upsert({
      scope,
      subject: "Mel",
      attribute: "residence",
      value: "lives in Shanghai",
      validFrom: new Date("2024-08-01"),
      sources: ["r3"],
    });
    expect((await sc.getState(scope, "Mel", "residence"))?.value).toBe(
      "lives in Shanghai",
    );
    const hist = await sc.getStateHistory(scope, "Mel", "residence");
    expect(hist).toHaveLength(2);
    expect(hist[0]!.value).toBe("lives in Beijing");
    expect(hist[0]!.validTo).toEqual(new Date("2024-08-01"));
    expect(hist[1]!.validTo).toBeUndefined();
    expect(
      (
        await sc.getState(scope, "Mel", "residence", {
          asOf: new Date("2023-06-01"),
        })
      )?.value,
    ).toBe("lives in Beijing");

    // case-insensitive key + scope isolation
    expect((await sc.getState(scope, "mel", "RESIDENCE"))?.value).toBe(
      "lives in Shanghai",
    );
    expect(
      await sc.getState({ userId: "other" }, "Mel", "residence"),
    ).toBeUndefined();

    // clear (rebuild prep)
    await sc.clear(scope);
    expect(await sc.getState(scope, "Mel", "residence")).toBeUndefined();
    await sc.close?.();
  });
});
