export type MemoryScope = {
	user_id?: string;
	agent_id?: string;
	run_id?: string;
};

/** Structural memory owner; distinct from a named entity in the memory graph. */
export type ScopeEntityType = "user" | "agent" | "run";

export type ScopeEntity = {
	id: string;
	type: ScopeEntityType;
	total_memories: number;
	created_at: string;
	updated_at: string;
};

export type ScopeEntityPage = {
	results: ScopeEntity[];
	next_cursor: string | null;
};

export type ListScopeEntitiesInput = {
	type?: ScopeEntityType;
	cursor?: string;
	limit?: number;
};

export type DeleteScopeEntityResult = {
	id: string;
	type: ScopeEntityType;
	deleted_memories: number;
};

export type MemoryMessage = {
	role: "user" | "assistant" | "system" | "tool";
	content: string;
};

export type AddMemoryInput = MemoryScope & {
	content?: string;
	messages?: MemoryMessage[];
	infer?: boolean;
	/** Event time for imported or explicitly dated facts. */
	event_date?: string;
	metadata?: Record<string, unknown>;
};

export type MemoryType =
	| "fact"
	| "preference"
	| "decision"
	| "identity"
	| "event"
	| "observation"
	| "goal"
	| "todo";

export type SearchMode = "hybrid" | "recent" | "important" | "typed";

export type SearchStrategy = "balanced" | "precision" | "recall" | "auto";

export type SearchSort =
	| "recent"
	| "importance"
	| "most_accessed"
	| "last_accessed";

export type MetadataFilterValue = string | number | boolean | null;

export type MemoryFilterField =
	| "id"
	| "content"
	| "memory_type"
	| "importance"
	| "created_at"
	| "updated_at"
	| "event_date"
	| "last_accessed_at"
	| "access_count"
	| "subject"
	| "attribute"
	| `metadata.${string}`;

export type MemoryFilterOperator =
	| "eq"
	| "ne"
	| "in"
	| "nin"
	| "gt"
	| "gte"
	| "lt"
	| "lte"
	| "contains"
	| "icontains"
	| "exists";

export type MemoryFilterCondition =
	| {
			field: MemoryFilterField;
			operator: "in" | "nin";
			value: MetadataFilterValue[];
	  }
	| {
			field: MemoryFilterField;
			operator: "exists";
			value: boolean;
	  }
	| {
			field: MemoryFilterField;
			operator: Exclude<MemoryFilterOperator, "in" | "nin" | "exists">;
			value: MetadataFilterValue;
	  };

export type MemoryFilterExpression =
	| MemoryFilterCondition
	| { and: MemoryFilterExpression[] }
	| { or: MemoryFilterExpression[] }
	| { not: MemoryFilterExpression };

/** Legacy metadata equality map or the canonical logical filter expression. */
export type MemoryFiltersInput =
	| Record<string, MetadataFilterValue>
	| MemoryFilterExpression;

export type SearchMemoriesInput = MemoryScope & {
	query: string;
	limit?: number;
	top_k?: number;
	memory_type?: MemoryType;
	mode?: SearchMode;
	search_strategy?: SearchStrategy;
	sort_by?: SearchSort;
	min_score?: number;
	filters?: MemoryFiltersInput;
	trace?: boolean;
};

export type ListMemoriesInput = MemoryScope & {
	cursor?: string;
	limit?: number;
};

export type UpdateMemoryInput = {
	content?: string;
	metadata?: Record<string, unknown>;
	importance?: number;
	memory_type?: MemoryType;
	version?: string;
};

export type MemoryFeedbackRating = "positive" | "negative" | "very_negative";

export type SetMemoryFeedbackInput = {
	rating: MemoryFeedbackRating;
	reason?: string;
	request_id?: string;
};

export type MemoryFeedback = {
	id: string;
	memory_id: string;
	rating: MemoryFeedbackRating;
	reason: string | null;
	request_id: string | null;
	created_at: string;
};

export type MemoryFeedbackResponse = {
	feedback: MemoryFeedback | null;
};

export type ClearMemoryFeedbackResponse = {
	cleared: boolean;
};

export type BatchUpdateMemoryInput = UpdateMemoryInput & {
	memory_id: string;
};

export type BatchUpdateMemoriesInput = {
	memories: BatchUpdateMemoryInput[];
};

export type BatchDeleteMemoriesInput = {
	memories: Array<{ memory_id: string }>;
};

export type MemoryBatchItemResult =
	| {
			memory_id: string;
			status: "succeeded";
			event: "UPDATE" | "DELETE";
	  }
	| {
			memory_id: string;
			status: "failed";
			error: { code: string; message: string };
	  };

