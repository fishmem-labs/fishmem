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
	/** Cosine similarity to the search query (when requested). */
	similarity?: number;
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
	| "documentDelete"
	| "exportSnapshot"
	| "importSnapshot"
	| "restoreSnapshot"
	| "remember"
	| "invalidate"
	| "supersede"
	| "duplicates"
	| "maintenance";

/** An existing memory similar to a candidate write. */
export type DesktopSimilarMemory = {
	id: string;
	content: string;
	/** Cosine similarity of local E5 embeddings, in [-1, 1]. */
	similarity: number;
	exact?: boolean;
	scope: "project" | "global";
	project?: string;
	memoryType: string;
	createdAt: string;
	updatedAt: string;
};

/** Result of `remember`: a dry-run reconcile check that never writes. */
export type DesktopRememberResult = {
	content: string;
	scope: "project" | "global";
	project?: string;
	exact_duplicate: DesktopSimilarMemory | null;
	similar: DesktopSimilarMemory[];
	suggested_action: "skip" | "review" | "add";
	guidance: string;
};

export type DesktopDuplicatePairs = {
	threshold: number;
	scanned: number;
	pairs: Array<{
		similarity: number;
		exact: boolean;
		memories: Array<Omit<DesktopSimilarMemory, "similarity">>;
	}>;
};

export type DesktopMaintenanceResult = {
	started_at: string;
	finished_at: string;
	scanned: number;
	exact_duplicates_removed: number;
	removed_ids: string[];
};

export type DesktopErrorCode =
	| "LOCAL_EMBEDDING_NOT_READY"
	| "LOCAL_EMBEDDING_UNAVAILABLE";

export type IntegrationClient = "codex" | "claude-code";

export type ClientIntegrationStatus = {
	connected: boolean;
	skillPath: string;
	/** Claude Code only: automatic recall hooks are installed in settings.json. */
	hooks?: boolean;
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
	| "disconnectIntegration"
	| "exportBackup"
	| "restoreBackup";

export type DesktopBackupResult = {
	canceled: boolean;
	path?: string;
	imported?: number;
	documents?: number;
	vectors?: number;
};

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
