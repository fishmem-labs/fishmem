/**
 * Rebuildable governance projection for inferred preferences and learned rules.
 *
 * Canonical records remain authoritative. This module stores only provenance-
 * linked observations, then derives supported / contested / superseded views
 * at read time. Explicit user corrections continue through Memory's canonical
 * update/invalidate/delete path and never have to "win" an evidence contest.
 */

import type { Scope } from "../memory.js";
import { contentHash } from "./util.js";

export const APPLICABILITY_KINDS = [
  "global",
  "project",
  "task",
  "conversation",
  "channel",
  "custom",
] as const;

export type ApplicabilityKind = (typeof APPLICABILITY_KINDS)[number];

/** Semantic applicability. This is deliberately separate from owner Scope. */
export interface ApplicabilityContext {
  kind: ApplicabilityKind;
  /** Required for every non-global applicability kind. */
  key?: string;
  validFrom?: Date;
  validTo?: Date;
}

/** JSON-safe form persisted with a canonical record's projection hints. */
export interface StoredApplicabilityContext {
  kind: ApplicabilityKind;
  key?: string;
  validFrom?: string;
  validTo?: string;
}

export interface BeliefPolicy {
  /** Distinct evidence keys required before a candidate can be supported. */
  minimumEvidence: number;
  /** Distinct observation contexts required before support. */
  minimumContexts: number;
  /** Candidate weight divided by total active cluster weight. */
  minimumSupport: number;
  /** Required weighted lead over the runner-up. */
  minimumLead: number;
}

export const DEFAULT_BELIEF_POLICY: Readonly<BeliefPolicy> = {
  minimumEvidence: 3,
  minimumContexts: 3,
  minimumSupport: 0.6,
  minimumLead: 1,
};

export type BeliefCandidateStatus = "supported" | "contested" | "superseded";
export type BeliefViewMode = "default" | "conflict" | "audit";
export type BeliefProjectionStatus = "ready" | "disabled";

export type BeliefReasonCode =
  | "policy_thresholds_met"
  | "insufficient_independent_evidence"
  | "insufficient_distinct_contexts"
  | "support_below_threshold"
  | "lead_below_threshold"
  | "competing_candidate"
  | "superseded_by_stronger_candidate"
  | "no_active_evidence"
  | "outside_applicability_window"
  | "contextual_override"
  | "global_fallback"
  | "no_candidate_met_policy"
  | "no_evidence"
  | "projection_disabled"
  | "conflicting_independence_key";

export interface BeliefObservation {
  scope: Scope;
  subject: string;
  attribute: string;
  value: string;
  /**
   * Semantic value frozen by the same extraction pass that produced the
   * canonical fact. Paraphrases with the same claim value compete as one
   * candidate. Falls back to `value` for trusted/manual observations.
   */
  claimValue?: string;
  /** Canonical memory id. */
  sourceId: string;
  /** Echoes from one underlying source share this key and count once. */
  evidenceKey: string;
  /** Independent task/conversation/work context used by the promotion gate. */
  contextId: string;
  applicability: ApplicabilityContext;
  observedAt: Date;
  /** Canonical fact validity, separate from applicability validity. */
  validFrom: Date;
  validTo?: Date;
  weight?: number;
}

export interface BeliefEvidence {
  id: string;
  scope: Scope;
  subject: string;
  attribute: string;
  subjectKey: string;
  attributeKey: string;
  value: string;
  valueKey: string;
  sourceId: string;
  evidenceKey: string;
  contextId: string;
  applicability: ApplicabilityContext;
  clusterKey: string;
  candidateKey: string;
  observedAt: Date;
  validFrom: Date;
  validTo?: Date;
  weight: number;
}

export interface BeliefEvidenceView {
  id: string;
  sourceId: string;
  evidenceKey: string;
  contextId: string;
  applicability: ApplicabilityContext;
  observedAt: Date;
  validFrom: Date;
  validTo?: Date;
  weight: number;
  active: boolean;
}

