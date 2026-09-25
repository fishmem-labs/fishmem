import {
	MemoryApplication,
	MemoryApplicationError,
} from "@fishmem/application";
import {
	BatchDeleteMemoriesCommandSchema,
	BatchUpdateMemoriesCommandSchema,
} from "@fishmem/contracts";
import {
	type Embedder,
	type LLM,
	Memory,
	type MemoryItem,
	parseNamespaceSnapshot,
	SqliteVectorStore,
	createSqliteGraphStore,
} from "fishmem";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
	cosineFromVectorScore,
	isCurrentMemory,
	NEAR_DUPLICATE_COSINE,
	normalizedContentHash,
	optionalProject,
	PROJECT_FILTER_FIELD,
	PROJECT_METADATA_KEY,
	projectOf,
	sha256Hex as sha256HexSync,
	stableJson,
	SUGGESTION_GUIDANCE,
	suggestMemoryAction,
	visibleFromProject,
} from "./dedup";
import { LocalE5Embedder, type LocalEmbeddingState } from "./local-embedder";
import { MaintenanceScheduler } from "./maintenance-scheduler";
import { RequestScheduler } from "./request-scheduler";
import type {
	DesktopDuplicatePairs,
	DesktopErrorCode,
	DesktopMaintenanceResult,
	DesktopMemoryPage,
	DesktopMemoryRecord,
	DesktopMethod,
	DesktopRememberResult,
	DesktopSimilarMemory,
	DesktopSummary,
	DesktopSummaryMemory,
	DesktopStatus,
} from "../shared/protocol";

const NAMESPACE = "default";
const DEFAULT_AGENT_ID = "fishmem-desktop";

type RequestClass = "immediate" | "read" | "write" | "exclusive";

const REQUEST_CLASSES: Record<DesktopMethod, RequestClass> = {
	status: "immediate",
	summary: "immediate",
	retryEmbedding: "immediate",
	list: "read",
	search: "read",
	get: "read",
	history: "read",
	getFeedback: "read",
	entityList: "read",
	entityGet: "read",
	documentList: "read",
	documentSearch: "read",
	documentGet: "read",
	documentContent: "read",
	remember: "read",
	duplicates: "read",
	add: "write",
	update: "write",
	delete: "write",
	batchUpdate: "write",
	batchDelete: "write",
	setFeedback: "write",
	clearFeedback: "write",
	entityDelete: "write",
	documentIngest: "write",
	documentDelete: "write",
	// Serialized with writes so an export is a consistent point-in-time view.
	exportSnapshot: "write",
	invalidate: "write",
	supersede: "write",
	maintenance: "write",
	deleteAll: "exclusive",
	importSnapshot: "exclusive",
	restoreSnapshot: "exclusive",
};

type MemoryScopeInput = {
	userId?: string;
	agentId: string;
	runId?: string;
};

type SimilarityCheck = {
	exact?: DesktopSimilarMemory;
	similar: DesktopSimilarMemory[];
};

export interface LocalEmbeddingRuntime extends Embedder {
	readonly model: string;
	readonly state: LocalEmbeddingState;
	prepare(): Promise<void>;
}

export class DesktopMemoryService {
	private application?: MemoryApplication;
	private engine?: Memory;
	private vectorStore?: SqliteVectorStore;
	private localEmbedder?: LocalEmbeddingRuntime;
	private embeddingError?: string;
	private embeddingPreparation?: Promise<void>;
	private rebuildingIndex = false;
	private readonly scheduler = new RequestScheduler();
	/** false while a caller asked search not to count as a recall (UI browsing). */
	private maintenanceScheduler?: MaintenanceScheduler<DesktopMaintenanceResult>;

	constructor(
		private readonly databasePath: string,
		private readonly modelCachePath: string,
		private readonly socketPath: string,
		private readonly createLocalEmbedder: (
			cachePath: string,
		) => LocalEmbeddingRuntime = (cachePath) => new LocalE5Embedder(cachePath),
	) {}

	async initialize() {
		await this.createApplication();
	}

	async close() {
		this.maintenanceScheduler?.stop();
		this.maintenanceScheduler = undefined;
		// Let queued writes (including deferred access records) settle, but never
		// hold shutdown hostage to a stuck operation.
		await Promise.race([
			this.scheduler.flushWrites().catch(() => undefined),
			new Promise((resolve) => setTimeout(resolve, 5_000).unref?.()),
		]);
		await this.engine?.close();
		this.application = undefined;
		this.engine = undefined;
		this.vectorStore = undefined;
	}

	status(): DesktopStatus {
		const localState = this.localEmbedder?.state;
		const embeddingState = this.embeddingError
			? "error"
			: this.rebuildingIndex
				? "indexing"
				: (localState?.phase ?? "idle");
		return {
			configured: Boolean(this.application),
			embeddingState,
			...(localState?.phase === "downloading" &&
			localState.progress !== undefined
				? { embeddingProgress: localState.progress }
				: {}),
			...(embeddingState === "error"
				? {
						embeddingError:
							this.embeddingError ??
							(localState?.phase === "error"
								? localState.message
								: "Local embedding initialization failed"),
					}
				: {}),
			model: this.localEmbedder?.model,
			dimensions: this.localEmbedder?.dimensions,
			databasePath: this.databasePath,
			socketPath: this.socketPath,
		};
	}

	invoke(method: DesktopMethod, params?: unknown): Promise<unknown> {
		const requestClass = REQUEST_CLASSES[method];
		const run = () => this.dispatch(method, params);
		if (requestClass === "read") return this.scheduler.read(run);
		if (requestClass === "write") return this.scheduler.write(run);
		if (requestClass === "exclusive") return this.scheduler.exclusive(run);
		if (requestClass === "immediate") return Promise.resolve().then(run);
		return Promise.reject(new Error(`Unsupported desktop method: ${method}`));
	}

	/** Resolves when every write queued so far (including deferred access records) has settled. */
	flushWrites(): Promise<void> {
		return this.scheduler.flushWrites();
	}

