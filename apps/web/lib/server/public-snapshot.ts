/** Projection hints are implementation-owned replay inputs. Hosted clients may
 * move canonical data, but cannot read or manufacture governed evidence
 * identities, weights, or applicability. Trusted core snapshots retain these
 * hints for local/operator-controlled restores. */
export function sanitizePublicSnapshot(snapshot: unknown): unknown {
  if (!isRecord(snapshot) || !isRecord(snapshot.data)) return snapshot;
  const memories = snapshot.data.memories;
  if (!Array.isArray(memories)) return snapshot;
  return {
    ...snapshot,
    data: {
      ...snapshot.data,
      memories: memories.map((memory) => {
        if (!isRecord(memory) || !("projectionHints" in memory)) return memory;
        const { projectionHints: _ignored, ...canonical } = memory;
        return canonical;
      }),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