export interface BeliefCandidate {
  id: string;
  subject: string;
  attribute: string;
  value: string;
  applicability: ApplicabilityContext;
  status: BeliefCandidateStatus;
  score: number;
  support: number;
  evidenceCount: number;
  contextCount: number;
  sourceIds: string[];
  firstObservedAt: Date;
  lastObservedAt: Date;
  supersededBy?: string;
  reasonCodes: BeliefReasonCode[];
  /** Present only in audit mode. */
  evidence?: BeliefEvidenceView[];
}

export interface BeliefProjectionView {
  projectionStatus: BeliefProjectionStatus;
  mode: BeliefViewMode;
  subject: string;
  attribute: string;
  applicability: ApplicabilityContext;
  winner?: BeliefCandidate;
  candidates: BeliefCandidate[];
  unresolved: boolean;
  reasonCodes: BeliefReasonCode[];
}

export interface BeliefViewOptions {
  mode?: BeliefViewMode;
  applicability?: ApplicabilityContext;
  at?: Date;
  /** Audit-only operator view across every semantic applicability context. */
  allApplicability?: boolean;
}

/** Persistence seam. Implementations store rows, never a graph snapshot. */
export interface BeliefEvidenceStore {
  put(evidence: BeliefEvidence): Promise<void>;
  listSlot(
    scope: Scope,
    subjectKey: string,
    attributeKey: string,
  ): Promise<BeliefEvidence[]>;
  invalidateSource(sourceId: string, validTo: Date): Promise<void>;
  removeSource(sourceId: string): Promise<void>;
  /** Undefined fields are wildcards for projection rebuild/purge. */
  clear(scope?: Scope): Promise<void>;
  close?(): Promise<void>;
}

export class BeliefEvidenceConflictError extends Error {
  constructor(readonly evidenceKey: string) {
    super(`belief evidence key ${evidenceKey} claimed conflicting values`);
    this.name = "BeliefEvidenceConflictError";
  }
}

export class InMemoryBeliefEvidenceStore implements BeliefEvidenceStore {
  private readonly evidence = new Map<string, BeliefEvidence>();

  async put(evidence: BeliefEvidence): Promise<void> {
    this.evidence.set(evidence.id, cloneEvidence(evidence));
  }

  async listSlot(
    scope: Scope,
    subjectKey: string,
    attributeKey: string,
  ): Promise<BeliefEvidence[]> {
    return [...this.evidence.values()]
      .filter(
        (row) =>
          scopesEqual(row.scope, scope) &&
          row.subjectKey === subjectKey &&
          row.attributeKey === attributeKey,
      )
      .map(cloneEvidence);
  }

  async invalidateSource(sourceId: string, validTo: Date): Promise<void> {
    for (const row of this.evidence.values()) {
      if (row.sourceId !== sourceId) continue;
      if (!row.validTo || validTo.getTime() < row.validTo.getTime()) {
        row.validTo = new Date(validTo);
      }
    }
  }

  async removeSource(sourceId: string): Promise<void> {
    for (const [id, row] of this.evidence) {
      if (row.sourceId === sourceId) this.evidence.delete(id);
    }
  }

  async clear(scope?: Scope): Promise<void> {
    if (!scope) {
      this.evidence.clear();
      return;
    }
    for (const [id, row] of this.evidence) {
      if (scopeContains(scope, row.scope)) this.evidence.delete(id);
    }
  }
}

export interface BeliefReconcilerOptions {
  store?: BeliefEvidenceStore;
  policy?: Partial<BeliefPolicy>;
}

/**
 * Deep module: callers observe evidence and ask for one governed view. Storage,
 * normalization, independence, lifecycle thresholds, time filtering, and
 * provenance assembly remain behind this interface.
 */
export class BeliefReconciler {
  readonly policy: Readonly<BeliefPolicy>;
  private readonly store: BeliefEvidenceStore;

  constructor(options: BeliefReconcilerOptions = {}) {
    this.store = options.store ?? new InMemoryBeliefEvidenceStore();
    this.policy = validatePolicy({
      ...DEFAULT_BELIEF_POLICY,
      ...options.policy,
    });
  }

