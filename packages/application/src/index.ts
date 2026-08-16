import {
	AddMemoryCommandSchema,
	BeliefQuerySchema,
	DocumentListInputSchema,
	DocumentSearchInputSchema,
	IdempotencyKeySchema,
	IngestDocumentCommandSchema,
	ListScopeEntitiesQuerySchema,
	ListDocumentQuerySchema,
	ProfileQuerySchema,
	SearchDocumentCommandSchema,
	SearchMemoryCommandSchema,
	SetMemoryFeedbackCommandSchema,
	ScopeEntityIdSchema,
	ScopeEntityTypeSchema,
	StateQuerySchema,
	UpdateMemoryCommandSchema,
	WorkspaceSearchMemoryCommandSchema,
} from "@fishmem/contracts";
import type {
	MemoryFilterExpressionWire,
	SearchMemoryCommand,
	WorkspaceSearchMemoryCommand,
} from "@fishmem/contracts";
import type {
	Memory,
	MemoryFeedback,
	MemoryFilterExpression,
	MemoryFilterField,
	NamespacedMemory,
	ScopeEntity,
	ScopeEntityType,
} from "fishmem";

export class MemoryApplicationError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status: number,
		readonly details?: unknown,
	) {
		super(message);
	}
}

type Engine = Pick<Memory, "forNamespace">;

function scope(command: {
	user_id?: string;
	agent_id?: string;
	run_id?: string;
}) {
	return {
		userId: command.user_id,
		agentId: command.agent_id,
		runId: command.run_id,
	};
}

function searchOptions(
	command: SearchMemoryCommand | WorkspaceSearchMemoryCommand,
) {
	const requestScope =
		"user_id" in command || "agent_id" in command || "run_id" in command
			? scope(command)
			: {};
	return {
		...requestScope,
		limit: command.top_k ?? command.limit ?? 10,
		...(command.memory_type ? { memoryType: command.memory_type } : {}),
		...(command.mode ? { mode: command.mode } : {}),
		...(command.search_strategy
			? { searchStrategy: command.search_strategy }
			: {}),
		...(command.sort_by ? { sortBy: command.sort_by } : {}),
		...(command.min_score !== undefined ? { minScore: command.min_score } : {}),
		...(command.filters
			? isAdvancedFilter(command.filters)
				? { filter: compileFilter(command.filters) }
				: { filters: command.filters }
			: {}),
		...(command.trace ? { trace: true } : {}),
	};
}

function isAdvancedFilter(
	value: Record<string, unknown> | MemoryFilterExpressionWire,
): value is MemoryFilterExpressionWire {
	return "field" in value || "and" in value || "or" in value || "not" in value;
}

const FILTER_FIELDS: Record<string, MemoryFilterField> = {
	id: "id",
	content: "content",
	memory_type: "memoryType",
	importance: "importance",
	created_at: "createdAt",
	updated_at: "updatedAt",
	event_date: "eventDate",
	last_accessed_at: "lastAccessedAt",
	access_count: "accessCount",
	subject: "subject",
	attribute: "attribute",
};

function compileFilter(
	expression: MemoryFilterExpressionWire,
): MemoryFilterExpression {
	if ("and" in expression) {
		return { kind: "and", conditions: expression.and.map(compileFilter) };
	}
	if ("or" in expression) {
		return { kind: "or", conditions: expression.or.map(compileFilter) };
	}
	if ("not" in expression) {
		return { kind: "not", condition: compileFilter(expression.not) };
	}
	const field = expression.field.startsWith("metadata.")
		? (expression.field as MemoryFilterField)
		: FILTER_FIELDS[expression.field];
	if (!field) {
		throw new MemoryApplicationError(
			"INVALID_FILTER",
			`Unsupported filter field: ${expression.field}`,
			400,
		);
	}
	const dateField = [
		"created_at",
		"updated_at",
		"event_date",
		"last_accessed_at",
	].includes(expression.field);
	const value = Array.isArray(expression.value)
		? expression.value.map((item) =>
				dateField ? new Date(String(item)) : item,
			)
		: dateField
			? new Date(String(expression.value))
			: expression.value;
	return {
		kind: "condition",
		field,
		operator: expression.operator,
		value,
	};
}

function encodeCursor(createdAt: Date, id: string): string {
	return btoa(`${createdAt.toISOString()}\0${id}`);
}

