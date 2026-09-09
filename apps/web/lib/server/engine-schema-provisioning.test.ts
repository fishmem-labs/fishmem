import { describe, expect, it } from "vitest";
import { provisionEngineSchema } from "./memory-api";

/**
 * A D1 stub that records how many round trips a caller spends, and persists the
 * fingerprint the provisioning pass writes. `batch` counts as one trip no
 * matter how many statements it carries, which is the property the pass relies
 * on: D1 is reached over RPC, so trips — not statements — are the cost.
 */
function fakeD1(initialFingerprint?: string) {
  const trips: string[] = [];
  const state = new Map<string, string>();
  if (initialFingerprint !== undefined) {
    state.set("fingerprint", initialFingerprint);
  }

  function statement(sql: string, bound: unknown[] = []) {
    return {
      sql,
      bind: (...args: unknown[]) => statement(sql, args),
      async run() {
        trips.push(`run:${sql.slice(0, 40)}`);
        if (sql.includes("INSERT INTO fishmem_schema_state")) {
          state.set("fingerprint", String(bound[0]));
        }
        return { success: true };
      },
      async all() {
        trips.push(`all:${sql.slice(0, 40)}`);
        // Report every required column so no ALTER is queued.
        return {
          results: [
            "namespace_id",
            "subject",
            "attribute",
            "episode_id",
            "projection_hints",
            "command",
            "lease_expires_at",
            "attempts",
          ].map((name) => ({ name })),
        };
      },
      async first() {
        trips.push(`first:${sql.slice(0, 40)}`);
        if (sql.includes("fishmem_schema_state")) {
          const value = state.get("fingerprint");
          // A database that was never provisioned has no marker table at all.
          if (value === undefined) throw new Error("no such table");
          return { value };
        }
        return null;
      },
    };
  }

  return {
    trips,
    fingerprint: () => state.get("fingerprint"),
    binding: {
      prepare: (sql: string) => statement(sql),
      async batch(statements: Array<{ sql: string }>) {
        trips.push(`batch:${statements.length}`);
        return statements.map(() => ({ success: true }));
      },
    } as unknown as D1Database,
  };
}

describe("engine schema provisioning", () => {
  it("provisions an unseen database in a bounded number of round trips", async () => {
    const d1 = fakeD1();

    await expect(provisionEngineSchema(d1.binding)).resolves.toBe(true);

    // The DDL set travels as batches, never one statement per round trip: the
    // ~40 statements this build applies must not cost ~40 trips.
    const batched = d1.trips.filter((trip) => trip.startsWith("batch:"));
    expect(batched.length).toBeLessThanOrEqual(2);
    expect(batched.some((trip) => Number(trip.split(":")[1]) > 30)).toBe(true);
    expect(d1.trips.length).toBeLessThanOrEqual(12);
    // The fingerprint lands only after the schema work succeeded.
    expect(d1.trips.at(-1)).toContain("INSERT INTO fishmem_schema_state");
    expect(d1.fingerprint()).toMatch(/^v1:\d+:[0-9a-f]+$/);
  });

  it("spends exactly one round trip once the fingerprint matches", async () => {
    const d1 = fakeD1();
    await provisionEngineSchema(d1.binding);
    d1.trips.length = 0;

    await expect(provisionEngineSchema(d1.binding)).resolves.toBe(false);

    expect(d1.trips).toHaveLength(1);
    expect(d1.trips[0]).toContain("SELECT value FROM fishmem_schema_state");
  });

  it("re-runs when the applied fingerprint came from a different build", async () => {
    const d1 = fakeD1("v1:0:deadbeef");

    await expect(provisionEngineSchema(d1.binding)).resolves.toBe(true);

    expect(d1.trips.some((trip) => trip.startsWith("batch:"))).toBe(true);
    expect(d1.fingerprint()).not.toBe("v1:0:deadbeef");
  });
});