  async observe(input: BeliefObservation): Promise<void> {
    const subject = requiredText(input.subject, "subject");
    const attribute = requiredText(input.attribute, "attribute");
    const value = requiredText(input.value, "value");
    const sourceId = requiredText(input.sourceId, "sourceId");
    const evidenceKey = requiredText(input.evidenceKey, "evidenceKey");
    const contextId = requiredText(input.contextId, "contextId");
    const observedAt = validDate(input.observedAt, "observedAt");
    const validFrom = validDate(input.validFrom, "validFrom");
    const validTo = input.validTo
      ? validDate(input.validTo, "validTo")
      : undefined;
    if (validTo && validTo.getTime() <= validFrom.getTime()) {
      throw new TypeError("validTo must be after validFrom");
    }
    const weight = input.weight ?? 1;
    if (!Number.isFinite(weight) || weight <= 0 || weight > 1) {
      throw new TypeError("belief evidence weight must be within (0, 1]");
    }
    const applicability = normalizeApplicability(input.applicability);
    const subjectKey = normalizeText(subject);
    const attributeKey = normalizeText(attribute);
    const claimValue = input.claimValue
      ? requiredText(input.claimValue, "claimValue")
      : value;
    const valueKey = normalizeText(claimValue);
    const clusterKey = beliefClusterKey(
      input.scope,
      subjectKey,
      attributeKey,
      applicability,
    );
    const candidateKey = `belief_${contentHash(
      JSON.stringify([clusterKey, valueKey]),
    )}`;
    const existing = await this.store.listSlot(
      input.scope,
      subjectKey,
      attributeKey,
    );
    const conflictingEcho = existing.find(
      (row) =>
        row.clusterKey === clusterKey &&
        row.evidenceKey === evidenceKey &&
        row.valueKey !== valueKey &&
        evidenceActiveAt(row, observedAt),
    );
    if (conflictingEcho) throw new BeliefEvidenceConflictError(evidenceKey);

    const id = `belief_ev_${contentHash(
      JSON.stringify([clusterKey, sourceId]),
    )}`;
    await this.store.put({
      id,
      scope: copyScope(input.scope),
      subject,
      attribute,
      subjectKey,
      attributeKey,
      value: claimValue,
      valueKey,
      sourceId,
      evidenceKey,
      contextId,
      applicability,
      clusterKey,
      candidateKey,
      observedAt,
      validFrom,
      ...(validTo ? { validTo } : {}),
      weight,
    });
  }