function decodeCursor(
	cursor?: string,
): { createdAt: Date; id: string } | undefined {
	if (!cursor) return undefined;
	try {
		const [createdAt, id] = atob(cursor).split("\0", 2);
		const date = new Date(createdAt ?? "");
		if (!id || Number.isNaN(date.getTime())) throw new Error("invalid cursor");
		return { createdAt: date, id };
	} catch {
		throw new MemoryApplicationError("INVALID_CURSOR", "Invalid cursor", 400);
	}
}

function encodeScopeEntityCursor(entity: ScopeEntity): string {
	const payload = JSON.stringify([
		entity.updatedAt.toISOString(),
		entity.type,
		entity.id,
	]);
	let binary = "";
	for (const byte of new TextEncoder().encode(payload)) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

function decodeScopeEntityCursor(
	cursor?: string,
): { updatedAt: Date; type: ScopeEntityType; id: string } | undefined {
	if (!cursor) return undefined;
	try {
		const normalized = cursor.replaceAll("-", "+").replaceAll("_", "/");
		const padded = normalized.padEnd(
			normalized.length + ((4 - (normalized.length % 4)) % 4),
			"=",
		);
		const binary = atob(padded);
		const bytes = Uint8Array.from(binary, (character) =>
			character.charCodeAt(0),
		);
		const decoded: unknown = JSON.parse(new TextDecoder().decode(bytes));
		if (!Array.isArray(decoded) || decoded.length !== 3) throw new Error();
		const [timestamp, rawType, rawId] = decoded;
		const updatedAt = new Date(String(timestamp));
		const type = ScopeEntityTypeSchema.parse(rawType);
		const id = ScopeEntityIdSchema.parse(rawId);
		if (Number.isNaN(updatedAt.getTime())) throw new Error();
		return { updatedAt, type, id };
	} catch {
		throw new MemoryApplicationError("INVALID_CURSOR", "Invalid cursor", 400);
	}
}

function scopeEntityView(entity: ScopeEntity) {
	return {
		id: entity.id,
		type: entity.type,
		total_memories: entity.totalMemories,
		created_at: entity.createdAt.toISOString(),
		updated_at: entity.updatedAt.toISOString(),
	};
}

type OperationRecord = NonNullable<
	Awaited<ReturnType<NamespacedMemory["getOperation"]>>
>;

function operationView(operation: OperationRecord) {
	return {
		id: operation.id,
		kind: operation.kind,
		status: operation.status,
		raw_status: operation.rawStatus,
		vector_status: operation.vectorStatus,
		derived_status: operation.derivedStatus,
		attempts: operation.attempts,
		error: operation.error ?? null,
		created_at: operation.createdAt.toISOString(),
		updated_at: operation.updatedAt.toISOString(),
	};
}

type DocumentRecord = NonNullable<
	Awaited<ReturnType<NamespacedMemory["getDocument"]>>
>;
type DocumentSearchRecord = Awaited<
	ReturnType<NamespacedMemory["searchDocuments"]>
>[number];

function documentView(document: Omit<DocumentRecord, "content">) {
	return {
		id: document.id,
		source_key: document.sourceKey,
		content_hash: document.contentHash,
		version_hash: document.versionHash,
		title: document.title ?? null,
		mime_type: document.mimeType,
		source_uri: document.sourceUri ?? null,
		user_id: document.userId ?? null,
		agent_id: document.agentId ?? null,
		run_id: document.runId ?? null,
		metadata: document.metadata ?? null,
		size_bytes: document.sizeBytes,
		created_at: document.createdAt.toISOString(),
	};
}

function documentChunkView(chunk: DocumentSearchRecord["chunk"]) {
	return {
		id: chunk.id,
		document_id: chunk.documentId,
		source_key: chunk.sourceKey,
		index: chunk.index,
		content: chunk.content,
		start_byte: chunk.startOffset,
		end_byte: chunk.endOffset,
		content_hash: chunk.contentHash,
	};
}

function feedbackView(feedback: MemoryFeedback) {
	return {
		id: feedback.id,
		memory_id: feedback.memoryId,
		rating: feedback.rating,
		reason: feedback.reason ?? null,
		request_id: feedback.requestId ?? null,
		created_at: feedback.createdAt.toISOString(),
	};
}

export class MemoryApplication {
	constructor(private readonly engine: Engine) {}

	private namespace(namespaceId: string): NamespacedMemory {
		return this.engine.forNamespace(namespaceId);
	}

	async add(namespaceId: string, body: unknown, idempotencyKey?: string) {
		const command = AddMemoryCommandSchema.parse(body);
		const key = idempotencyKey
			? IdempotencyKeySchema.parse(idempotencyKey)
			: undefined;
		const input = command.messages ?? command.content!;
		const result = await this.namespace(namespaceId).add(input, {
			...scope(command),
			infer: command.infer,
			idempotencyKey: key,
			metadata: command.metadata,
			...(command.event_date
				? { eventDate: new Date(command.event_date) }
				: {}),
		});
		return {
			results: result.results.map((item) => ({
				id: item.id,
				memory: item.memory,
				event: item.event,
			})),
		};
	}

	async search(namespaceId: string, body: unknown) {
		const command = SearchMemoryCommandSchema.parse(body);
		const result = await this.namespace(namespaceId).search(
			command.query,
			searchOptions(command),
		);
		return result;
	}

	async searchWorkspace(namespaceId: string, body: unknown) {
		const command = WorkspaceSearchMemoryCommandSchema.parse(body);
		const result = await this.namespace(namespaceId).search(
			command.query,
			searchOptions(command),
		);
		return result;
	}

	async list(
		namespaceId: string,
		input: {
			user_id?: string;
			agent_id?: string;
			run_id?: string;
			cursor?: string;
			limit?: number;
		},
	) {
		const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
		const result = await this.namespace(namespaceId).getAll({
			...scope(input),
			cursor: decodeCursor(input.cursor),
			limit: limit + 1,
			sort: "recent",
		});
		const hasMore = result.results.length > limit;
		const items = result.results.slice(0, limit);
		const last = items.at(-1);
		return {
			results: items,
			next_cursor:
				hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
		};
	}

	async listScopeEntities(namespaceId: string, input: unknown) {
		const command = ListScopeEntitiesQuerySchema.parse(input);
		const results = await this.namespace(namespaceId).listScopeEntities({
			type: command.type,
			cursor: decodeScopeEntityCursor(command.cursor),
			limit: command.limit + 1,
		});
		const hasMore = results.length > command.limit;
		const items = results.slice(0, command.limit);
		const last = items.at(-1);
		return {
			results: items.map(scopeEntityView),
			next_cursor: hasMore && last ? encodeScopeEntityCursor(last) : null,
		};
	}

	async stats(namespaceId: string) {
		return this.namespace(namespaceId).stats();
	}

	async getScopeEntity(namespaceId: string, rawType: unknown, rawId: unknown) {
		const type = ScopeEntityTypeSchema.parse(rawType);
		const id = ScopeEntityIdSchema.parse(rawId);
		const entity = await this.namespace(namespaceId).getScopeEntity(type, id);
		if (!entity) {
			throw new MemoryApplicationError(
				"SCOPE_ENTITY_NOT_FOUND",
				"Scope entity not found",
				404,
			);
		}
		return scopeEntityView(entity);
	}

	async deleteScopeEntity(
		namespaceId: string,
		rawType: unknown,
		rawId: unknown,
		idempotencyKey: string,
	) {
		const type = ScopeEntityTypeSchema.parse(rawType);
		const id = ScopeEntityIdSchema.parse(rawId);
		const key = IdempotencyKeySchema.parse(idempotencyKey);
		const entityScope =
			type === "user"
				? { userId: id }
				: type === "agent"
					? { agentId: id }
					: { runId: id };
		const result = await this.namespace(namespaceId).deleteAll(entityScope, {
			idempotencyKey: key,
		});
		if (result.deleted === 0) {
			throw new MemoryApplicationError(
				"SCOPE_ENTITY_NOT_FOUND",
				"Scope entity not found",
				404,
			);
		}
		return { id, type, deleted_memories: result.deleted };
	}

	async update(
		namespaceId: string,
		memoryId: string,
		body: unknown,
		idempotencyKey?: string,
	) {
		const command = UpdateMemoryCommandSchema.parse(body);
		const memory = await this.namespace(namespaceId).get(memoryId);
		if (!memory) {
			throw new MemoryApplicationError(
				"MEMORY_NOT_FOUND",
				"Memory not found",
				404,
			);
		}
		const version = memory.updatedAt.toISOString();
		if (command.version && command.version !== version) {
			throw new MemoryApplicationError(
				"VERSION_CONFLICT",
				"Memory was modified by another request",
				409,
				{ current_version: version },
			);
		}
		return this.namespace(namespaceId).update(
			memoryId,
			{
				content: command.content,
				metadata: command.metadata,
				importance: command.importance,
				memoryType: command.memory_type as never,
			},
			{
				idempotencyKey: idempotencyKey
					? IdempotencyKeySchema.parse(idempotencyKey)
					: undefined,
			},
		);
	}

	async get(namespaceId: string, memoryId: string) {
		const memory = await this.namespace(namespaceId).get(memoryId);
		if (!memory) {
			throw new MemoryApplicationError(
				"MEMORY_NOT_FOUND",
				"Memory not found",
				404,
			);
		}
		return memory;
	}

	async history(namespaceId: string, memoryId: string) {
		const history = await this.namespace(namespaceId).history(memoryId);
		if (!history.length) {
			throw new MemoryApplicationError(
				"MEMORY_NOT_FOUND",
				"Memory not found",
				404,
			);
		}
		return history;
	}

	async getFeedback(namespaceId: string, memoryId: string) {
		await this.get(namespaceId, memoryId);
		const feedback = await this.namespace(namespaceId).getFeedback(memoryId);
		return { feedback: feedback ? feedbackView(feedback) : null };
	}

	async setFeedback(
		namespaceId: string,
		memoryId: string,
		body: unknown,
		idempotencyKey?: string,
	) {
		const command = SetMemoryFeedbackCommandSchema.parse(body);
		await this.get(namespaceId, memoryId);
		const feedback = await this.namespace(namespaceId).setFeedback(
			memoryId,
			{
				rating: command.rating,
				reason: command.reason,
				requestId: command.request_id,
			},
			{
				idempotencyKey: idempotencyKey
					? IdempotencyKeySchema.parse(idempotencyKey)
					: undefined,
			},
		);
		return { feedback: feedbackView(feedback) };
	}

	async clearFeedback(
		namespaceId: string,
		memoryId: string,
		idempotencyKey?: string,
	) {
		await this.get(namespaceId, memoryId);
		const cleared = await this.namespace(namespaceId).clearFeedback(memoryId, {
			idempotencyKey: idempotencyKey
				? IdempotencyKeySchema.parse(idempotencyKey)
				: undefined,
		});
		return { cleared };
	}

	async delete(namespaceId: string, memoryId: string, idempotencyKey?: string) {
		const deleted = await this.namespace(namespaceId).delete(memoryId, {
			idempotencyKey: idempotencyKey
				? IdempotencyKeySchema.parse(idempotencyKey)
				: undefined,
		});
		if (!deleted) {
			throw new MemoryApplicationError(
				"MEMORY_NOT_FOUND",
				"Memory not found",
				404,
			);
		}
		return { id: memoryId, deleted: true };
	}

	async ingestDocument(
		namespaceId: string,
		body: unknown,
		idempotencyKey?: string,
	) {
		const command = IngestDocumentCommandSchema.parse(body);
		const key = idempotencyKey
			? IdempotencyKeySchema.parse(idempotencyKey)
			: `document:${crypto.randomUUID()}`;
		const result = await this.namespace(namespaceId).ingestDocument(
			{
				sourceKey: command.source_key,
				content: command.content,
				title: command.title,
				mimeType: command.mime_type,
				sourceUri: command.source_uri,
				metadata: command.metadata,
			},
			{
				...scope(command),
				idempotencyKey: key,
			},
		);
		return {
			document: documentView(result.document),
			chunks: result.chunks,
			created: result.created,
		};
	}

	async listDocuments(
		namespaceId: string,
		query: unknown,
		options: { requireScope?: boolean } = {},
	) {
		const command = (
			options.requireScope === false
				? DocumentListInputSchema
				: ListDocumentQuerySchema
		).parse(query);
		const limit = command.limit;
		const results = await this.namespace(namespaceId).listDocuments(
			{
				...scope(command),
				sourceKey: command.source_key,
			},
			{
				cursor: decodeCursor(command.cursor),
				limit: limit + 1,
			},
		);
		const hasMore = results.length > limit;
		const items = results.slice(0, limit);
		const last = items.at(-1);
		return {
			results: items.map(documentView),
			next_cursor:
				hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
		};
	}

	async getDocument(namespaceId: string, documentId: string) {
		const document = await this.namespace(namespaceId).getDocument(documentId);
		if (!document) {
			throw new MemoryApplicationError(
				"DOCUMENT_NOT_FOUND",
				"Document not found",
				404,
			);
		}
		const { content: _content, ...descriptor } = document;
		return documentView(descriptor);
	}

	async getDocumentContent(namespaceId: string, documentId: string) {
		const document = await this.namespace(namespaceId).getDocument(documentId);
		if (!document) {
			throw new MemoryApplicationError(
				"DOCUMENT_NOT_FOUND",
				"Document not found",
				404,
			);
		}
		return {
			id: document.id,
			content: document.content,
			content_hash: document.contentHash,
		};
	}

	async searchDocuments(
		namespaceId: string,
		body: unknown,
		options: { requireScope?: boolean } = {},
	) {
		const command = (
			options.requireScope === false
				? DocumentSearchInputSchema
				: SearchDocumentCommandSchema
		).parse(body);
		const results = await this.namespace(namespaceId).searchDocuments(
			command.query,
			{
				...scope(command),
				limit: command.limit,
				neighbors: command.neighbors,
				sourceKey: command.source_key,
			},
		);
		return {
			results: results.map((result) => ({
				document: documentView(result.document),
				chunk: documentChunkView(result.chunk),
				neighbors: result.neighbors.map(documentChunkView),
				score: result.score,
			})),
		};
	}

	async deleteDocument(
		namespaceId: string,
		documentId: string,
		idempotencyKey?: string,
	) {
		const key = idempotencyKey
			? IdempotencyKeySchema.parse(idempotencyKey)
			: `document-delete:${crypto.randomUUID()}`;
		try {
			return await this.namespace(namespaceId).deleteDocument(documentId, {
				idempotencyKey: key,
			});
		} catch (error) {
			if (
				error instanceof Error &&
				error.message.startsWith("document not found:")
			) {
				throw new MemoryApplicationError(
					"DOCUMENT_NOT_FOUND",
					"Document not found",
					404,
				);
			}
			throw error;
		}
	}

	async getOperation(namespaceId: string, operationId: string) {
		const operation =
			await this.namespace(namespaceId).getOperation(operationId);
		if (!operation) {
			throw new MemoryApplicationError(
				"OPERATION_NOT_FOUND",
				"Operation not found",
				404,
			);
		}
		return operationView(operation);
	}

	async listOperations(namespaceId: string, limit = 100) {
		const operations = await this.namespace(namespaceId).listOperations(limit);
		return { results: operations.map(operationView) };
	}

	async getState(namespaceId: string, query: unknown) {
		const command = StateQuerySchema.parse(query);
		return this.namespace(namespaceId).getState(
			command.subject,
			command.attribute,
			{
				...scope(command),
				asOf: command.as_of ? new Date(command.as_of) : undefined,
			},
		);
	}

	async getStateHistory(namespaceId: string, query: unknown) {
		const command = StateQuerySchema.omit({ as_of: true }).parse(query);
		return this.namespace(namespaceId).getStateHistory(
			command.subject,
			command.attribute,
			scope(command),
		);
	}

	async getBeliefView(namespaceId: string, query: unknown) {
		const command = BeliefQuerySchema.parse(query);
		const applicability = command.applicability_kind
			? {
					kind: command.applicability_kind,
					...(command.applicability_key
						? { key: command.applicability_key }
						: {}),
				}
			: undefined;
		return this.namespace(namespaceId).getBeliefView(
			command.subject,
			command.attribute,
			{
				...scope(command),
				mode: command.view,
				...(applicability ? { applicability } : {}),
				...(command.at ? { at: new Date(command.at) } : {}),
				...(command.all_applicability ? { allApplicability: true } : {}),
			},
		);
	}

	async getProfile(namespaceId: string, query: unknown) {
		const command = ProfileQuerySchema.parse(query);
		const memory = this.namespace(namespaceId);
		if (command.query) {
			return memory.getProfileSections(command.query, scope(command), {
				limit: command.limit,
			});
		}
		return memory.getProfile(scope(command));
	}
}
