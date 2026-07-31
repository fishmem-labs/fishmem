/**
 * A separate materialized view of canonical records. Every entry cites the
 * record(s) that asserted it, can be dropped and rebuilt, and is not a second
 * canonical writer. Normal recall queries records; structured queries such as
 * "current X" and "X over time" query this sidecar.
 *
 * This first slice holds **mutable-state slots** only (residence, job, …):
 * one `(subject, attribute)` belief slot with validity + supersession. Entity
 * graph, profile, and dedup links are later slices behind the same boundary.
 */
import type { Scope } from "../memory.js";

/** A derived belief slot with provenance back to canonical records. */
export interface StateSlot {
  id: string;
  scope: Scope;
  subject: string;
  attribute: string;
  value: string;
  /** When this value began to hold (event time, or ingest time if undated). */
  validFrom: Date;
  /** When it stopped holding. Undefined = currently believed. */
  validTo?: Date;
  /** Id of the slot that superseded this one (set when closed). */
  supersededBy?: string;
  /** Canonical memory ids that asserted this value. */
  sources: string[];
}

export interface StateUpsert {
  scope: Scope;
  subject: string;
  attribute: string;
  value: string;
  validFrom: Date;
  /** Canonical memory ids that asserted this value. */
  sources: string[];
  /**
   * Attribute cardinality. `"single"` (default): the new value supersedes the
   * current open value (residence, job). `"multi"`: values coexist — append
   * without closing the others (pet, hobby). The caller (engine) resolves this
   * from the attribute; the sidecar just applies it.
   */
  cardinality?: "single" | "multi";
}

export interface StateSidecar {
  /**
   * Record a derived state fact. Materialized-view semantics for one
   * `(subject, attribute)` slot: identical value → merge provenance (no-op
   * otherwise); a different value → close the current open slot
   * (`validTo`, `supersededBy`) and open a new one.
   */
  upsert(input: StateUpsert): Promise<void>;
  /** Current value (open slot), or the value in force `asOf` a given time. */
  getState(
    scope: Scope,
    subject: string,
    attribute: string,
    opts?: { asOf?: Date },
  ): Promise<StateSlot | undefined>;
  /** Full timeline for a slot, oldest first. */
  getStateHistory(
    scope: Scope,
    subject: string,
    attribute: string,
  ): Promise<StateSlot[]>;
  /** Drop derived state (whole sidecar, or one scope) — for rebuild from raw. */
  clear(scope?: Scope): Promise<void>;
  /** Release backing resources (persistent backends). Optional. */
  close?(): Promise<void>;
}

const scopeKey = (s: Scope) =>
  `${s.namespaceId ?? ""}\u0000${s.userId ?? ""}\u0000${s.agentId ?? ""}\u0000${s.runId ?? ""}`;
const slotKey = (s: Scope, subject: string, attribute: string) =>
  `${scopeKey(s)}\u0000${subject.trim().toLowerCase()}\u0000${attribute.trim().toLowerCase()}`;
const normValue = (v: string) => v.trim().toLowerCase().replace(/\s+/g, " ");

let counter = 0;
const newId = () =>
  `slot_${Date.now().toString(36)}_${(counter++).toString(36)}`;

/**
 * In-memory sidecar — the default for tests, the bench, and zero-config use.
 * Persistent backends (sqlite / pg / d1) implement the same interface (a later
 * slice).
 */
export class InMemoryStateSidecar implements StateSidecar {
  private byKey = new Map<string, StateSlot[]>();

  async upsert(input: StateUpsert): Promise<void> {
    const key = slotKey(input.scope, input.subject, input.attribute);
    const slots = this.byKey.get(key) ?? [];
    const open = slots.filter((s) => s.validTo === undefined);
    const same = open.find(
      (s) => normValue(s.value) === normValue(input.value),
    );
    if (same) {
      for (const src of input.sources)
        if (!same.sources.includes(src)) same.sources.push(src);
      return; // identical belief — merge provenance only
    }
    const next: StateSlot = {
      id: newId(),
      scope: input.scope,
      subject: input.subject,
      attribute: input.attribute,
      value: input.value,
      validFrom: input.validFrom,
      sources: [...input.sources],
    };
    // Single-valued (default): the new value supersedes the current open
    // value(s). Multi-valued: values coexist — leave existing open ones.
    if (input.cardinality !== "multi") {
      for (const s of open) {
        s.validTo = input.validFrom;
        s.supersededBy = next.id;
      }
    }
    slots.push(next);
    this.byKey.set(key, slots);
  }

  async getState(
    scope: Scope,
    subject: string,
    attribute: string,
    opts?: { asOf?: Date },
  ): Promise<StateSlot | undefined> {
    const slots = this.byKey.get(slotKey(scope, subject, attribute));
    if (!slots) return undefined;
    if (opts?.asOf) {
      const t = opts.asOf.getTime();
      return slots.find(
        (s) =>
          s.validFrom.getTime() <= t &&
          (s.validTo === undefined || t < s.validTo.getTime()),
      );
    }
    return slots.find((s) => s.validTo === undefined);
  }

  async getStateHistory(
    scope: Scope,
    subject: string,
    attribute: string,
  ): Promise<StateSlot[]> {
    const slots = this.byKey.get(slotKey(scope, subject, attribute)) ?? [];
    return [...slots].sort(
      (a, b) => a.validFrom.getTime() - b.validFrom.getTime(),
    );
  }

  async clear(scope?: Scope): Promise<void> {
    if (!scope) {
      this.byKey.clear();
      return;
    }
    const prefix = scopeKey(scope);
    for (const key of [...this.byKey.keys()])
      if (key.startsWith(`${prefix}\u0000`)) this.byKey.delete(key);
  }
}
