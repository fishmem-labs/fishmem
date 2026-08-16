import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type BeliefObservation,
  BeliefReconciler,
  InMemoryBeliefEvidenceStore,
} from "../src/core/belief-reconciler.js";
import {
  createD1BeliefReconciler,
  createSqliteBeliefReconciler,
} from "../src/core/belief-reconciler-drizzle.js";
import { MockEmbedder } from "../src/embeddings/mock.js";
import { InMemoryGraphStore } from "../src/graph/memory-store.js";
import { createSqliteGraphStore } from "../src/graph/sqlite.js";
import { MockLLM, type MockResponder } from "../src/llms/mock.js";
import { Memory, type Scope } from "../src/memory.js";
import { InMemoryVectorStore } from "../src/vector/memory.js";
import { SqliteVectorStore } from "../src/vector/sqlite.js";

const policy = {
  minimumEvidence: 3,
  minimumContexts: 3,
  minimumSupport: 0.6,
  minimumLead: 1,
} as const;

function observation(
  value: string,
  sourceId: string,
  contextId: string,
  overrides: Partial<BeliefObservation> = {},
): BeliefObservation {
  return {
    scope: { namespaceId: "workspace-a", userId: "ada" },
    subject: "Ada",
    attribute: "editor-theme",
    value,
    sourceId,
    evidenceKey: sourceId,
    contextId,
    applicability: { kind: "global" },
    observedAt: new Date(`2026-01-${sourceId.slice(-2)}T00:00:00.000Z`),
    validFrom: new Date("2026-01-01T00:00:00.000Z"),
    weight: 1,
    ...overrides,
  };
}