	/**
	 * Schedule Desktop maintenance: once shortly after startup, then every 24
	 * hours. Passes are skipped while requests are in flight or before the
	 * local embedding runtime is ready.
	 */
	startMaintenance(
		options: {
			initialDelayMs?: number;
			intervalMs?: number;
			retryDelayMs?: number;
		} = {},
	) {
		this.maintenanceScheduler?.stop();
		this.maintenanceScheduler = new MaintenanceScheduler({
			...options,
			run: () =>
				this.invoke("maintenance") as Promise<DesktopMaintenanceResult>,
			isReady: () =>
				Boolean(this.application) && this.status().embeddingState === "ready",
			isBusy: () => this.scheduler.busy,
		});
		this.maintenanceScheduler.start();
		return this.maintenanceScheduler;
	}

	private async dispatch(
		method: DesktopMethod,
		params?: unknown,
	): Promise<unknown> {
		if (method === "status") return this.status();
		if (method === "summary") return this.summary();
		if (method === "retryEmbedding") return this.prepareLocalEmbedding();
		const application = this.requireApplication();
		const input = (params ?? {}) as Record<string, unknown>;
		if (method === "add") {
			this.requireLocalEmbeddingReady();
			return this.addMemory(application, input);
		}
		if (method === "remember") {
			this.requireLocalEmbeddingReady();
			return this.remember(input);
		}
		if (method === "invalidate") {
			return this.invalidate(input);
		}
		if (method === "supersede") {
			this.requireLocalEmbeddingReady();
			return this.supersede(application, input);
		}
		if (method === "duplicates") {
			return this.duplicates(input);
		}
		if (method === "maintenance") {
			return this.runMaintenancePass(application);
		}
		if (method === "search") {
			this.requireLocalEmbeddingReady();
			const searchInput = {
				query: String(input.query ?? ""),
				top_k: Number(input.top_k ?? input.limit ?? 10),
				user_id: input.user_id,
				agent_id: input.agent_id ?? DEFAULT_AGENT_ID,
				run_id: input.run_id,
				memory_type: input.memory_type,
				mode: input.mode,
				search_strategy: input.search_strategy,
				sort_by: input.sort_by,
				min_score: input.min_score,
				filters: searchFilters(input),
				trace: input.trace,
				...(input.record_access === false ? { track_access: false } : {}),
			};
			const result = normalizeSearchResult(
				await application.search(NAMESPACE, searchInput),
			);
			const minSimilarity =
				input.min_similarity === undefined
					? undefined
					: Number(input.min_similarity);
			if (
				minSimilarity !== undefined &&
				(!Number.isFinite(minSimilarity) ||
					minSimilarity < -1 ||
					minSimilarity > 1)
			) {
				throw new Error("min_similarity must be a number between -1 and 1");
			}
			if (minSimilarity === undefined && input.include_similarity !== true) {
				return result;
			}
			return {
				...result,
				results: await this.withQuerySimilarity(
					searchInput.query,
					result.results,
					minSimilarity,
				),
			};
		}
		if (method === "batchUpdate") {
			this.requireLocalEmbeddingReady();
			return runLocalMemoryBatch(application, "batch_update", input);
		}
		if (method === "batchDelete") {
			return runLocalMemoryBatch(application, "batch_delete", input);
		}
		if (method === "list") {
			const project = optionalProject(input.project);
			if (project && input.all_projects !== true) {
				return this.listProject(input, project);
			}
			const page = await application.list("default", {
				limit: Number(input.limit ?? 50),
				cursor: typeof input.cursor === "string" ? input.cursor : undefined,
				user_id: input.user_id as string | undefined,
				agent_id: (input.agent_id as string | undefined) ?? "fishmem-desktop",
				run_id: input.run_id as string | undefined,
			});
			return {
				results: page.results.map((memory) => desktopMemory(memory)),
				...(page.next_cursor ? { nextCursor: page.next_cursor } : {}),
			} satisfies DesktopMemoryPage;
		}
		if (method === "get") {
			return desktopMemory(
				await application.get("default", String(input.id ?? "")),
			);
		}
		if (method === "update") {
			this.requireLocalEmbeddingReady();
			return application.update(
				"default",
				String(input.id ?? ""),
				{
					content: input.content,
					metadata: await this.metadataKeepingProject(
						String(input.id ?? ""),
						input.metadata,
					),
					importance: input.importance,
					memory_type: input.memory_type,
					version: input.version,
				},
				typeof input.idempotency_key === "string" &&
					input.idempotency_key.trim()
					? input.idempotency_key
					: crypto.randomUUID(),
			);
		}
		if (method === "delete") {
			return application.delete(
				"default",
				String(input.id ?? ""),
				typeof input.idempotency_key === "string" &&
					input.idempotency_key.trim()
					? input.idempotency_key
					: crypto.randomUUID(),
			);
		}
		if (method === "deleteAll") {
			const engine = this.engine;
			if (!engine) throw new Error("FishMem local memory is unavailable");
			return engine.forNamespace("default").deleteAll(
				{
					userId: input.user_id as string | undefined,
					agentId: (input.agent_id as string | undefined) ?? "fishmem-desktop",
					runId: input.run_id as string | undefined,
				},
				{
					idempotencyKey:
						typeof input.idempotency_key === "string" &&
						input.idempotency_key.trim()
							? input.idempotency_key
							: undefined,
				},
			);
		}
		if (method === "history") {
			const entries = await application.history(
				"default",
				String(input.id ?? ""),
			);
			return {
				results: entries.map((entry) => ({
					id: entry.id,
					memory_id: entry.memoryId,
					event: entry.event,
					previous_value: entry.previousValue,
					new_value: entry.newValue,
					created_at: entry.createdAt.toISOString(),
				})),
			};
		}
		if (method === "getFeedback") {
			return application.getFeedback("default", String(input.id ?? ""));
		}
		if (method === "setFeedback") {
			return application.setFeedback(
				"default",
				String(input.id ?? ""),
				{
					rating: input.rating,
					reason: input.reason,
					request_id: input.request_id,
				},
				commandIdempotencyKey(input, "feedback"),
			);
		}
		if (method === "clearFeedback") {
			return application.clearFeedback(
				"default",
				String(input.id ?? ""),
				commandIdempotencyKey(input, "feedback-clear"),
			);
		}
		if (method === "entityList") {
			return application.listScopeEntities("default", {
				type: input.type,
				cursor: input.cursor,
				limit: input.limit ?? 50,
			});
		}
		if (method === "entityGet") {
			return application.getScopeEntity("default", input.type, input.id);
		}
		if (method === "entityDelete") {
			return application.deleteScopeEntity(
				"default",
				input.type,
				input.id,
				requiredCommandIdempotencyKey(input, "entities.delete"),
			);
		}
		if (method === "documentIngest") {
			this.requireLocalEmbeddingReady();
			return application.ingestDocument(
				"default",
				{
					source_key: input.source_key,
					content: input.content,
					title: input.title,
					mime_type: input.mime_type,
					source_uri: input.source_uri,
					metadata: input.metadata,
					...desktopScope(input),
				},
				commandIdempotencyKey(input, "document"),
			);
		}
		if (method === "documentList") {
			return application.listDocuments("default", {
				source_key: input.source_key,
				cursor: input.cursor,
				limit: input.limit ?? 50,
				...desktopScope(input),
			});
		}
		if (method === "documentSearch") {
			this.requireLocalEmbeddingReady();
			return application.searchDocuments("default", {
				query: input.query,
				limit: input.limit,
				neighbors: input.neighbors,
				source_key: input.source_key,
				...desktopScope(input),
			});
		}
		if (method === "documentGet") {
			return application.getDocument("default", String(input.id ?? ""));
		}
		if (method === "documentContent") {
			return application.getDocumentContent("default", String(input.id ?? ""));
		}
		if (method === "documentDelete") {
			return application.deleteDocument(
				"default",
				String(input.id ?? ""),
				commandIdempotencyKey(input, "document-delete"),
			);
		}
		if (method === "exportSnapshot") {
			const engine = this.requireEngine();
			return engine.forNamespace("default").exportSnapshot();
		}
		if (method === "importSnapshot") {
			this.requireLocalEmbeddingReady();
			const engine = this.requireEngine();
			const snapshot = input.snapshot;
			parseNamespaceSnapshot(snapshot, "default");
			return engine.forNamespace("default").importSnapshot(snapshot, {
				idempotencyKey: commandIdempotencyKey(input, "snapshot-import"),
			});
		}
		if (method === "restoreSnapshot") {
			if (input.confirm !== "RESTORE") {
				throw new Error('restoreSnapshot requires confirm: "RESTORE"');
			}
			this.requireLocalEmbeddingReady();
			return this.restoreSnapshot(input.snapshot);
		}
		throw new Error(`Unsupported desktop method: ${method}`);
	}

