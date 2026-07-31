export type DesktopStatus = {
  configured: boolean;
  embeddingState: "idle" | "downloading" | "indexing" | "ready" | "error";
  embeddingProgress?: number;
  embeddingError?: string;
  model?: string;
  dimensions?: number;
  databasePath: string;
  socketPath: string;
};

export type DesktopSummaryMemory = {
  id: string;
  content: string;
  source?: string;
  createdAt: string;
  lastAccessedAt: string;
  accessCount: number;
};

export type DesktopSummary = {
  totalMemories: number;
  rememberedToday: number;
  recalledToday: number;
  recentRemembered: DesktopSummaryMemory[];
  recentRecalled: DesktopSummaryMemory[];
};

export type DesktopMemoryRecord = {
  id: string;
  content: string;
  memoryType: string;
  importance: number;
  userId?: string;
  agentId?: string;
  runId?: string;
  source?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  eventDate?: string;
  validFrom?: string;
  validTo?: string;
  subject?: string;
  attribute?: string;
  supersededBy?: string;
  lastAccessedAt: string;
  accessCount: number;
  score?: number;
};

export type DesktopMemoryPage = {
  results: DesktopMemoryRecord[];
  nextCursor?: string;
};

export type DesktopMemoryHistoryRecord = {
  id: string;
  memory_id: string;
  event: string;
  previous_value?: string | null;
  new_value?: string | null;
  created_at: string;
};

export type DesktopMemoryHistoryPage = {
  results: DesktopMemoryHistoryRecord[];
};

/** Structural memory owner; distinct from named graph entities. */
export type DesktopScopeEntity = {
  id: string;
  type: "user" | "agent" | "run";
  total_memories: number;
  created_at: string;
  updated_at: string;
};

export type DesktopScopeEntityPage = {
  results: DesktopScopeEntity[];
  next_cursor: string | null;
};

export type DesktopMethod =
  | "status"
  | "summary"
  | "retryEmbedding"
  | "list"
  | "add"
  | "search"
  | "get"
  | "update"
  | "delete"
  | "deleteAll"
  | "batchUpdate"
  | "batchDelete"
  | "history"
  | "getFeedback"
  | "setFeedback"
  | "clearFeedback"
  | "entityList"
  | "entityGet"
  | "entityDelete"
  | "documentIngest"
  | "documentList"
  | "documentSearch"
  | "documentGet"
  | "documentContent"
  | "documentDelete";

export type DesktopErrorCode =
  | "LOCAL_EMBEDDING_NOT_READY"
  | "LOCAL_EMBEDDING_UNAVAILABLE";

export type IntegrationClient = "codex" | "claude-code";

export type ClientIntegrationStatus = {
  connected: boolean;
  skillPath: string;
};

export type IntegrationStatus = {
  cliPath: string;
  commandPath: string;
  codex: ClientIntegrationStatus;
  claudeCode: ClientIntegrationStatus;
};

export type DesktopIpcMethod =
  | DesktopMethod
  | "integrationStatus"
  | "connectIntegration"
  | "disconnectIntegration";

export type RpcRequest = {
  id: string;
  token: string;
  method: DesktopMethod;
  params?: unknown;
};

export type RpcResponse = {
  id: string;
  result?: unknown;
  error?: { message: string; code?: DesktopErrorCode };
};

export type DesktopApi = {
  invoke<T>(method: DesktopIpcMethod, params?: unknown): Promise<T>;
};