describe("BeliefReconciler lifecycle", () => {
  it("keeps weak evidence contested, deduplicates echoes, and exposes audit provenance", async () => {
    const reconciler = new BeliefReconciler({ policy });

    await reconciler.observe(observation("dark", "source-01", "task-1"));
    await reconciler.observe(
      observation("dark", "source-02", "task-2", {
        evidenceKey: "source-01",
      }),
    );
    await reconciler.observe(observation("dark", "source-03", "task-3"));

    const defaultView = await reconciler.view(
      { namespaceId: "workspace-a", userId: "ada" },
      "ada",
      "EDITOR-THEME",
      { mode: "default", applicability: { kind: "global" } },
    );
    expect(defaultView.winner).toBeUndefined();
    expect(defaultView.candidates).toEqual([]);
    expect(defaultView.unresolved).toBe(true);

    const conflict = await reconciler.view(
      { namespaceId: "workspace-a", userId: "ada" },
      "Ada",
      "editor-theme",
      { mode: "conflict", applicability: { kind: "global" } },
    );
    expect(conflict.candidates).toHaveLength(1);
    expect(conflict.candidates[0]).toMatchObject({
      status: "contested",
      evidenceCount: 2,
      contextCount: 2,
      sourceIds: ["source-01", "source-02", "source-03"],
    });
    expect(conflict.candidates[0]!.evidence).toBeUndefined();

    const audit = await reconciler.view(
      { namespaceId: "workspace-a", userId: "ada" },
      "Ada",
      "editor-theme",
      { mode: "audit", applicability: { kind: "global" } },
    );
    expect(audit.candidates[0]!.evidence).toHaveLength(3);
    expect(audit.candidates[0]!.reasonCodes).toContain(
      "insufficient_independent_evidence",
    );
  });

  it("selects a supported winner, reopens a tie, and can select a new winner", async () => {
    const reconciler = new BeliefReconciler({ policy });
    for (let index = 1; index <= 3; index++) {
      await reconciler.observe(
        observation("dark", `source-0${index}`, `task-${index}`),
      );
    }
    await reconciler.observe(observation("light", "source-04", "task-4"));

    let view = await reconciler.view(
      { namespaceId: "workspace-a", userId: "ada" },
      "Ada",
      "editor-theme",
      { mode: "conflict", applicability: { kind: "global" } },
    );
    expect(view.winner?.value).toBe("dark");
    expect(view.winner?.status).toBe("supported");
    expect(
      view.candidates.find((candidate) => candidate.value === "light")?.status,
    ).toBe("superseded");

    await reconciler.observe(observation("light", "source-05", "task-5"));
    await reconciler.observe(observation("light", "source-06", "task-6"));
    view = await reconciler.view(
      { namespaceId: "workspace-a", userId: "ada" },
      "Ada",
      "editor-theme",
      { mode: "conflict", applicability: { kind: "global" } },
    );
    expect(view.winner).toBeUndefined();
    expect(view.unresolved).toBe(true);
    expect(
      view.candidates.every((candidate) => candidate.status === "contested"),
    ).toBe(true);

    await reconciler.observe(observation("light", "source-07", "task-7"));
    await reconciler.observe(observation("light", "source-08", "task-8"));
    view = await reconciler.view(
      { namespaceId: "workspace-a", userId: "ada" },
      "Ada",
      "editor-theme",
      { mode: "audit", applicability: { kind: "global" } },
    );
    expect(view.winner?.value).toBe("light");
    expect(view.winner?.evidenceCount).toBe(5);
    expect(
      view.candidates.find((candidate) => candidate.value === "dark")
        ?.supersededBy,
    ).toBe(view.winner?.id);
  });

  it("keeps applicability and ownership separate, with contextual override and time windows", async () => {
    const reconciler = new BeliefReconciler({ policy });
    for (let index = 1; index <= 3; index++) {
      await reconciler.observe(
        observation("dark", `global-0${index}`, `global-task-${index}`),
      );
      await reconciler.observe(
        observation("light", `local-0${index}`, `local-task-${index}`, {
          applicability: {
            kind: "task",
            key: "design-review",
            validTo: new Date("2026-06-01T00:00:00.000Z"),
          },
        }),
      );
    }

    const local = await reconciler.view(
      { namespaceId: "workspace-a", userId: "ada" },
      "Ada",
      "editor-theme",
      {
        mode: "conflict",
        applicability: { kind: "task", key: "design-review" },
        at: new Date("2026-05-01T00:00:00.000Z"),
      },
    );
    expect(local.winner?.value).toBe("light");
    expect(local.reasonCodes).toContain("contextual_override");

    const expired = await reconciler.view(
      { namespaceId: "workspace-a", userId: "ada" },
      "Ada",
      "editor-theme",
      {
        mode: "audit",
        applicability: { kind: "task", key: "design-review" },
        at: new Date("2026-07-01T00:00:00.000Z"),
      },
    );
    expect(expired.winner?.value).toBe("dark");
    expect(expired.reasonCodes).toContain("global_fallback");
    expect(
      expired.candidates
        .find((candidate) => candidate.value === "light")
        ?.reasonCodes.includes("outside_applicability_window"),
    ).toBe(true);

    const otherOwner = await reconciler.view(
      { namespaceId: "workspace-b", userId: "ada" },
      "Ada",
      "editor-theme",
      { mode: "audit", applicability: { kind: "global" } },
    );
    expect(otherOwner.candidates).toEqual([]);
  });

  it("does not leak a global fallback into a context with active contested evidence", async () => {
    const reconciler = new BeliefReconciler({ policy });
    for (let index = 1; index <= 3; index++) {
      await reconciler.observe(
        observation("dark", `global-0${index}`, `global-task-${index}`),
      );
    }
    await reconciler.observe(
      observation("light", "local-01", "local-task-1", {
        applicability: { kind: "task", key: "design-review" },
      }),
    );

    const view = await reconciler.view(
      { namespaceId: "workspace-a", userId: "ada" },
      "Ada",
      "editor-theme",
      {
        mode: "conflict",
        applicability: { kind: "task", key: "design-review" },
      },
    );
    expect(view.winner).toBeUndefined();
    expect(view.unresolved).toBe(true);
    expect(view.reasonCodes).not.toContain("global_fallback");
  });

  it("makes overlapping validity windows compete inside one applicability context", async () => {
    const reconciler = new BeliefReconciler({ policy });
    for (let index = 1; index <= 3; index++) {
      await reconciler.observe(
        observation("dark", `dark-0${index}`, `dark-task-${index}`, {
          applicability: {
            kind: "task",
            key: "design-review",
            validFrom: new Date("2026-01-01T00:00:00.000Z"),
            validTo: new Date("2026-12-01T00:00:00.000Z"),
          },
        }),
      );
      await reconciler.observe(
        observation("light", `light-0${index}`, `light-task-${index}`, {
          applicability: {
            kind: "task",
            key: "design-review",
            validFrom: new Date("2026-02-01T00:00:00.000Z"),
            validTo: new Date("2026-11-01T00:00:00.000Z"),
          },
        }),
      );
    }

    const view = await reconciler.view(
      { namespaceId: "workspace-a", userId: "ada" },
      "Ada",
      "editor-theme",
      {
        mode: "audit",
        applicability: { kind: "task", key: "design-review" },
        at: new Date("2026-03-01T00:00:00.000Z"),
      },
    );
    expect(view.winner).toBeUndefined();
    expect(view.unresolved).toBe(true);
    expect(view.candidates).toHaveLength(2);
    expect(view.candidates[0]?.applicability).toEqual({
      kind: "task",
      key: "design-review",
    });
    expect(
      view.candidates.flatMap((candidate) => candidate.evidence ?? []),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          applicability: expect.objectContaining({
            validFrom: new Date("2026-01-01T00:00:00.000Z"),
          }),
        }),
        expect.objectContaining({
          applicability: expect.objectContaining({
            validFrom: new Date("2026-02-01T00:00:00.000Z"),
          }),
        }),
      ]),
    );
  });

  it("clusters paraphrases by the extractor's frozen semantic claim value", async () => {
    const reconciler = new BeliefReconciler({ policy });
    for (const [index, text] of [
      "Ada prefers dark mode",
      "Dark mode is Ada's editor preference",
      "Ada wants the editor theme set to dark",
    ].entries()) {
      await reconciler.observe(
        observation(text, `source-0${index + 1}`, `task-${index + 1}`, {
          claimValue: "dark mode",
        }),
      );
    }

    const view = await reconciler.view(
      { namespaceId: "workspace-a", userId: "ada" },
      "Ada",
      "editor-theme",
      { mode: "audit", applicability: { kind: "global" } },
    );
    expect(view.candidates).toHaveLength(1);
    expect(view.winner).toMatchObject({
      value: "dark mode",
      evidenceCount: 3,
      contextCount: 3,
    });
  });

  it("rejects one independence key claiming two active values", async () => {
    const reconciler = new BeliefReconciler({ policy });
    await reconciler.observe(observation("dark", "source-01", "task-1"));
    await expect(
      reconciler.observe(
        observation("light", "source-02", "task-1", {
          evidenceKey: "source-01",
        }),
      ),
    ).rejects.toThrow(/evidence key.*conflicting values/i);
  });

  it("quarantines a conflicting independence key even when concurrent writes bypass the preflight check", async () => {
    let reads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    class RacingStore extends InMemoryBeliefEvidenceStore {
      override async listSlot(
        scope: Scope,
        subjectKey: string,
        attributeKey: string,
      ) {
        const rows = await super.listSlot(scope, subjectKey, attributeKey);
        reads++;
        if (reads === 2) release();
        if (reads <= 2) await gate;
        return rows;
      }
    }
    const reconciler = new BeliefReconciler({
      store: new RacingStore(),
      policy,
    });
    const [dark, light] = await Promise.allSettled([
      reconciler.observe(
        observation("dark", "source-01", "task-1", {
          evidenceKey: "shared-source",
        }),
      ),
      reconciler.observe(
        observation("light", "source-02", "task-2", {
          evidenceKey: "shared-source",
        }),
      ),
    ]);
    expect([dark.status, light.status]).toEqual(["fulfilled", "fulfilled"]);

    const view = await reconciler.view(
      { namespaceId: "workspace-a", userId: "ada" },
      "Ada",
      "editor-theme",
      { mode: "audit", applicability: { kind: "global" } },
    );
    expect(view.winner).toBeUndefined();
    expect(view.unresolved).toBe(true);
    expect(view.reasonCodes).toContain("conflicting_independence_key");
    expect(view.candidates).toHaveLength(2);
    expect(
      view.candidates.every((candidate) => candidate.evidenceCount === 0),
    ).toBe(true);
    expect(
      view.candidates
        .flatMap((candidate) => candidate.evidence ?? [])
        .every((evidence) => evidence.active === false),
    ).toBe(true);
  });
});