	/**
	 * Search records recall access with a direct UPDATE. Route those writes
	 * through the serialized write queue so concurrent reads stay read-only.
	 * UI browsing opts out with the engine's `track_access: false`.
	 */
	private deferAccessRecording(engine: Memory) {
		const store = engine.store;
		const recordAccess = store.recordAccess.bind(store);
		store.recordAccess = (id: string) => {
			void this.scheduler
				.write(() => recordAccess(id))
				.catch((error: unknown) => {
					console.warn(
						"FishMem could not record memory access:",
						error instanceof Error ? error.message : String(error),
					);
				});
			return Promise.resolve();
		};
	}

	/**
	 * Attach the cosine similarity between the query and each hit's stored
	 * local embedding. Hybrid search scores are rank-fusion values, so this is
	 * the meaningful relevance gate for automatic recall.
	 */
	private async withQuerySimilarity(
		query: string,
		results: DesktopMemoryRecord[],
		minSimilarity: number | undefined,
	) {
		if (results.length === 0) return results;
		const engine = this.requireEngine();
		const embedder = this.localEmbedder;
		if (!embedder) return results;
		const queryVector = await embedder.embed(query, {
			context: { namespaceId: NAMESPACE, operation: "memory.search.similarity" },
		});
		const scored: DesktopMemoryRecord[] = [];
		for (const record of results) {
			const stored = await engine.vectors.get(record.id);
			const similarity = stored ? cosine(queryVector, stored.vector) : undefined;
			if (
				minSimilarity !== undefined &&
				(similarity === undefined || similarity < minSimilarity)
			) {
				continue;
			}
			scored.push(
				similarity === undefined
					? record
					: { ...record, similarity: Math.round(similarity * 10_000) / 10_000 },
			);
		}
		return scored;
	}