export type MemoryBatchResult = {
	total: number;
	processed: number;
	succeeded: number;
	failed: number;
	items: MemoryBatchItemResult[];
};

export type Memory = {
	id: string;
	memory: string;
	memory_type: string;
	importance: number;
	user_id: string | null;
	agent_id: string | null;
	run_id: string | null;
	metadata: Record<string, unknown> | null;
	created_at: string;
	updated_at: string;
	event_date: string | null;
	valid_from: string | null;
	valid_to: string | null;
	subject?: string | null;
	attribute?: string | null;
	superseded_by?: string | null;
	access_count?: number;
	last_accessed_at?: string | null;
	score?: number;
};

export type AddMemoryResult = {
	id: string;
	memory: string;
	event: "ADD" | "UPDATE" | "DELETE" | "INVALIDATE";
};

export type AddMemoriesResult = {
	results: AddMemoryResult[];
};

export type AsyncMemoryReceipt = {
	message: string;
	status: MemoryEventStatus;
	event_id: string;
};

export type MemoryEventStatus =
	| "PENDING"
	| "RUNNING"
	| "RETRYING"
	| "SUCCEEDED"
	| "FAILED";

export type MemoryWriteSummary = {
	outcome: "STORED" | "NO_MEMORY";
	planned: number;
	persisted: number;
	failed: number;
};

export type MemoryEvent = {
	id: string;
	event_type: "ADD";
	status: MemoryEventStatus;
	scope: MemoryScope;
	results: AddMemoryResult[];
	write_summary: MemoryWriteSummary | null;
	attempts: number;
	max_attempts: number;
	error: string | null;
	created_at: string;
	updated_at: string;
	started_at: string | null;
	completed_at: string | null;
	latency_ms: number | null;
};

export type MemoryEventPage = {
	results: MemoryEvent[];
	next_cursor: string | null;
};

export type ListMemoryEventsInput = {
	cursor?: string;
	limit?: number;
	status?: MemoryEventStatus;
};

export type DeleteMemoryResult = {
	id: string;
	deleted: true;
};

export type DeleteMemoriesResult = {
	deleted: number;
};

export type MemoryPage = {
	results: Memory[];
	next_cursor: string | null;
};

export type BeliefEntry = {
	id: string;
	content: string;
	event_date: string | null;
	valid_from: string | null;
	valid_to: string | null;
	current: boolean;
};

export type BeliefChain = {
	subject: string;
	attribute: string;
	entries: BeliefEntry[];
};

export type SearchTrace = {
	lists: {
		vector: Array<{ id: string; score: number }>;
		fts: Array<{ id: string; score: number }>;
		graph: Array<{ id: string; score: number }>;
		temporal: Array<{ id: string; score: number }>;
	};
	fused: Array<{ id: string; score: number }>;
	selected: string[];
	selected_items: Array<{ id: string; content: string }>;
};

export type SearchMemoriesResult = {
	results: Memory[];
	beliefs?: BeliefChain[];
	trace?: SearchTrace;
};

export type MemoryHistoryEntry = {
	id: string;
	memory_id: string;
	event: "ADD" | "UPDATE" | "DELETE" | "INVALIDATE" | "FEEDBACK" | "NONE";
	previous_value: string | null;
	new_value: string | null;
	created_at: string;
};

export type MemoryOperation<TResult = unknown> = {
	id: string;
	kind:
		| "add"
		| "update"
		| "feedback"
		| "invalidate"
		| "delete"
		| "delete_all"
		| "batch_update"
		| "batch_delete"
		| "purge"
		| "import"
		| "rebuild"
		| "derive"
		| "export"
		| "maintenance"
		| "memory_infer"
		| "document_extract"
		| "document_ingest"
		| "document_delete";
	status:
		| "pending"
		| "processing"
		| "retry"
		| "success"
		| "dead"
		| "committed"
		| "failed"
		| "awaiting_upload"
		| "cancelled";
	raw_status?: "pending" | "ready" | "not_requested";
	vector_status?: "pending" | "ready" | "not_requested";
	derived_status?: "pending" | "ready" | "not_requested";
	attempts: number;
	max_attempts?: number;
	error: string | null;
	next_attempt_at?: string | null;
	result?: TResult | null;
	started_at?: string | null;
	completed_at?: string | null;
	created_at: string;
	updated_at: string;
};