  async view(
    scope: Scope,
    subject: string,
    attribute: string,
    options: BeliefViewOptions = {},
  ): Promise<BeliefProjectionView> {
    const mode = options.mode ?? "default";
    if (options.allApplicability && mode !== "audit") {
      throw new TypeError("allApplicability is available only in audit mode");
    }
    const normalizedSubject = requiredText(subject, "subject");
    const normalizedAttribute = requiredText(attribute, "attribute");
    const requested = normalizeApplicability(
      options.applicability ?? { kind: "global" },
    );
    const at = options.at ? validDate(options.at, "at") : new Date();
    const rows = await this.store.listSlot(
      scope,
      normalizeText(normalizedSubject),
      normalizeText(normalizedAttribute),
    );
    const relevant = options.allApplicability
      ? rows
      : rows.filter(
          (row) =>
            row.applicability.kind === "global" ||
            applicabilityIdentityEqual(row.applicability, requested),
        );
    const clusters = groupBy(relevant, (row) => row.clusterKey);
    const candidateGroups = [...clusters.values()].map((cluster) =>
      this.evaluateCluster(cluster, at, mode),
    );
    const allCandidates = candidateGroups.flatMap((group) => group.candidates);
    const contextualGroups = candidateGroups.filter(
      (group) =>
        requested.kind !== "global" &&
        applicabilityIdentityEqual(group.applicability, requested),
    );
    const contextualWinners = contextualGroups.flatMap((group) =>
      group.winner ? [group.winner] : [],
    );
    const contextualEvidenceActive = contextualGroups.some((group) =>
      group.candidates.some((candidate) => candidate.evidenceCount > 0),
    );
    const globalWinners = candidateGroups
      .filter((group) => group.applicability.kind === "global")
      .flatMap((group) => (group.winner ? [group.winner] : []));
    // An active contextual conflict is an applicability firewall: do not hide
    // it by falling back to a globally supported candidate. Global fallback is
    // allowed only when the requested context has no active evidence.
    const winner =
      bestCandidate(contextualWinners) ??
      (contextualEvidenceActive ? undefined : bestCandidate(globalWinners));
    const reasonCodes: BeliefReasonCode[] = [];
    if (winner && requested.kind !== "global") {
      reasonCodes.push(
        contextualWinners.includes(winner)
          ? "contextual_override"
          : "global_fallback",
      );
    }
    const activeCandidates = allCandidates.filter(
      (candidate) => candidate.evidenceCount > 0,
    );
    const hasActiveEvidence = relevant.some((row) => evidenceActiveAt(row, at));
    const hasConflictingEvidence = [...clusters.values()].some(
      (cluster) => conflictingEvidenceKeys(cluster, at).size > 0,
    );
    if (hasConflictingEvidence) {
      reasonCodes.push("conflicting_independence_key");
    }
    if (!winner) {
      reasonCodes.push(
        allCandidates.length ? "no_candidate_met_policy" : "no_evidence",
      );
    }
    const visible =
      mode === "default"
        ? winner
          ? [withoutEvidence(winner)]
          : []
        : mode === "conflict"
          ? activeCandidates.map(withoutEvidence)
          : allCandidates;
    const visibleWinner = winner
      ? mode === "audit"
        ? winner
        : withoutEvidence(winner)
      : undefined;
    return {
      projectionStatus: "ready",
      mode,
      subject: normalizedSubject,
      attribute: normalizedAttribute,
      applicability: requested,
      ...(visibleWinner ? { winner: visibleWinner } : {}),
      candidates: visible.sort(compareCandidates),
      unresolved: !winner && hasActiveEvidence,
      reasonCodes,
    };
  }

  invalidateSource(sourceId: string, validTo: Date): Promise<void> {
    return this.store.invalidateSource(
      requiredText(sourceId, "sourceId"),
      validDate(validTo, "validTo"),
    );
  }

  removeSource(sourceId: string): Promise<void> {
    return this.store.removeSource(requiredText(sourceId, "sourceId"));
  }

  clear(scope?: Scope): Promise<void> {
    return this.store.clear(scope);
  }

  async close(): Promise<void> {
    await this.store.close?.();
  }

  private evaluateCluster(
    rows: BeliefEvidence[],
    at: Date,
    mode: BeliefViewMode,
  ): {
    applicability: ApplicabilityContext;
    winner?: BeliefCandidate;
    candidates: BeliefCandidate[];
  } {
    const applicability = applicabilityIdentity(rows[0]!.applicability);
    const conflictingKeys = conflictingEvidenceKeys(rows, at);
    const candidates = [...groupBy(rows, (row) => row.candidateKey).values()]
      .map((candidateRows) =>
        candidateFromEvidence(
          candidateRows,
          at,
          mode === "audit",
          conflictingKeys,
        ),
      )
      .sort(compareCandidates);
    const active = candidates.filter(
      (candidate) => candidate.evidenceCount > 0,
    );
    const totalScore = active.reduce(
      (sum, candidate) => sum + candidate.score,
      0,
    );
    for (const candidate of active) {
      candidate.support = totalScore > 0 ? candidate.score / totalScore : 0;
    }
    active.sort(compareCandidates);
    const leader = active[0];
    const runner = active[1];
    const leaderReasons: BeliefReasonCode[] = [];
    if (leader) {
      if (leader.evidenceCount < this.policy.minimumEvidence) {
        leaderReasons.push("insufficient_independent_evidence");
      }
      if (leader.contextCount < this.policy.minimumContexts) {
        leaderReasons.push("insufficient_distinct_contexts");
      }
      if (leader.support < this.policy.minimumSupport) {
        leaderReasons.push("support_below_threshold");
      }
      const lead = leader.score - (runner?.score ?? 0);
      if (lead < this.policy.minimumLead) {
        leaderReasons.push("lead_below_threshold");
      }
    }
    const winner = leader && leaderReasons.length === 0 ? leader : undefined;
    for (const candidate of candidates) {
      if (candidate.evidenceCount === 0) continue;
      if (winner && candidate.id === winner.id) {
        candidate.status = "supported";
        candidate.reasonCodes = ["policy_thresholds_met"];
      } else if (winner) {
        candidate.status = "superseded";
        candidate.supersededBy = winner.id;
        candidate.reasonCodes = ["superseded_by_stronger_candidate"];
      } else {
        candidate.status = "contested";
        candidate.reasonCodes =
          candidate.id === leader?.id ? leaderReasons : ["competing_candidate"];
      }
    }
    return {
      applicability,
      ...(winner ? { winner } : {}),
      candidates,
    };
  }
}