	/**
	 * Metadata replacement must not silently move a memory out of its project;
	 * keep the existing project unless the caller sets one explicitly.
	 */
	private async metadataKeepingProject(id: string, metadata: unknown) {
		if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
			return metadata;
		}
		if (PROJECT_METADATA_KEY in metadata) return metadata;
		const existing = await this.requireEngine().store.getMemory(id);
		const project = existing ? projectOf(existing) : undefined;
		return project
			? { ...(metadata as Record<string, unknown>), [PROJECT_METADATA_KEY]: project }
			: metadata;
	}

	private async addMemory(
		application: MemoryApplication,
		input: Record<string, unknown>,
	) {
		const content = String(input.content ?? "");
		const project = optionalProject(input.project);
		const scope = memoryScope(input);
		const metadata = withProject(
			input.metadata as Record<string, unknown> | undefined,
			project,
		);
		if (input.force !== true && content.trim()) {
			const check = await this.checkSimilar(content, scope, project, 5);
			if (check.exact) {
				return {
					results: [
						{
							id: check.exact.id,
							memory: check.exact.content,
							event: "NONE",
						},
					],
					deduplicated: true,
					duplicate_of: check.exact.id,
				};
			}
			const near = check.similar.filter(
				(candidate) => candidate.similarity >= NEAR_DUPLICATE_COSINE,
			);
			if (input.check_similar === true && near.length > 0) {
				return {
					results: [],
					deduplicated: false,
					needs_review: true,
					similar: near,
					suggested_action: "review",
					guidance: SUGGESTION_GUIDANCE.review,
				};
			}
		}
		const command = {
			content,
			user_id: scope.userId,
			agent_id: scope.agentId,
			run_id: scope.runId,
			infer: false,
			event_date: input.event_date,
			metadata,
		};
		const explicitKey =
			typeof input.idempotency_key === "string" && input.idempotency_key.trim()
				? input.idempotency_key
				: undefined;
		// A retried identical request replays the committed add instead of
		// writing a second copy.
		const derivedKey = `desktop-add:${sha256HexSync(stableJson(command))}`;
		const result = await application.add(
			NAMESPACE,
			command,
			explicitKey ?? derivedKey,
		);
		if (!explicitKey && !(await this.addResultIsLive(result))) {
			// The replayed record was since deleted or invalidated; this is a new
			// assertion of the same content, so write it under a fresh key.
			return application.add(
				NAMESPACE,
				command,
				`${derivedKey}:${crypto.randomUUID()}`,
			);
		}
		return result;
	}

	private async addResultIsLive(result: { results: Array<{ id: string }> }) {
		const engine = this.requireEngine();
		for (const item of result.results) {
			const memory = await engine.store.getMemory(item.id);
			if (!memory || !isCurrentMemory(memory)) return false;
		}
		return true;
	}

	/**
	 * Find existing current memories similar to `content` inside the scope the
	 * write would be visible from: a project write checks that project plus
	 * global memories; a global write checks global memories only.
	 */
	private async checkSimilar(
		content: string,
		scope: MemoryScopeInput,
		project: string | undefined,
		limit: number,
	): Promise<SimilarityCheck> {
		const engine = this.requireEngine();
		const embedder = this.localEmbedder;
		if (!embedder) {
			throw new DesktopServiceError(
				"LOCAL_EMBEDDING_UNAVAILABLE",
				"FishMem local embedding runtime is unavailable",
			);
		}
		const vector = await embedder.embed(content, {
			context: { namespaceId: NAMESPACE, operation: "memory.add.dedupe" },
		});
		const hits = await engine.vectors.search(vector, Math.max(limit * 4, 20), {
			namespaceId: NAMESPACE,
			recordKind: "memory",
			agentId: scope.agentId,
		});
		const hash = normalizedContentHash(content);
		const similar: DesktopSimilarMemory[] = [];
		let exact: DesktopSimilarMemory | undefined;
		for (const hit of hits) {
			const memory = await engine.store.getMemory(hit.id);
			if (
				!memory ||
				memory.namespaceId !== NAMESPACE ||
				!isCurrentMemory(memory) ||
				!sameStructuralScope(memory, scope) ||
				!visibleFromProject(memory, project)
			) {
				continue;
			}
			const candidate = similarMemory(
				memory,
				cosineFromVectorScore(hit.score),
			);
			if (!exact && normalizedContentHash(memory.content) === hash) {
				exact = { ...candidate, exact: true };
				similar.push(exact);
			} else {
				similar.push(candidate);
			}
		}
		similar.sort((left, right) => right.similarity - left.similarity);
		return { exact, similar: similar.slice(0, limit) };
	}

	private async remember(
		input: Record<string, unknown>,
	): Promise<DesktopRememberResult> {
		const content = String(input.content ?? "").trim();
		if (!content) throw new Error("remember requires content");
		const project = optionalProject(input.project);
		const limit = Math.min(Math.max(Number(input.limit ?? 5) || 5, 1), 20);
		const check = await this.checkSimilar(
			content,
			memoryScope(input),
			project,
			limit,
		);
		const action = suggestMemoryAction({
			exact: Boolean(check.exact),
			topSimilarity: check.similar[0]?.similarity,
		});
		return {
			content,
			scope: project ? "project" : "global",
			...(project ? { project } : {}),
			exact_duplicate: check.exact ?? null,
			similar: check.similar,
			suggested_action: action,
			guidance: SUGGESTION_GUIDANCE[action],
		};
	}

	private async invalidate(input: Record<string, unknown>) {
		const id = String(input.id ?? "");
		const supersededBy =
			typeof input.superseded_by === "string" && input.superseded_by.trim()
				? input.superseded_by.trim()
				: undefined;
		const validTo =
			typeof input.valid_to === "string" ? new Date(input.valid_to) : undefined;
		if (validTo && Number.isNaN(validTo.getTime())) {
			throw new Error("valid_to must be an ISO date");
		}
		const invalidated = await this.requireEngine()
			.forNamespace(NAMESPACE)
			.invalidate(id, {
				...(supersededBy ? { supersededBy } : {}),
				...(validTo ? { validTo } : {}),
				idempotencyKey: commandIdempotencyKey(input, "invalidate"),
			});
		if (!invalidated) {
			throw new MemoryApplicationError(
				"MEMORY_NOT_FOUND",
				"Memory not found",
				404,
			);
		}
		return {
			id,
			invalidated: true,
			...(supersededBy ? { superseded_by: supersededBy } : {}),
		};
	}

	/** Store a replacement fact and invalidate the outdated one it supersedes. */
	private async supersede(
		application: MemoryApplication,
		input: Record<string, unknown>,
	) {
		const engine = this.requireEngine();
		const id = String(input.id ?? "");
		const content = String(input.content ?? "");
		const previous = await engine.store.getMemory(id);
		if (
			!previous ||
			previous.namespaceId !== NAMESPACE ||
			!isCurrentMemory(previous)
		) {
			throw new MemoryApplicationError(
				"MEMORY_NOT_FOUND",
				"Memory not found or already superseded",
				404,
			);
		}
		const project =
			input.project !== undefined
				? optionalProject(input.project)
				: projectOf(previous);
		const metadata = withProject(
			{
				...stripProject(previous.metadata),
				...((input.metadata as Record<string, unknown> | undefined) ?? {}),
			},
			project,
		);
		const command = {
			content,
			user_id: previous.userId,
			agent_id: previous.agentId ?? DEFAULT_AGENT_ID,
			run_id: previous.runId,
			infer: false,
			metadata,
		};
		const added = await application.add(
			NAMESPACE,
			command,
			`desktop-supersede:${id}:${sha256HexSync(stableJson(command))}`,
		);
		const successor = added.results[0]?.id;
		if (!successor) throw new Error("FishMem could not store the replacement");
		await engine.forNamespace(NAMESPACE).invalidate(id, {
			supersededBy: successor,
			idempotencyKey: `desktop-supersede-invalidate:${id}:${successor}`,
		});
		return {
			results: added.results,
			superseded: id,
			superseded_by: successor,
		};
	}

	private async listProject(input: Record<string, unknown>, project: string) {
		const limit = Math.min(Math.max(Number(input.limit ?? 50) || 50, 1), 100);
		const result = await this.requireEngine()
			.forNamespace(NAMESPACE)
			.getAll({
				userId: input.user_id as string | undefined,
				agentId: (input.agent_id as string | undefined) ?? DEFAULT_AGENT_ID,
				runId: input.run_id as string | undefined,
				cursor: decodeListCursor(input.cursor),
				limit: limit + 1,
				sort: "recent",
				filter: projectPredicate(project),
			});
		const items = result.results.slice(0, limit);
		const last = items.at(-1);
		return {
			results: items.map((memory) => desktopMemory(memory)),
			...(result.results.length > limit && last
				? { nextCursor: encodeListCursor(last.createdAt, last.id) }
				: {}),
		} satisfies DesktopMemoryPage;
	}

	/**
	 * Near-duplicate pairs for agent-side consolidation. Desktop does not merge
	 * them itself; the host agent decides which to keep, update, or invalidate.
	 */
	private async duplicates(
		input: Record<string, unknown>,
	): Promise<DesktopDuplicatePairs> {
		const engine = this.requireEngine();
		const project = optionalProject(input.project);
		const allProjects = input.all_projects === true;
		const threshold = Math.min(
			Math.max(Number(input.threshold ?? NEAR_DUPLICATE_COSINE), 0),
			1,
		);
		const limit = Math.min(Math.max(Number(input.limit ?? 200) || 200, 1), 1000);
		const agentId = (input.agent_id as string | undefined) ?? DEFAULT_AGENT_ID;
		const { results: memories } = await engine.forNamespace(NAMESPACE).getAll({
			agentId,
			limit,
			sort: "recent",
			...(project && !allProjects
				? { filter: projectPredicate(project) }
				: {}),
		});
		const inScope = new Map(
			memories.filter(isCurrentMemory).map((memory) => [memory.id, memory]),
		);
		const seen = new Set<string>();
		const pairs: DesktopDuplicatePairs["pairs"] = [];
		for (const memory of inScope.values()) {
			const record = await engine.vectors.get(memory.id);
			if (!record) continue;
			const hits = await engine.vectors.search(record.vector, 8, {
				namespaceId: NAMESPACE,
				recordKind: "memory",
				agentId,
			});
			for (const hit of hits) {
				if (hit.id === memory.id) continue;
				const other = inScope.get(hit.id);
				if (!other) continue;
				const key = [memory.id, other.id].sort().join("\0");
				if (seen.has(key)) continue;
				const similarity = cosineFromVectorScore(hit.score);
				if (similarity < threshold) continue;
				seen.add(key);
				pairs.push({
					similarity,
					exact:
						normalizedContentHash(memory.content) ===
						normalizedContentHash(other.content),
					memories: [similarMemory(memory, 1), similarMemory(other, 1)].map(
						({ similarity: _similarity, ...rest }) => rest,
					),
				});
			}
		}
		pairs.sort((left, right) => right.similarity - left.similarity);
		return {
			threshold,
			scanned: inScope.size,
			pairs: pairs.slice(0, 100),
		};
	}

	/**
	 * Desktop maintenance pass. It removes exact (normalized) duplicates that
	 * share the same structural scope and project, keeping the oldest record,
	 * through the journaled delete path so history records every removal.
	 *
	 * The engine's decay/consolidate/prune pass is intentionally not run here:
	 * prune hard-deletes memories the user explicitly asked to keep, decay
	 * rewrites `updatedAt` (the optimistic-concurrency version) on every pass,
	 * and consolidation concatenates contents without an operation journal or
	 * history entry. Semantic consolidation is delegated to the host agent via
	 * `fishmem duplicates`.
	 */
	private async runMaintenancePass(
		application: MemoryApplication,
	): Promise<DesktopMaintenanceResult> {
		const engine = this.requireEngine();
		const startedAt = new Date();
		const memories = (
			await engine.store.listMemories(
				{ namespaceId: NAMESPACE },
				{ limit: 1_000_000 },
			)
		).filter(isCurrentMemory);
		const groups = new Map<string, typeof memories>();
		for (const memory of memories) {
			const key = stableJson([
				memory.userId ?? null,
				memory.agentId ?? null,
				memory.runId ?? null,
				projectOf(memory) ?? null,
				normalizedContentHash(memory.content),
			]);
			const group = groups.get(key);
			if (group) group.push(memory);
			else groups.set(key, [memory]);
		}
		const removed: string[] = [];
		for (const group of groups.values()) {
			if (group.length < 2) continue;
			group.sort(
				(left, right) =>
					left.createdAt.getTime() - right.createdAt.getTime() ||
					left.id.localeCompare(right.id),
			);
			for (const duplicate of group.slice(1)) {
				await application.delete(
					NAMESPACE,
					duplicate.id,
					`desktop-maintenance-dedupe:${duplicate.id}`,
				);
				removed.push(duplicate.id);
			}
		}
		return {
			started_at: startedAt.toISOString(),
			finished_at: new Date().toISOString(),
			scanned: memories.length,
			exact_duplicates_removed: removed.length,
			removed_ids: removed,
		};
	}

	private async restoreSnapshot(snapshot: unknown) {
		const engine = this.requireEngine();
		const namespace = engine.forNamespace("default");
		// Validate the complete portable format before touching current data.
		parseNamespaceSnapshot(snapshot, "default");
		const previous = await namespace.exportSnapshot();
		await namespace.purgeAll();
		try {
			return await namespace.importSnapshot(snapshot, {
				idempotencyKey: `desktop-restore-${crypto.randomUUID()}`,
			});
		} catch (cause) {
			try {
				await namespace.purgeAll();
				await namespace.importSnapshot(previous, {
					idempotencyKey: `desktop-rollback-${crypto.randomUUID()}`,
				});
			} catch (rollbackCause) {
				throw new AggregateError(
					[cause, rollbackCause],
					"FishMem could not restore the selected backup or roll back the current library",
				);
			}
			throw cause;
		}
	}

	private async summary(): Promise<DesktopSummary> {
		if (!this.engine) {
			throw new Error("FishMem local memory is unavailable");
		}
		const startOfToday = new Date();
		startOfToday.setHours(0, 0, 0, 0);
		const scope = { namespaceId: "default" };
		const recalledScope = {
			...scope,
			accessed: true,
		} as const;
		const [
			totalMemories,
			rememberedToday,
			recalledToday,
			recentRemembered,
			recentRecalled,
		] = await Promise.all([
			this.engine.store.countMemories(scope),
			this.engine.store.countMemories({
				...scope,
				createdAtFrom: startOfToday,
			}),
			this.engine.store.countMemories({
				...recalledScope,
				lastAccessedAtFrom: startOfToday,
			}),
			this.engine.store.listMemories(scope, {
				sort: "recent",
				limit: 3,
			}),
			this.engine.store.listMemories(recalledScope, {
				sort: "last_accessed",
				limit: 3,
			}),
		]);
		return {
			totalMemories,
			rememberedToday,
			recalledToday,
			recentRemembered: recentRemembered.map(summaryMemory),
			recentRecalled: recentRecalled.map(summaryMemory),
		};
	}

	private async createApplication() {
		await this.engine?.close();
		this.application = undefined;
		this.embeddingError = undefined;
		this.rebuildingIndex = false;
		await mkdir(dirname(this.databasePath), { recursive: true });
		const url = `file:${this.databasePath}`;
		await enableWriteAheadLog(url);
		const embedder = this.createLocalEmbedder(this.modelCachePath);
		this.localEmbedder = embedder;
		const vectorStore = new SqliteVectorStore({
			url,
			indexIdentity: `local:${embedder.model}:q8`,
		});
		const engine = new Memory(
			{
				embedder,
				graphStore: await createSqliteGraphStore({ url }),
				vectorStore,
				llm: DISABLED_LLM,
			},
			{
				derivation: { enabled: false },
			},
		);
		await engine.init();
		this.deferAccessRecording(engine);
		this.vectorStore = engine.vectors as SqliteVectorStore;
		this.engine = engine;
		this.application = new MemoryApplication(engine);
		void this.prepareLocalEmbedding().catch((error: unknown) => {
			console.error(
				"FishMem local embedding initialization failed:",
				error instanceof Error ? error.message : String(error),
			);
		});
	}

	private async prepareLocalEmbedding(): Promise<DesktopStatus> {
		if (!this.embeddingPreparation) {
			const embedder = this.localEmbedder;
			const vectorStore = this.vectorStore;
			const engine = this.engine;
			if (!embedder || !vectorStore || !engine) {
				throw new DesktopServiceError(
					"LOCAL_EMBEDDING_UNAVAILABLE",
					"FishMem local embedding runtime is unavailable",
				);
			}
			this.embeddingError = undefined;
			const preparation = (async () => {
				await embedder.prepare();
				if (vectorStore.requiresRebuild) {
					this.rebuildingIndex = true;
					try {
						await engine.rebuildProjections({ namespaceId: "default" });
					} finally {
						this.rebuildingIndex = false;
					}
				}
			})();
			this.embeddingPreparation = preparation;
			const clearPreparation = () => {
				if (this.embeddingPreparation === preparation) {
					this.embeddingPreparation = undefined;
				}
			};
			void preparation.then(clearPreparation, clearPreparation);
		}
		try {
			await this.embeddingPreparation;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.embeddingError = message;
			throw new DesktopServiceError(
				"LOCAL_EMBEDDING_UNAVAILABLE",
				`Local embedding initialization failed: ${message}`,
			);
		}
		return this.status();
	}

	private requireLocalEmbeddingReady() {
		const status = this.status();
		if (status.embeddingState === "ready") return;
		if (status.embeddingState === "error") {
			throw new DesktopServiceError(
				"LOCAL_EMBEDDING_UNAVAILABLE",
				`${status.embeddingError ?? "Local embedding is unavailable"}. Retry from Settings or restart FishMem.`,
			);
		}
		throw new DesktopServiceError(
			"LOCAL_EMBEDDING_NOT_READY",
			status.embeddingState === "indexing"
				? "FishMem is rebuilding the local semantic index. Try again when indexing is complete."
				: "FishMem is downloading the local multilingual embedding model. Try again when the model is ready.",
		);
	}

	private requireApplication() {
		if (!this.application) {
			throw new Error("FishMem local memory is unavailable");
		}
		return this.application;
	}

	private requireEngine() {
		if (!this.engine) {
			throw new Error("FishMem local memory is unavailable");
		}
		return this.engine;
	}
}