export type HealthStatus = {
	status: "ok" | "degraded";
	checked_at: string;
	engine: {
		configured: boolean;
		initialized: boolean;
		code: string | null;
	};
	operations: {
		pending: number;
		failed: number;
		oldest_pending_at: string | null;
	};
	tasks: {
		pending: number;
		dead: number;
		oldest_pending_at: string | null;
	};
	projections: {
		vector_pending: number;
		derived_pending: number;
	};
	warnings: {
		last_24h: number;
	};
};

export type IngestDocumentInput = MemoryScope & {
	source_key: string;
	content: string;
	title?: string;
	mime_type?: string;
	source_uri?: string;
	metadata?: Record<string, unknown>;
};

export type UploadDocumentInput = Omit<
	IngestDocumentInput,
	"content" | "source_key"
> & {
	file: Blob;
	filename?: string;
	source_key?: string;
};

export type CreateDocumentUploadInput = MemoryScope & {
	filename: string;
	size_bytes: number;
	content_type: string;
	checksum_sha256?: string;
	source_key?: string;
	title?: string;
	source_uri?: string;
	metadata?: Record<string, unknown>;
};

export type SourceAsset = {
	id: string;
	operation_id: string;
	source_key: string;
	filename: string;
	content_type: string;
	size_bytes: number;
	checksum_sha256: string | null;
	status:
		| "awaiting_upload"
		| "uploaded"
		| "queued"
		| "processing"
		| "ready"
		| "failed"
		| "cancelled";
	title: string | null;
	source_uri: string | null;
	user_id: string | null;
	agent_id: string | null;
	run_id: string | null;
	metadata: Record<string, unknown> | null;
	artifact_id: string | null;
	document_id: string | null;
	error: string | null;
	uploaded_at: string | null;
	created_at: string;
	updated_at: string;
};

export type CreateDocumentUploadResult = {
	source_asset: SourceAsset;
	upload: {
		method: "PUT";
		url: string;
		headers: Record<string, string>;
		max_bytes: number;
	};
	operation: MemoryOperation;
};

export type CompleteDocumentUploadResult = {
	source_asset: SourceAsset;
	operation: MemoryOperation;
};

export type SearchDocumentsInput = MemoryScope & {
	query: string;
	limit?: number;
	neighbors?: number;
	source_key?: string;
};

export type ListDocumentsInput = MemoryScope & {
	source_key?: string;
	cursor?: string;
	limit?: number;
};

export type Document = {
	id: string;
	source_key: string;
	content_hash: string;
	version_hash: string;
	title: string | null;
	mime_type: string;
	source_uri: string | null;
	user_id: string | null;
	agent_id: string | null;
	run_id: string | null;
	metadata: Record<string, unknown> | null;
	size_bytes: number;
	created_at: string;
};

export type DocumentContent = {
	id: string;
	content: string;
	content_hash: string;
};

export type DocumentChunk = {
	id: string;
	document_id: string;
	source_key: string;
	index: number;
	content: string;
	start_byte: number;
	end_byte: number;
	content_hash: string;
};

export type DocumentSearchHit = {
	document: Document;
	chunk: DocumentChunk;
	neighbors: DocumentChunk[];
	score: number;
};

export type IngestDocumentResult = {
	document: Document;
	chunks: number;
	created: boolean;
};

export type DocumentPage = {
	results: Document[];
	next_cursor: string | null;
};

export type SearchDocumentsResult = {
	results: DocumentSearchHit[];
};

export type DeleteDocumentResult = {
	id: string;
	deleted: true;
	versions: number;
	chunks: number;
};

export type StateQuery = MemoryScope & {
	subject: string;
	attribute: string;
	as_of?: string;
};

export type StateSlot = {
	id: string;
	subject: string;
	attribute: string;
	value: string;
	valid_from: string;
	valid_to: string | null;
	superseded_by: string | null;
	source_ids: string[];
};

export type ProfileQuery = MemoryScope & {
	query?: string;
	limit?: number;
};

export type ProfileSection = {
	id: string;
	title: string;
	content: string;
	score: number;
};

export type ImportMemoriesInput = {
	snapshot: Record<string, unknown>;
};

export type RequestOptions = {
	idempotencyKey?: string;
	signal?: AbortSignal;
	headers?: HeadersInit;
};

export type IdempotentRequestOptions = RequestOptions & {
	idempotencyKey: string;
};

export type WaitForOperationOptions = RequestOptions & {
	intervalMs?: number;
	timeoutMs?: number;
};

export type WaitForEventOptions = RequestOptions & {
	intervalMs?: number;
	timeoutMs?: number;
};