export function normalizeApplicability(
  input: ApplicabilityContext,
): ApplicabilityContext {
  if (!input || !APPLICABILITY_KINDS.includes(input.kind)) {
    throw new TypeError("applicability.kind is invalid");
  }
  const key = input.key?.trim();
  if (input.kind === "global" && key) {
    throw new TypeError("global applicability must not include a key");
  }
  if (input.kind !== "global" && !key) {
    throw new TypeError(`${input.kind} applicability requires a key`);
  }
  const validFrom = input.validFrom
    ? validDate(input.validFrom, "applicability.validFrom")
    : undefined;
  const validTo = input.validTo
    ? validDate(input.validTo, "applicability.validTo")
    : undefined;
  if (validFrom && validTo && validTo.getTime() <= validFrom.getTime()) {
    throw new TypeError("applicability.validTo must be after validFrom");
  }
  return {
    kind: input.kind,
    ...(key ? { key } : {}),
    ...(validFrom ? { validFrom } : {}),
    ...(validTo ? { validTo } : {}),
  };
}

export function storeApplicability(
  input: ApplicabilityContext,
): StoredApplicabilityContext {
  const value = normalizeApplicability(input);
  return {
    kind: value.kind,
    ...(value.key ? { key: value.key } : {}),
    ...(value.validFrom ? { validFrom: value.validFrom.toISOString() } : {}),
    ...(value.validTo ? { validTo: value.validTo.toISOString() } : {}),
  };
}

export function restoreApplicability(
  input: StoredApplicabilityContext,
): ApplicabilityContext {
  return normalizeApplicability({
    kind: input.kind,
    ...(input.key ? { key: input.key } : {}),
    ...(input.validFrom ? { validFrom: new Date(input.validFrom) } : {}),
    ...(input.validTo ? { validTo: new Date(input.validTo) } : {}),
  });
}

export function beliefClusterKey(
  scope: Scope,
  subjectKey: string,
  attributeKey: string,
  applicability: ApplicabilityContext,
): string {
  const value = normalizeApplicability(applicability);
  return `belief_cluster_${contentHash(
    JSON.stringify([
      scope.namespaceId ?? null,
      scope.userId ?? null,
      scope.agentId ?? null,
      scope.runId ?? null,
      subjectKey,
      attributeKey,
      value.kind,
      value.key ?? null,
    ]),
  )}`;
}