export class DesktopServiceError extends Error {
	constructor(
		readonly code: DesktopErrorCode,
		message: string,
	) {
		super(message);
		this.name = "DesktopServiceError";
	}
}

function summaryMemory(memory: MemoryItem): DesktopSummaryMemory {
	const client = memory.metadata?.fishmemClient;
	return {
		id: memory.id,
		content: memory.content,
		...(typeof client === "string" && client.trim()
			? { source: client.trim() }
			: {}),
		createdAt: memory.createdAt.toISOString(),
		lastAccessedAt: memory.lastAccessedAt.toISOString(),
		accessCount: memory.accessCount,
	};
}

function desktopMemory(
	memory: MemoryItem,
	score?: number,
): DesktopMemoryRecord {
	return {
		id: memory.id,
		content: memory.content,
		memoryType: memory.memoryType,
		importance: memory.importance,
		...(memory.userId ? { userId: memory.userId } : {}),
		...(memory.agentId ? { agentId: memory.agentId } : {}),
		...(memory.runId ? { runId: memory.runId } : {}),
		...(memory.source ? { source: memory.source } : {}),
		...(memory.metadata ? { metadata: memory.metadata } : {}),
		createdAt: memory.createdAt.toISOString(),
		updatedAt: memory.updatedAt.toISOString(),
		...(memory.eventDate ? { eventDate: memory.eventDate.toISOString() } : {}),
		...(memory.validFrom ? { validFrom: memory.validFrom.toISOString() } : {}),
		...(memory.validTo ? { validTo: memory.validTo.toISOString() } : {}),
		...(memory.subject ? { subject: memory.subject } : {}),
		...(memory.attribute ? { attribute: memory.attribute } : {}),
		...(memory.supersededBy ? { supersededBy: memory.supersededBy } : {}),
		lastAccessedAt: memory.lastAccessedAt.toISOString(),
		accessCount: memory.accessCount,
		...(score !== undefined ? { score } : {}),
	};
}

