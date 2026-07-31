export type OperationStatus = "pending" | "committed" | "failed";
export type ProjectionStatus = "pending" | "ready" | "not_requested";
export type MemoryOperationKind =
  | "add"
  | "update"
  | "feedback"
  | "invalidate"
  | "delete"
  | "delete_all"
  | "purge"
  | "import"
  | "rebuild"
  | "document_ingest"
  | "document_delete";

export interface MemoryOperation {
  id: string;
  namespaceId: string;
  idempotencyKey: string;
  kind: MemoryOperationKind;
  requestHash: string;
  command: Record<string, unknown>;
  memoryIds: string[];
  episodeId?: string;
  status: OperationStatus;
  rawStatus: ProjectionStatus;
  vectorStatus: ProjectionStatus;
  derivedStatus: ProjectionStatus;
  result?: unknown;
  error?: string;
  leaseExpiresAt?: Date;
  attempts: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OperationSummary {
  pending: number;
  failed: number;
  vectorPending: number;
  derivedPending: number;
  oldestPendingAt?: Date;
}

export interface MemoryJournalEvent {
  id: string;
  namespaceId: string;
  operationId: string;
  memoryId: string;
  eventType: "ADD" | "UPDATE" | "FEEDBACK" | "INVALIDATE" | "DELETE" | "PURGE";
  payload: Record<string, unknown>;
  occurredAt: Date;
}

export interface OperationClaim {
  operation: MemoryOperation;
  claimed: boolean;
}