function candidateFromEvidence(
  rows: BeliefEvidence[],
  at: Date,
  includeEvidence: boolean,
  conflictingKeys: ReadonlySet<string>,
): BeliefCandidate {
  const activeRows = rows.filter(
    (row) => evidenceActiveAt(row, at) && !conflictingKeys.has(row.evidenceKey),
  );
  const independent = new Map<
    string,
    { weight: number; contextId: string; observedAt: Date }
  >();
  for (const row of activeRows.sort(
    (a, b) => a.observedAt.getTime() - b.observedAt.getTime(),
  )) {
    const current = independent.get(row.evidenceKey);
    if (!current) {
      independent.set(row.evidenceKey, {
        weight: row.weight,
        contextId: row.contextId,
        observedAt: row.observedAt,
      });
    } else if (row.weight > current.weight) {
      current.weight = row.weight;
    }
  }
  const reasonCodes: BeliefReasonCode[] = [];
  if (activeRows.length === 0) {
    if (
      rows.some(
        (row) =>
          evidenceActiveAt(row, at) && conflictingKeys.has(row.evidenceKey),
      )
    ) {
      reasonCodes.push("conflicting_independence_key");
    } else {
      reasonCodes.push("no_active_evidence");
    }
    if (rows.some((row) => !applicabilityActiveAt(row.applicability, at))) {
      reasonCodes.push("outside_applicability_window");
    }
  }
  const firstObservedAt = new Date(
    Math.min(...rows.map((row) => row.observedAt.getTime())),
  );
  const lastObservedAt = new Date(
    Math.max(...rows.map((row) => row.observedAt.getTime())),
  );
  return {
    id: rows[0]!.candidateKey,
    subject: rows[0]!.subject,
    attribute: rows[0]!.attribute,
    value: rows[0]!.value,
    applicability: applicabilityIdentity(rows[0]!.applicability),
    status: activeRows.length ? "contested" : "superseded",
    score: [...independent.values()].reduce(
      (sum, evidence) => sum + evidence.weight,
      0,
    ),
    support: 0,
    evidenceCount: independent.size,
    contextCount: new Set(
      [...independent.values()].map((evidence) => evidence.contextId),
    ).size,
    sourceIds: [...new Set(activeRows.map((row) => row.sourceId))].sort(),
    firstObservedAt,
    lastObservedAt,
    reasonCodes,
    ...(includeEvidence
      ? {
          evidence: rows
            .map((row) => ({
              id: row.id,
              sourceId: row.sourceId,
              evidenceKey: row.evidenceKey,
              contextId: row.contextId,
              applicability: cloneApplicability(row.applicability),
              observedAt: new Date(row.observedAt),
              validFrom: new Date(row.validFrom),
              ...(row.validTo ? { validTo: new Date(row.validTo) } : {}),
              weight: row.weight,
              active:
                evidenceActiveAt(row, at) &&
                !conflictingKeys.has(row.evidenceKey),
            }))
            .sort(
              (a, b) =>
                a.observedAt.getTime() - b.observedAt.getTime() ||
                a.id.localeCompare(b.id),
            ),
        }
      : {}),
  };
}

function conflictingEvidenceKeys(
  rows: BeliefEvidence[],
  at: Date,
): Set<string> {
  const values = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!evidenceActiveAt(row, at)) continue;
    const current = values.get(row.evidenceKey) ?? new Set<string>();
    current.add(row.valueKey);
    values.set(row.evidenceKey, current);
  }
  return new Set(
    [...values.entries()]
      .filter(([, claimedValues]) => claimedValues.size > 1)
      .map(([evidenceKey]) => evidenceKey),
  );
}

function evidenceActiveAt(row: BeliefEvidence, at: Date): boolean {
  const timestamp = at.getTime();
  return (
    row.validFrom.getTime() <= timestamp &&
    (!row.validTo || timestamp < row.validTo.getTime()) &&
    applicabilityActiveAt(row.applicability, at)
  );
}

function applicabilityActiveAt(
  applicability: ApplicabilityContext,
  at: Date,
): boolean {
  const timestamp = at.getTime();
  return (
    (!applicability.validFrom ||
      applicability.validFrom.getTime() <= timestamp) &&
    (!applicability.validTo || timestamp < applicability.validTo.getTime())
  );
}

function applicabilityIdentityEqual(
  left: ApplicabilityContext,
  right: ApplicabilityContext,
): boolean {
  return left.kind === right.kind && (left.key ?? "") === (right.key ?? "");
}

function applicabilityIdentity(
  applicability: ApplicabilityContext,
): ApplicabilityContext {
  return {
    kind: applicability.kind,
    ...(applicability.key ? { key: applicability.key } : {}),
  };
}