function cosine(left: number[], right: number[]) {
	let dot = 0;
	let leftNorm = 0;
	let rightNorm = 0;
	const length = Math.min(left.length, right.length);
	for (let index = 0; index < length; index++) {
		const a = left[index] ?? 0;
		const b = right[index] ?? 0;
		dot += a * b;
		leftNorm += a * a;
		rightNorm += b * b;
	}
	return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

async function enableWriteAheadLog(url: string) {
	// WAL lets reads proceed while a long write transaction (document ingest)
	// is open. The journal mode is persistent in the database file.
	try {
		const { createClient } = await import("@libsql/client");
		const client = createClient({ url });
		try {
			await client.execute("PRAGMA journal_mode=WAL");
		} finally {
			client.close();
		}
	} catch (error) {
		console.warn(
			"FishMem could not enable SQLite WAL mode:",
			error instanceof Error ? error.message : String(error),
		);
	}
}

function memoryScope(input: Record<string, unknown>): MemoryScopeInput {
	return {
		...(typeof input.user_id === "string" ? { userId: input.user_id } : {}),
		agentId:
			typeof input.agent_id === "string" ? input.agent_id : DEFAULT_AGENT_ID,
		...(typeof input.run_id === "string" ? { runId: input.run_id } : {}),
	};
}

function sameStructuralScope(
	memory: { userId?: string; agentId?: string; runId?: string },
	scope: MemoryScopeInput,
) {
	return (
		(memory.userId ?? undefined) === scope.userId &&
		(memory.agentId ?? undefined) === scope.agentId &&
		(memory.runId ?? undefined) === scope.runId
	);
}

function stripProject(metadata?: Record<string, unknown>) {
	if (!metadata) return {};
	const { [PROJECT_METADATA_KEY]: _project, ...rest } = metadata;
	return rest;
}

function withProject(
	metadata: Record<string, unknown> | undefined,
	project: string | undefined,
): Record<string, unknown> | undefined {
	if (!project) return metadata;
	return { ...(metadata ?? {}), [PROJECT_METADATA_KEY]: project };
}

function similarMemory(
	memory: MemoryItem,
	similarity: number,
): DesktopSimilarMemory {
	const project = projectOf(memory);
	return {
		id: memory.id,
		content: memory.content,
		similarity: Math.round(similarity * 10_000) / 10_000,
		scope: project ? "project" : "global",
		...(project ? { project } : {}),
		memoryType: memory.memoryType,
		createdAt: memory.createdAt.toISOString(),
		updatedAt: memory.updatedAt.toISOString(),
	};
}

/** Engine-form predicate: memories of `project` plus global (unscoped) ones. */
function projectPredicate(project: string) {
	return {
		kind: "or" as const,
		conditions: [
			{
				kind: "condition" as const,
				field: PROJECT_FILTER_FIELD as `metadata.${string}`,
				operator: "eq" as const,
				value: project,
			},
			{
				kind: "condition" as const,
				field: PROJECT_FILTER_FIELD as `metadata.${string}`,
				operator: "exists" as const,
				value: false,
			},
		],
	};
}

/**
 * Wire-form search filters. Adds the project scope (project + global) and a
 * `since` lower bound on created_at, ANDed with any caller-provided filters.
 * Without project/since the caller's filters pass through unchanged.
 */
export function searchFilters(input: Record<string, unknown>): unknown {
	const conditions: unknown[] = [];
	const project = optionalProject(input.project);
	if (project && input.all_projects !== true) {
		conditions.push({
			or: [
				{ field: PROJECT_FILTER_FIELD, operator: "eq", value: project },
				{ field: PROJECT_FILTER_FIELD, operator: "exists", value: false },
			],
		});
	}
	if (input.since !== undefined) {
		const since = new Date(String(input.since));
		if (Number.isNaN(since.getTime())) {
			throw new Error("since must be an ISO date");
		}
		conditions.push({
			field: "created_at",
			operator: "gte",
			value: since.toISOString(),
		});
	}
	if (conditions.length === 0) return input.filters;
	const filters = input.filters as Record<string, unknown> | undefined;
	if (filters) {
		if ("field" in filters || "and" in filters || "or" in filters || "not" in filters) {
			conditions.push(filters);
		} else {
			for (const [key, value] of Object.entries(filters)) {
				if (value !== null && typeof value === "object") {
					throw new Error(
						"Combine project/since with an advanced filter expression instead of operator-style metadata filters",
					);
				}
				conditions.push({ field: `metadata.${key}`, operator: "eq", value });
			}
		}
	}
	return conditions.length === 1 ? conditions[0] : { and: conditions };
}

function encodeListCursor(createdAt: Date, id: string): string {
	return btoa(`${createdAt.toISOString()}\0${id}`);
}

function decodeListCursor(
	cursor: unknown,
): { createdAt: Date; id: string } | undefined {
	if (typeof cursor !== "string" || !cursor) return undefined;
	const [createdAt, id] = atob(cursor).split("\0", 2);
	const date = new Date(createdAt ?? "");
	if (!id || Number.isNaN(date.getTime())) throw new Error("Invalid cursor");
	return { createdAt: date, id };
}

const DISABLED_LLM: LLM = {
	async chat() {
		throw new Error(
			"FishMem Desktop does not run an LLM; Codex or Claude Code must provide distilled memory content",
		);
	},
};

function normalizeSearchResult(result: unknown) {
	const value = result as {
		results?: Array<{
			memory?: MemoryItem;
			score?: number;
		}>;
		beliefs?: Array<{
			subject: string;
			attribute: string;
			entries: Array<{
				id: string;
				content: string;
				eventDate?: Date;
				validFrom?: Date;
				validTo?: Date;
				current: boolean;
			}>;
		}>;
		trace?: {
			lists: {
				vector: Array<{ id: string; score: number }>;
				fts: Array<{ id: string; score: number }>;
				graph: Array<{ id: string; score: number }>;
				temporal: Array<{ id: string; score: number }>;
			};
			fused: Array<{ id: string; score: number }>;
			selected: string[];
			selectedItems: Array<{ id: string; content: string }>;
		};
	};
	return {
		results: (value.results ?? []).flatMap((hit) =>
			hit.memory ? [desktopMemory(hit.memory, hit.score)] : [],
		),
		...(value.beliefs
			? {
					beliefs: value.beliefs.map((belief) => ({
						subject: belief.subject,
						attribute: belief.attribute,
						entries: belief.entries.map((entry) => ({
							id: entry.id,
							content: entry.content,
							event_date: entry.eventDate?.toISOString() ?? null,
							valid_from: entry.validFrom?.toISOString() ?? null,
							valid_to: entry.validTo?.toISOString() ?? null,
							current: entry.current,
						})),
					})),
				}
			: {}),
		...(value.trace
			? {
					trace: {
						lists: value.trace.lists,
						fused: value.trace.fused,
						selected: value.trace.selected,
						selected_items: value.trace.selectedItems,
					},
				}
			: {}),
	};
}

function desktopScope(input: Record<string, unknown>) {
	return {
		user_id: input.user_id,
		agent_id: input.agent_id ?? DEFAULT_AGENT_ID,
		run_id: input.run_id,
	};
}

function commandIdempotencyKey(input: Record<string, unknown>, prefix: string) {
	return typeof input.idempotency_key === "string" &&
		input.idempotency_key.trim()
		? input.idempotency_key
		: `${prefix}:${crypto.randomUUID()}`;
}

function requiredBatchIdempotencyKey(input: Record<string, unknown>) {
	return requiredCommandIdempotencyKey(input, "Desktop batch mutations");
}

function requiredCommandIdempotencyKey(
	input: Record<string, unknown>,
	operation: string,
) {
	const key =
		typeof input.idempotency_key === "string"
			? input.idempotency_key.trim()
			: "";
	if (!key || key.length > 200) {
		throw new Error(
			`${operation} requires idempotency_key with 1 to 200 characters`,
		);
	}
	return key;
}

async function sha256Hex(value: string) {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

async function runLocalMemoryBatch(
	application: MemoryApplication,
	kind: "batch_update" | "batch_delete",
	input: Record<string, unknown>,
) {
	const idempotencyKey = requiredBatchIdempotencyKey(input);
	const command =
		kind === "batch_update"
			? BatchUpdateMemoriesCommandSchema.parse(input)
			: BatchDeleteMemoriesCommandSchema.parse(input);
	const identity = await sha256Hex(`${kind}\0${idempotencyKey}`);
	const createdAt = new Date();
	const items: Array<Record<string, unknown>> = [];
	for (const [index, item] of command.memories.entries()) {
		const childKey = `batch:${kind}:${identity}:${index}`;
		try {
			if (kind === "batch_update") {
				const update = item as {
					memory_id: string;
					content?: string;
					metadata?: Record<string, unknown>;
					importance?: number;
					memory_type?: string;
					version?: string;
				};
				await application.update(
					"default",
					update.memory_id,
					{
						content: update.content,
						metadata: update.metadata,
						importance: update.importance,
						memory_type: update.memory_type,
						version: update.version,
					},
					childKey,
				);
				items.push({
					memory_id: update.memory_id,
					status: "succeeded",
					event: "UPDATE",
				});
			} else {
				await application.delete("default", item.memory_id, childKey);
				items.push({
					memory_id: item.memory_id,
					status: "succeeded",
					event: "DELETE",
				});
			}
		} catch (error) {
			if (!(error instanceof MemoryApplicationError) || error.status >= 500) {
				throw error;
			}
			items.push({
				memory_id: item.memory_id,
				status: "failed",
				error: { code: error.code, message: error.message },
			});
		}
	}
	const succeeded = items.filter((item) => item.status === "succeeded").length;
	const updatedAt = new Date();
	return {
		id: `desktop_batch_${identity.slice(0, 32)}`,
		kind,
		status: "success",
		attempts: 1,
		max_attempts: 1,
		error: null,
		next_attempt_at: null,
		result: {
			total: command.memories.length,
			processed: command.memories.length,
			succeeded,
			failed: items.length - succeeded,
			items,
		},
		created_at: createdAt.toISOString(),
		updated_at: updatedAt.toISOString(),
	};
}