describe("SQLite belief projection adapter", () => {
  it("matches the module interface and supports source invalidation, deletion, and scoped rebuild clears", async () => {
    const reconciler = await createSqliteBeliefReconciler({
      url: ":memory:",
      policy: { ...policy, minimumEvidence: 1, minimumContexts: 1 },
    });
    await reconciler.observe(observation("dark", "source-01", "task-1"));
    expect(
      (
        await reconciler.view(
          { namespaceId: "workspace-a", userId: "ada" },
          "Ada",
          "editor-theme",
          { mode: "audit", applicability: { kind: "global" } },
        )
      ).winner?.value,
    ).toBe("dark");

    await reconciler.invalidateSource(
      "source-01",
      new Date("2026-02-01T00:00:00.000Z"),
    );
    const invalidated = await reconciler.view(
      { namespaceId: "workspace-a", userId: "ada" },
      "Ada",
      "editor-theme",
      {
        mode: "audit",
        applicability: { kind: "global" },
        at: new Date("2026-03-01T00:00:00.000Z"),
      },
    );
    expect(invalidated.winner).toBeUndefined();
    expect(invalidated.candidates[0]!.reasonCodes).toContain(
      "no_active_evidence",
    );

    await reconciler.removeSource("source-01");
    expect(
      (
        await reconciler.view(
          { namespaceId: "workspace-a", userId: "ada" },
          "Ada",
          "editor-theme",
          { mode: "audit", applicability: { kind: "global" } },
        )
      ).candidates,
    ).toEqual([]);

    await reconciler.observe(observation("dark", "source-02", "task-2"));
    await reconciler.observe(
      observation("light", "other-01", "task-1", {
        scope: { namespaceId: "workspace-b", userId: "ada" },
      }),
    );
    await reconciler.clear({ namespaceId: "workspace-a" });
    expect(
      (
        await reconciler.view(
          { namespaceId: "workspace-a", userId: "ada" },
          "Ada",
          "editor-theme",
          { mode: "audit", applicability: { kind: "global" } },
        )
      ).candidates,
    ).toEqual([]);
    expect(
      (
        await reconciler.view(
          { namespaceId: "workspace-b", userId: "ada" },
          "Ada",
          "editor-theme",
          { mode: "audit", applicability: { kind: "global" } },
        )
      ).candidates,
    ).toHaveLength(1);
    await reconciler.close();
  });
});

