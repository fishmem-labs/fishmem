import { describe, expect, it } from "vitest";
import {
  EmbedderIdentityMismatch,
  formatIdentity,
  parseIdentity,
  reconcileEmbedderIdentity,
  type EmbedderIdentity,
  type EmbedderIdentityStore,
} from "./embedder-identity";

const openai: EmbedderIdentity = {
  provider: "openai",
  model: "text-embedding-3-small",
  dimensions: 1536,
};
const workersAi: EmbedderIdentity = {
  provider: "workers-ai",
  model: "@cf/baai/bge-m3",
  dimensions: 1024,
};

function store(initial: {
  identity?: EmbedderIdentity;
  embedded?: number;
}): EmbedderIdentityStore & { value: string | null } {
  let value = initial.identity ? formatIdentity(initial.identity) : null;
  return {
    get value() {
      return value;
    },
    async read() {
      return value;
    },
    async write(next) {
      value = next;
    },
    async countEmbedded() {
      return initial.embedded ?? 0;
    },
  };
}

describe("embedder identity", () => {
  it("round-trips an identity through its stored form", () => {
    // The model id contains a slash and an @, so the format must survive it.
    expect(parseIdentity(formatIdentity(workersAi))).toEqual(workersAi);
    expect(formatIdentity(workersAi)).toBe("workers-ai:@cf/baai/bge-m3@1024");
    expect(parseIdentity("nonsense")).toBeNull();
  });

  it("adopts an identity on a store that has never had one", async () => {
    const state = store({});

    await expect(reconcileEmbedderIdentity(workersAi, state)).resolves.toBe(
      "adopted",
    );
    expect(state.value).toBe(formatIdentity(workersAi));
  });

  it("is a no-op in the steady state", async () => {
    const state = store({ identity: workersAi, embedded: 10_000 });

    await expect(reconcileEmbedderIdentity(workersAi, state)).resolves.toBe(
      "unchanged",
    );
  });

  it("switches freely while the store holds nothing", async () => {
    // This is the window in which a migration is free, and the guard must not
    // stand in its way.
    const state = store({ identity: openai, embedded: 0 });

    await expect(reconcileEmbedderIdentity(workersAi, state)).resolves.toBe(
      "adopted",
    );
    expect(state.value).toBe(formatIdentity(workersAi));
  });

  it("refuses to serve a populated store with a different embedder", async () => {
    const state = store({ identity: openai, embedded: 42_000 });

    const failure = await reconcileEmbedderIdentity(workersAi, state).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(EmbedderIdentityMismatch);
    // The error has to say what changed and how to proceed, because the
    // alternative failure mode is silent: searches would still return results,
    // just meaningless ones.
    const message = (failure as Error).message;
    expect(message).toContain("text-embedding-3-small");
    expect(message).toContain("@cf/baai/bge-m3");
    expect(message).toContain("42000");
    expect(message).toContain("FISHMEM_EMBEDDER_ADOPT");
    // The stored identity must survive a refused switch.
    expect(state.value).toBe(formatIdentity(openai));
  });

  it("lets an operator force the switch deliberately", async () => {
    const state = store({ identity: openai, embedded: 42_000 });

    await expect(
      reconcileEmbedderIdentity(workersAi, state, { adopt: true }),
    ).resolves.toBe("forced");
    expect(state.value).toBe(formatIdentity(workersAi));
  });

  it("treats a width change on the same model as a different space", async () => {
    // text-embedding-3-* can be shortened via `dimensions`, which produces
    // vectors that are not comparable with the full-width ones.
    const state = store({ identity: openai, embedded: 5 });

    await expect(
      reconcileEmbedderIdentity({ ...openai, dimensions: 512 }, state),
    ).rejects.toBeInstanceOf(EmbedderIdentityMismatch);
  });
});
