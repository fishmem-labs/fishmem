/**
 * Embedder identity and the guard around changing it.
 *
 * A vector index is only meaningful with respect to the model that produced
 * its vectors. Swapping the embedder does not fail — it silently starts
 * writing into a different space, and every stored vector becomes noise that
 * still returns confident-looking similarity scores. That failure is invisible
 * in logs and in tests, and only shows up as recall quietly getting worse.
 *
 * So the identity is recorded next to the data, and a mismatch is a startup
 * error rather than a degraded search.
 */

export type EmbedderIdentity = {
  provider: string;
  model: string;
  dimensions: number;
};

export const EMBEDDER_IDENTITY_KEY = "embedder_identity";

export class EmbedderIdentityMismatch extends Error {
  constructor(
    readonly stored: EmbedderIdentity,
    readonly configured: EmbedderIdentity,
    readonly storedVectors: number,
  ) {
    super(
      `Embedder changed from ${formatIdentity(stored)} to ${formatIdentity(
        configured,
      )}, but ${storedVectors} embedded record(s) already exist in the old ` +
        `space. Searching across two spaces returns wrong results without ` +
        `failing, so the engine will not start. Re-embed the store, or set ` +
        `FISHMEM_EMBEDDER_ADOPT=1 to accept the new identity and discard the ` +
        `old vectors.`,
    );
    this.name = "EmbedderIdentityMismatch";
  }
}

export function formatIdentity(identity: EmbedderIdentity) {
  return `${identity.provider}:${identity.model}@${identity.dimensions}`;
}

export function parseIdentity(value: string): EmbedderIdentity | null {
  const match = /^([^:]+):(.+)@(\d+)$/.exec(value);
  if (!match) return null;
  return {
    provider: match[1]!,
    model: match[2]!,
    dimensions: Number(match[3]),
  };
}

export function identitiesMatch(a: EmbedderIdentity, b: EmbedderIdentity) {
  return (
    a.provider === b.provider &&
    a.model === b.model &&
    a.dimensions === b.dimensions
  );
}

export type EmbedderIdentityStore = {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  /** How many records already carry vectors in the current space. */
  countEmbedded(): Promise<number>;
};

/**
 * Reconcile the configured embedder against the one the store was built with.
 *
 * Returns the action taken so callers can log it: `adopted` on a first run or
 * an empty store, `unchanged` in the steady state, `forced` when an operator
 * explicitly accepted the switch.
 */
export async function reconcileEmbedderIdentity(
  configured: EmbedderIdentity,
  store: EmbedderIdentityStore,
  options: { adopt?: boolean } = {},
): Promise<"adopted" | "unchanged" | "forced"> {
  const raw = await store.read();
  const stored = raw ? parseIdentity(raw) : null;

  if (stored && identitiesMatch(stored, configured)) return "unchanged";

  if (stored && !options.adopt) {
    // An empty store has nothing to be inconsistent with, so switching then
    // is free — which is exactly when a switch should be made.
    const embedded = await store.countEmbedded();
    if (embedded > 0) {
      throw new EmbedderIdentityMismatch(stored, configured, embedded);
    }
  }

  await store.write(formatIdentity(configured));
  return stored ? (options.adopt ? "forced" : "adopted") : "adopted";
}