function bestCandidate(
  candidates: BeliefCandidate[],
): BeliefCandidate | undefined {
  return [...candidates].sort(compareCandidates)[0];
}

function compareCandidates(
  left: BeliefCandidate,
  right: BeliefCandidate,
): number {
  return (
    right.score - left.score ||
    right.evidenceCount - left.evidenceCount ||
    left.firstObservedAt.getTime() - right.firstObservedAt.getTime() ||
    left.id.localeCompare(right.id)
  );
}

function withoutEvidence(candidate: BeliefCandidate): BeliefCandidate {
  const { evidence: _ignored, ...visible } = candidate;
  return {
    ...visible,
    applicability: cloneApplicability(visible.applicability),
    sourceIds: [...visible.sourceIds],
    reasonCodes: [...visible.reasonCodes],
    firstObservedAt: new Date(visible.firstObservedAt),
    lastObservedAt: new Date(visible.lastObservedAt),
  };
}

function validatePolicy(policy: BeliefPolicy): Readonly<BeliefPolicy> {
  if (!Number.isInteger(policy.minimumEvidence) || policy.minimumEvidence < 1) {
    throw new TypeError("minimumEvidence must be a positive integer");
  }
  if (!Number.isInteger(policy.minimumContexts) || policy.minimumContexts < 1) {
    throw new TypeError("minimumContexts must be a positive integer");
  }
  if (
    !Number.isFinite(policy.minimumSupport) ||
    policy.minimumSupport <= 0 ||
    policy.minimumSupport > 1
  ) {
    throw new TypeError("minimumSupport must be within (0, 1]");
  }
  if (!Number.isFinite(policy.minimumLead) || policy.minimumLead < 0) {
    throw new TypeError("minimumLead must be non-negative");
  }
  return Object.freeze({ ...policy });
}

function requiredText(value: string, field: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new TypeError(`${field} must not be empty`);
  return normalized;
}

function validDate(value: Date, field: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError(`${field} must be a valid Date`);
  }
  return new Date(value);
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function copyScope(scope: Scope): Scope {
  return {
    ...(scope.namespaceId !== undefined
      ? { namespaceId: scope.namespaceId }
      : {}),
    ...(scope.userId !== undefined ? { userId: scope.userId } : {}),
    ...(scope.agentId !== undefined ? { agentId: scope.agentId } : {}),
    ...(scope.runId !== undefined ? { runId: scope.runId } : {}),
  };
}

function scopesEqual(left: Scope, right: Scope): boolean {
  return (
    left.namespaceId === right.namespaceId &&
    left.userId === right.userId &&
    left.agentId === right.agentId &&
    left.runId === right.runId
  );
}

function scopeContains(filter: Scope, value: Scope): boolean {
  return (
    (filter.namespaceId === undefined ||
      filter.namespaceId === value.namespaceId) &&
    (filter.userId === undefined || filter.userId === value.userId) &&
    (filter.agentId === undefined || filter.agentId === value.agentId) &&
    (filter.runId === undefined || filter.runId === value.runId)
  );
}

function cloneApplicability(
  applicability: ApplicabilityContext,
): ApplicabilityContext {
  return {
    kind: applicability.kind,
    ...(applicability.key ? { key: applicability.key } : {}),
    ...(applicability.validFrom
      ? { validFrom: new Date(applicability.validFrom) }
      : {}),
    ...(applicability.validTo
      ? { validTo: new Date(applicability.validTo) }
      : {}),
  };
}

function cloneEvidence(evidence: BeliefEvidence): BeliefEvidence {
  return {
    ...evidence,
    scope: copyScope(evidence.scope),
    applicability: cloneApplicability(evidence.applicability),
    observedAt: new Date(evidence.observedAt),
    validFrom: new Date(evidence.validFrom),
    ...(evidence.validTo ? { validTo: new Date(evidence.validTo) } : {}),
  };
}

function groupBy<T>(
  values: T[],
  keyOf: (value: T) => string,
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const key = keyOf(value);
    const current = grouped.get(key);
    if (current) current.push(value);
    else grouped.set(key, [value]);
  }
  return grouped;
}