describe("D1 belief projection adapter", () => {
  it("persists, reads, and invalidates governed evidence through a real D1 binding", async () => {
    const { Miniflare } = await import("miniflare");
    const miniflare = new Miniflare({
      d1Databases: { DB: randomUUID() },
      modules: true,
      script: "export default { fetch() { return new Response('ok') } }",
    });
    const database = await miniflare.getD1Database("DB");
    const reconciler = await createD1BeliefReconciler({
      binding: database,
      autoMigrate: true,
      policy: { ...policy, minimumEvidence: 1, minimumContexts: 1 },
    });

    try {
      await reconciler.observe(observation("dark", "source-01", "task-1"));
      const supported = await reconciler.view(
        { namespaceId: "workspace-a", userId: "ada" },
        "Ada",
        "editor-theme",
        { mode: "audit", applicability: { kind: "global" } },
      );
      expect(supported.winner?.value).toBe("dark");

      await reconciler.invalidateSource(
        "source-01",
        new Date("2026-02-01T00:00:00.000Z"),
      );
      const invalidated = await reconciler.view(
        { namespaceId: "workspace-a", userId: "ada" },
        "Ada",
        "editor-theme",
        {
          mode: "audit",
          applicability: { kind: "global" },
          at: new Date("2026-03-01T00:00:00.000Z"),
        },
      );
      expect(invalidated.winner).toBeUndefined();
      expect(invalidated.candidates[0]?.evidence?.[0]?.active).toBe(false);
    } finally {
      await reconciler.close();
      await miniflare.dispose();
    }
  });
});

