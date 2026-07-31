import { beforeEach, describe, expect, it } from "vitest";
import {
  chooseMergePair,
  MemoryMaintenance,
  mergedContent,
} from "../src/core/maintenance.js";
import { uuid } from "../src/core/util.js";
import { MockEmbedder } from "../src/embeddings/mock.js";
import { InMemoryGraphStore } from "../src/graph/memory-store.js";
import type { MemoryWarning } from "../src/index.js";
import type { Memory } from "../src/types.js";
import { InMemoryVectorStore } from "../src/vector/memory.js";

const DAY = 86_400_000;

class FailingDeleteVectorStore extends InMemoryVectorStore {
  override async delete(_id: string): Promise<void> {
    throw new Error("delete failed");
  }
}

let store: InMemoryGraphStore;
let vectors: InMemoryVectorStore;
let embedder: MockEmbedder;
let maint: MemoryMaintenance;

beforeEach(async () => {
  store = new InMemoryGraphStore();
  vectors = new InMemoryVectorStore();
  embedder = new MockEmbedder(64);
  await vectors.init(embedder.dimensions);
  maint = new MemoryMaintenance(store, vectors, embedder);
});

async function add(
  content: string,
  overrides: Partial<Memory> = {},
): Promise<Memory> {
  const now = new Date();
  const m: Memory = {
    id: uuid(),
    content,
    memoryType: "fact",
    importance: 0.6,
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now,
    accessCount: 0,
    forgotten: false,
    ...overrides,
  };
  await store.saveMemory(m);
  const vector = await embedder.embed(content);
  await vectors.upsert([
    { id: m.id, vector, content, payload: { memoryType: m.memoryType } },
  ]);
  return m;
}

describe("decay", () => {
  it("applies the age + access decay formula", async () => {
    const m = await add("old fact", {
      importance: 0.6,
      createdAt: new Date(Date.now() - 20 * DAY),
      updatedAt: new Date(Date.now() - 20 * DAY),
      lastAccessedAt: new Date(Date.now() - 40 * DAY),
    });

    const changed = await maint.decay();
    expect(changed).toBe(1);

    // age_decay = 1 - min(20*0.05, 0.5) = 0.5 ; access_boost = 0.9 (>30d)
    // 0.6 * 0.5 * 0.9 = 0.27
    const after = await store.getMemory(m.id);
    expect(after!.importance).toBeCloseTo(0.27, 5);
  });

  it("measures age from updatedAt, not createdAt (spacebot parity)", async () => {
    // Old memory, but recently updated: no age decay, no access boost.
    const m = await add("recently revised", {
      importance: 0.6,
      createdAt: new Date(Date.now() - 100 * DAY),
      updatedAt: new Date(),
      lastAccessedAt: new Date(Date.now() - 10 * DAY),
    });
    await maint.decay();
    expect((await store.getMemory(m.id))!.importance).toBeCloseTo(0.6, 5);
  });

  it("never decays identity memories", async () => {
    const m = await add("who I am", {
      memoryType: "identity",
      importance: 1.0,
      createdAt: new Date(Date.now() - 100 * DAY),
      lastAccessedAt: new Date(Date.now() - 100 * DAY),
    });
    await maint.decay();
    expect((await store.getMemory(m.id))!.importance).toBe(1.0);
  });

  it("boosts recently accessed memories", async () => {
    const m = await add("seen recently", {
      importance: 0.5,
      createdAt: new Date(), // ~0 days old → age_decay ≈ 1
      lastAccessedAt: new Date(), // <7d → 1.1x boost
    });
    await maint.decay();
    // age_decay ≈ 1 ; boost 1.1 → 0.5 * 1.1 = 0.55 (change 0.05 ≥ 0.01 threshold)
    expect((await store.getMemory(m.id))!.importance).toBeCloseTo(0.55, 4);
  });
});

describe("tenant-scoped consolidation", () => {
  async function addTenant(content: string, tenant: string) {
    const m = await add(content, { namespaceId: tenant });
    // Re-upsert the vector with the namespace in the payload so filtered
    // vector search can see it.
    const vector = await embedder.embed(m.content);
    await vectors.upsert([
      {
        id: m.id,
        vector,
        content: m.content,
        payload: { memoryType: m.memoryType, namespaceId: tenant },
      },
    ]);
    return m;
  }

  it("never merges near-duplicates across namespaces", async () => {
    // Identical content in two tenants — cosine 1.0, prime merge candidates.
    const a = await addTenant("the quarterly report is due friday", "tenant-a");
    const b = await addTenant("the quarterly report is due friday", "tenant-b");

    const merged = await maint.consolidate({ namespaceId: "tenant-a" });
    expect(merged).toBe(0); // the only candidate pair crosses tenants
    expect((await store.getMemory(a.id))!.forgotten).toBe(false);
    expect((await store.getMemory(b.id))!.forgotten).toBe(false);
  });

  it("still merges within the same tenant", async () => {
    await addTenant("the quarterly report is due friday", "tenant-a");
    await addTenant("the quarterly report is due friday", "tenant-a");
    const merged = await maint.consolidate({ namespaceId: "tenant-a" });
    expect(merged).toBe(1);
  });
});

describe("prune", () => {
  it("hard-deletes low-importance, old, non-identity memories", async () => {
    const pruned = await add("forgettable", {
      importance: 0.05,
      createdAt: new Date(Date.now() - 40 * DAY),
    });
    const tooYoung = await add("young but low", {
      importance: 0.05,
      createdAt: new Date(Date.now() - 5 * DAY),
    });
    const importantOld = await add("valuable", {
      importance: 0.9,
      createdAt: new Date(Date.now() - 40 * DAY),
    });
    const identity = await add("core identity", {
      memoryType: "identity",
      importance: 0.05,
      createdAt: new Date(Date.now() - 40 * DAY),
    });

    const count = await maint.prune();
    expect(count).toBe(1);
    expect(await store.getMemory(pruned.id)).toBeNull();
    expect(await store.getMemory(tooYoung.id)).not.toBeNull();
    expect(await store.getMemory(importantOld.id)).not.toBeNull();
    expect(await store.getMemory(identity.id)).not.toBeNull();
    // Vector dropped too.
    expect(await vectors.get(pruned.id)).toBeNull();
  });

  it("reports vector delete failures through onWarning", async () => {
    const warnings: MemoryWarning[] = [];
    vectors = new FailingDeleteVectorStore();
    await vectors.init(embedder.dimensions);
    maint = new MemoryMaintenance(
      store,
      vectors,
      embedder,
      {},
      undefined,
      (warning) => warnings.push(warning),
    );
    const pruned = await add("forgettable vector", {
      importance: 0.05,
      createdAt: new Date(Date.now() - 40 * DAY),
    });

    const count = await maint.prune();

    expect(count).toBe(1);
    expect(await store.getMemory(pruned.id)).toBeNull();
    expect(warnings.map((w) => w.code)).toContain(
      "maintenance_vector_delete_failed",
    );
    expect(warnings[0]?.error).toBeInstanceOf(Error);
  });
});

describe("consolidate", () => {
  it("merges near-duplicates, keeping the higher-importance survivor", async () => {
    // Identical content → mock cosine similarity 1.0 ≥ 0.95 threshold.
    const survivor = await add("the sky is blue", { importance: 0.9 });
    const loser = await add("the sky is blue", { importance: 0.4 });

    const merges = await maint.consolidate();
    expect(merges).toBe(1);

    expect((await store.getMemory(loser.id))!.forgotten).toBe(true);
    expect((await store.getMemory(survivor.id))!.forgotten).toBe(false);
    // updates edge survivor -> loser
    const edges = await store.getAssociations(survivor.id);
    expect(edges.some((e) => e.relationType === "updates")).toBe(true);
    // Loser vector removed.
    expect(await vectors.get(loser.id)).toBeNull();
  });

  it("does not merge dissimilar memories", async () => {
    await add("quantum chromodynamics", { importance: 0.9 });
    await add("my favourite pasta is carbonara", { importance: 0.4 });
    expect(await maint.consolidate()).toBe(0);
  });
});

describe("merge helpers", () => {
  it("chooseMergePair: higher importance wins, ties broken by id", () => {
    const base = {
      content: "",
      memoryType: "fact" as const,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastAccessedAt: new Date(),
      accessCount: 0,
      forgotten: false,
    };
    const a: Memory = { ...base, id: "a", importance: 0.5 };
    const b: Memory = { ...base, id: "b", importance: 0.9 };
    expect(chooseMergePair(a, b)[0].id).toBe("b");

    const c: Memory = { ...base, id: "aaa", importance: 0.5 };
    const d: Memory = { ...base, id: "zzz", importance: 0.5 };
    expect(chooseMergePair(d, c)[0].id).toBe("aaa");
  });

  it("mergedContent concatenates unless contained, capping length", () => {
    expect(mergedContent("hello", "world", 1000)).toBe("hello\n\nworld");
    expect(mergedContent("hello world", "world", 1000)).toBe("hello world");
    expect(mergedContent("a", "", 1000)).toBe("a");
    expect(mergedContent("abcdef", "ghijkl", 8)).toHaveLength(8);
  });
});