describe("Memory belief-reconciliation integration", () => {
  it("does not read canonical records when belief projection is unconfigured or killed", async () => {
    class CountingGraphStore extends InMemoryGraphStore {
      getMemoryCalls = 0;

      override async getMemory(id: string) {
        this.getMemoryCalls++;
        return super.getMemory(id);
      }
    }

    for (const killSwitch of [undefined, () => true]) {
      const graphStore = new CountingGraphStore();
      const memory = await Memory.create({
        embedder: new MockEmbedder(128),
        llm: new MockLLM(() =>
          JSON.stringify({ facts: ["Remember this canonical fact"] }),
        ),
        vectorStore: new InMemoryVectorStore(),
        graphStore,
        autoAssociate: { enabled: false },
        derivation: killSwitch
          ? { enabled: true, beliefs: { enabled: true, killSwitch } }
          : { enabled: true },
      });

      await memory.add("Remember this canonical fact", { userId: "ada" });

      expect(graphStore.getMemoryCalls).toBe(0);
    }
  });

  it("projects inferred preferences in shadow mode, preserves canonical history, and rebuilds without an LLM", async () => {
    let llmCalls = 0;
    const responder: MockResponder = (messages) => {
      llmCalls++;
      const user = messages
        .filter((message) => message.role === "user")
        .map((message) => message.content)
        .join("\n");
      const beverage = user.includes("coffee") ? "coffee" : "tea";
      return JSON.stringify({
        facts: [
          {
            text: `Ada prefers ${beverage}`,
            subject: "Ada",
            attribute: "beverage",
            type: "preference",
            cardinality: "single",
            event_date: null,
          },
        ],
      });
    };
    const memory = await Memory.create({
      embedder: new MockEmbedder(128),
      llm: new MockLLM(responder),
      vectorStore: new InMemoryVectorStore(),
      graphStore: new InMemoryGraphStore(),
      autoAssociate: { enabled: false },
      derivation: {
        enabled: true,
        beliefs: {
          enabled: true,
          policy: {
            minimumEvidence: 2,
            minimumContexts: 2,
            minimumSupport: 0.6,
            minimumLead: 1,
          },
        },
      },
    });
    const addPreference = (beverage: "tea" | "coffee", index: number) =>
      memory.add(`Ada says ${beverage}`, {
        userId: "ada",
        applicability: { kind: "global" },
        evidenceKey: `turn-${index}`,
        evidenceContextId: `conversation-${index}`,
      });

    const first = await addPreference("tea", 1);
    let view = await memory.getBeliefView("Ada", "beverage", {
      userId: "ada",
      mode: "conflict",
      applicability: { kind: "global" },
    });
    expect(view.winner).toBeUndefined();
    expect(view.shadow.outcome).toBe("unresolved");

    const second = await addPreference("tea", 2);
    view = await memory.getBeliefView("Ada", "beverage", {
      userId: "ada",
      mode: "audit",
      applicability: { kind: "global" },
    });
    expect(view.winner?.value).toBe("Ada prefers tea");
    expect(view.shadow.outcome).toBe("agreement");

    await addPreference("coffee", 3);
    await addPreference("coffee", 4);
    view = await memory.getBeliefView("Ada", "beverage", {
      userId: "ada",
      mode: "conflict",
      applicability: { kind: "global" },
    });
    expect(view.winner).toBeUndefined();
    expect(view.candidates).toHaveLength(2);
    expect(view.shadow.outcome).toBe("unresolved");
    expect(view.shadow.state?.value).toBe("Ada prefers coffee");

    const canonicalBefore = await memory.getAll({ userId: "ada" });
    expect(canonicalBefore.results).toHaveLength(4);
    for (const record of canonicalBefore.results) {
      expect(await memory.history(record.id, { userId: "ada" })).toHaveLength(
        1,
      );
    }

    const callsBeforeRebuild = llmCalls;
    const rebuilt = await memory.rebuildBeliefs({ userId: "ada" });
    expect(rebuilt).toEqual({ evidence: 4, slots: 1 });
    expect(llmCalls).toBe(callsBeforeRebuild);
    expect(
      (
        await memory.getBeliefView("Ada", "beverage", {
          userId: "ada",
          mode: "conflict",
          applicability: { kind: "global" },
        })
      ).winner,
    ).toBeUndefined();

    await memory.update(first.results[0]!.id, "Ada prefers water", {
      userId: "ada",
    });
    view = await memory.getBeliefView("Ada", "beverage", {
      userId: "ada",
      mode: "audit",
      applicability: { kind: "global" },
    });
    expect(view.winner?.value).toBe("Ada prefers coffee");
    expect(
      view.candidates.some((candidate) => candidate.value.includes("water")),
    ).toBe(false);
    expect(
      await memory.history(second.results[0]!.id, { userId: "ada" }),
    ).toHaveLength(1);
  });

  it("does not reconcile infer:false writes and obeys the runtime kill switch", async () => {
    let killed = false;
    const memory = await Memory.create({
      embedder: new MockEmbedder(128),
      llm: new MockLLM(),
      vectorStore: new InMemoryVectorStore(),
      graphStore: new InMemoryGraphStore(),
      autoAssociate: { enabled: false },
      derivation: {
        enabled: true,
        beliefs: {
          enabled: true,
          killSwitch: () => killed,
          policy: { minimumEvidence: 1, minimumContexts: 1 },
        },
      },
    });
    await memory.add("Ada prefers tea", {
      infer: false,
      userId: "ada",
      applicability: { kind: "global" },
    });
    let view = await memory.getBeliefView("Ada", "beverage", {
      userId: "ada",
      mode: "audit",
      applicability: { kind: "global" },
    });
    expect(view.candidates).toEqual([]);

    killed = true;
    view = await memory.getBeliefView("Ada", "beverage", {
      userId: "ada",
      mode: "audit",
      applicability: { kind: "global" },
    });
    expect(view.projectionStatus).toBe("disabled");
    expect(view.reasonCodes).toContain("projection_disabled");
  });

  it("keeps the production extraction prompt unchanged outside the rollout allowlist", async () => {
    const prompts: string[] = [];
    const memory = await Memory.create({
      embedder: new MockEmbedder(128),
      llm: new MockLLM((messages) => {
        prompts.push(
          messages.find((message) => message.role === "system")?.content ?? "",
        );
        return JSON.stringify({
          facts: [
            {
              text: "Ada prefers tea",
              value: "tea",
              subject: "Ada",
              attribute: "beverage",
              type: "preference",
              cardinality: "single",
              event_date: null,
            },
          ],
        });
      }),
      vectorStore: new InMemoryVectorStore(),
      graphStore: new InMemoryGraphStore(),
      autoAssociate: { enabled: false },
      derivation: {
        enabled: true,
        beliefs: {
          enabled: true,
          namespaceAllowlist: ["enabled-workspace"],
        },
      },
    });

    await memory.forNamespace("control-workspace").add("Ada likes tea", {
      userId: "ada",
      runId: "control-run",
    });
    await memory.forNamespace("enabled-workspace").add("Ada likes tea", {
      userId: "ada",
      runId: "enabled-run",
    });

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain('must also include "value"');
    expect(prompts[1]).toContain('must also include "value"');
    expect(
      (await memory.forNamespace("control-workspace").getAll({ userId: "ada" }))
        .results[0]?.projectionHints,
    ).toBeUndefined();
    expect(
      (await memory.forNamespace("enabled-workspace").getAll({ userId: "ada" }))
        .results[0]?.projectionHints?.belief,
    ).toBeDefined();
  });

  it("lets canonical update win a race with deferred belief projection", async () => {
    let entered!: () => void;
    let release!: () => void;
    const projectionEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const projectionRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    class DelayedReconciler extends BeliefReconciler {
      override async observe(input: BeliefObservation) {
        entered();
        await projectionRelease;
        return super.observe(input);
      }
    }
    const reconciler = new DelayedReconciler({
      policy: { ...policy, minimumEvidence: 1, minimumContexts: 1 },
    });
    const memory = await Memory.create({
      embedder: new MockEmbedder(128),
      llm: new MockLLM(() =>
        JSON.stringify({
          facts: [
            {
              text: "Ada prefers tea",
              value: "tea",
              subject: "Ada",
              attribute: "beverage",
              type: "preference",
              cardinality: "single",
              event_date: null,
            },
          ],
        }),
      ),
      vectorStore: new InMemoryVectorStore(),
      graphStore: new InMemoryGraphStore(),
      autoAssociate: { enabled: false },
      derivation: {
        enabled: true,
        schedule: "deferred",
        beliefs: { enabled: true, reconciler },
      },
    });

    const added = await memory.add("Ada likes tea", {
      userId: "ada",
      applicability: { kind: "global" },
    });
    await projectionEntered;
    await memory.update(added.results[0]!.id, "Ada prefers water", {
      userId: "ada",
    });
    release();
    await memory.flushDerivations();

    const view = await memory.getBeliefView("Ada", "beverage", {
      userId: "ada",
      mode: "audit",
      applicability: { kind: "global" },
    });
    expect(view.candidates).toEqual([]);
    expect((await memory.get(added.results[0]!.id))?.content).toBe(
      "Ada prefers water",
    );
  });

  it("promotes one project preference across independent runs without mixing canonical state scope", async () => {
    let call = 0;
    const phrasings = [
      "Ada prefers tea",
      "Tea is Ada's preferred drink",
      "Ada would choose tea",
    ];
    const memory = await Memory.create({
      embedder: new MockEmbedder(128),
      llm: new MockLLM(() => {
        const text = phrasings[call++]!;
        return JSON.stringify({
          facts: [
            {
              text,
              value: "tea",
              subject: "Ada",
              attribute: "beverage",
              type: "preference",
              cardinality: "single",
              event_date: null,
            },
          ],
        });
      }),
      vectorStore: new InMemoryVectorStore(),
      graphStore: new InMemoryGraphStore(),
      autoAssociate: { enabled: false },
      derivation: {
        enabled: true,
        beliefs: { enabled: true },
      },
    });
    const workspace = memory.forNamespace("workspace-a");
    for (let index = 1; index <= 3; index++) {
      await workspace.add(`preference ${index}`, {
        userId: "ada",
        runId: `conversation-${index}`,
      });
    }

    const view = await workspace.getBeliefView("Ada", "beverage", {
      userId: "ada",
      mode: "audit",
    });
    expect(view.applicability).toEqual({
      kind: "project",
      key: "workspace-a",
    });
    expect(view.winner).toMatchObject({
      value: "tea",
      evidenceCount: 3,
      contextCount: 3,
    });
    expect(view.shadow.outcome).toBe("belief_only");
    expect(
      await workspace.getState("Ada", "beverage", { userId: "ada" }),
    ).toBeUndefined();
  });

  it("persists the shadow projection beside canonical SQLite records and reopens without inference", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fishmem-beliefs-"));
    const url = `file:${join(directory, "fishmem.db")}`;
    let llmCalls = 0;
    const config = async (llm: MockLLM) => ({
      embedder: new MockEmbedder(128),
      llm,
      graphStore: await createSqliteGraphStore({ url }),
      vectorStore: new SqliteVectorStore({ url }),
      autoAssociate: { enabled: false as const },
      derivation: {
        enabled: true as const,
        beliefs: {
          enabled: true as const,
          reconciler: await createSqliteBeliefReconciler({ url }),
        },
      },
    });
    let memory: Memory | undefined;
    try {
      memory = await Memory.create(
        await config(
          new MockLLM(() => {
            llmCalls++;
            return JSON.stringify({
              facts: [
                {
                  text: "Ada prefers tea",
                  value: "tea",
                  subject: "Ada",
                  attribute: "beverage",
                  type: "preference",
                  cardinality: "single",
                  event_date: null,
                },
              ],
            });
          }),
        ),
      );
      const workspace = memory.forNamespace("workspace-a");
      for (let index = 1; index <= 3; index++) {
        await workspace.add(`preference ${index}`, {
          userId: "ada",
          runId: `conversation-${index}`,
        });
      }
      expect(llmCalls).toBe(3);
      await memory.close();
      memory = undefined;

      const reopened = await Memory.create(
        await config(
          new MockLLM(() => {
            throw new Error("reopen must not call the LLM");
          }),
        ),
      );
      memory = reopened;
      const reopenedWorkspace = reopened.forNamespace("workspace-a");
      expect(
        (
          await reopenedWorkspace.getBeliefView("Ada", "beverage", {
            userId: "ada",
            mode: "audit",
          })
        ).winner,
      ).toMatchObject({ value: "tea", evidenceCount: 3 });
      await expect(
        reopenedWorkspace.rebuildBeliefs({ userId: "ada" }),
      ).resolves.toEqual({ evidence: 3, slots: 1 });
    } finally {
      await memory?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
