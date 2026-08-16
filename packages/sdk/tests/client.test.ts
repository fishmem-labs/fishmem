import { describe, expect, it, vi } from "vitest";
import { FishMem } from "../src/index.js";

function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("FishMem universal client", () => {
	it("adds authorization, JSON, and idempotency headers", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
			json(
				{
					message: "Memory inference accepted",
					status: "PENDING",
					event_id: "task_infer",
				},
				202,
			),
		);
		const client = new FishMem({
			apiKey: "fm_test",
			baseUrl: "https://memory.example/",
			fetch,
		});

		await client.memories.add(
			{
				content: "The user likes red",
				user_id: "alex",
				event_date: "2026-07-01T00:00:00.000Z",
			},
			{ idempotencyKey: "remember-red-v1" },
		);

		const [url, init] = fetch.mock.calls[0]!;
		expect(String(url)).toBe("https://memory.example/v1/memories");
		expect(new Headers(init?.headers).get("Authorization")).toBe(
			"Bearer fm_test",
		);
		expect(new Headers(init?.headers).get("Idempotency-Key")).toBe(
			"remember-red-v1",
		);
		expect(JSON.parse(String(init?.body))).toMatchObject({
			content: "The user likes red",
			user_id: "alex",
			event_date: "2026-07-01T00:00:00.000Z",
		});
		expect(() =>
			client.memories.add(
				{
					content: "Missing retry identity",
					user_id: "alex",
				},
				{ idempotencyKey: " " },
			),
		).toThrow("memories.add requires a non-empty idempotencyKey");
	});

	it("waits for async inference through the Event API", async () => {
		const now = "2026-07-31T00:00:00.000Z";
		const pending = {
			id: "task_infer",
			event_type: "ADD",
			status: "RUNNING",
			scope: { user_id: "alex" },
			results: [],
			write_summary: null,
			attempts: 1,
			max_attempts: 5,
			error: null,
			created_at: now,
			updated_at: now,
			started_at: now,
			completed_at: null,
			latency_ms: null,
		};
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(
				json(
					{
						message: "Memory inference accepted",
						status: "PENDING",
						event_id: "task_infer",
					},
					202,
				),
			)
			.mockResolvedValueOnce(json(pending))
			.mockResolvedValueOnce(
				json({
					...pending,
					status: "SUCCEEDED",
					results: [{ id: "m1", memory: "Likes red", event: "ADD" }],
					write_summary: {
						outcome: "STORED",
						planned: 1,
						persisted: 1,
						failed: 0,
					},
					completed_at: now,
					latency_ms: 15,
				}),
			);
		const client = new FishMem({ apiKey: "fm_test", fetch });

		await expect(
			client.memories.addAndWait(
				{ content: "The user likes red", user_id: "alex" },
				{
					idempotencyKey: "remember-red-v2",
					intervalMs: 0,
					timeoutMs: 100,
				},
			),
		).resolves.toEqual({
			results: [{ id: "m1", memory: "Likes red", event: "ADD" }],
		});
		expect(String(fetch.mock.calls[1]?.[0])).toBe(
			"https://fishmem.com/v1/events/task_infer",
		);
		expect(fetch).toHaveBeenCalledTimes(3);
	});

	it("uses URLSearchParams-compatible list filters", async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValue(json({ results: [], next_cursor: null }));
		const client = new FishMem({ apiKey: "fm_test", fetch });

		await client.memories.list({
			user_id: "alex",
			limit: 25,
			cursor: "next page",
		});

		expect(String(fetch.mock.calls[0]?.[0])).toBe(
			"https://fishmem.com/v1/memories?user_id=alex&limit=25&cursor=next+page",
		);
	});

	it("sends typed retrieval controls in the search body", async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValue(json({ results: [] }));
		const client = new FishMem({
			apiKey: "fm_test",
			baseUrl: "https://memory.example",
			fetch,
		});

		await client.memories.search({
			query: "deployment",
			user_id: "ada",
			top_k: 7,
			memory_type: "decision",
			mode: "hybrid",
			search_strategy: "precision",
			sort_by: "importance",
			min_score: 0.2,
			filters: { environment: "production", active: true },
			trace: true,
		});

		const [url, init] = fetch.mock.calls[0]!;
		expect(String(url)).toBe("https://memory.example/v1/memories/search");
		expect(JSON.parse(String(init?.body))).toEqual({
			query: "deployment",
			user_id: "ada",
			top_k: 7,
			memory_type: "decision",
			mode: "hybrid",
			search_strategy: "precision",
			sort_by: "importance",
			min_score: 0.2,
			filters: { environment: "production", active: true },
			trace: true,
		});
	});

	it("sends canonical logical filters without mixing structural scope", async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValue(json({ results: [] }));
		const client = new FishMem({ apiKey: "fm_test", fetch });

		await client.memories.search({
			query: "support ticket",
			user_id: "ada",
			filters: {
				and: [
					{
						field: "metadata.channel",
						operator: "eq",
						value: "support",
					},
					{
						field: "created_at",
						operator: "gte",
						value: "2026-07-01T00:00:00.000Z",
					},
					{
						not: {
							field: "content",
							operator: "icontains",
							value: "resolved",
						},
					},
				],
			},
		});

		expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
			query: "support ticket",
			user_id: "ada",
			filters: {
				and: [
					{
						field: "metadata.channel",
						operator: "eq",
						value: "support",
					},
					{
						field: "created_at",
						operator: "gte",
						value: "2026-07-01T00:00:00.000Z",
					},
					{
						not: {
							field: "content",
							operator: "icontains",
							value: "resolved",
						},
					},
				],
			},
		});
	});

	it("lists, pages, reads, and idempotently deletes structural scope entities", async () => {
		const now = "2026-07-31T00:00:00.000Z";
		const first = {
			id: "ada/team",
			type: "user",
			total_memories: 3,
			created_at: now,
			updated_at: now,
		} as const;
		const second = {
			id: "run-2",
			type: "run",
			total_memories: 1,
			created_at: now,
			updated_at: now,
		} as const;
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(
				json({ results: [first], next_cursor: "page two" }),
			)
			.mockResolvedValueOnce(json({ results: [second], next_cursor: null }))
			.mockResolvedValueOnce(json(first))
			.mockResolvedValueOnce(
				json({ id: first.id, type: first.type, deleted_memories: 3 }),
			);
		const client = new FishMem({ apiKey: "fm_test", fetch });
		const ids: string[] = [];

		for await (const entity of client.entities.listAll({ limit: 1 })) {
			ids.push(entity.id);
		}
		await expect(client.entities.get("user", "ada/team")).resolves.toEqual(
			first,
		);
		await expect(
			client.entities.delete("user", "ada/team", {
				idempotencyKey: "delete-ada-team-1",
			}),
		).resolves.toEqual({
			id: "ada/team",
			type: "user",
			deleted_memories: 3,
		});

		expect(ids).toEqual(["ada/team", "run-2"]);
		expect(String(fetch.mock.calls[0]?.[0])).toBe(
			"https://fishmem.com/v1/entities?limit=1",
		);
		expect(String(fetch.mock.calls[1]?.[0])).toBe(
			"https://fishmem.com/v1/entities?limit=1&cursor=page+two",
		);
		expect(String(fetch.mock.calls[2]?.[0])).toBe(
			"https://fishmem.com/v1/entities/user/ada%2Fteam",
		);
		expect(fetch.mock.calls[3]?.[1]?.method).toBe("DELETE");
		expect(
			new Headers(fetch.mock.calls[3]?.[1]?.headers).get("Idempotency-Key"),
		).toBe("delete-ada-team-1");
		expect(() =>
			client.entities.delete("user", "ada", { idempotencyKey: " " }),
		).toThrow("entities.delete requires a non-empty idempotencyKey");
	});

	it("submits durable batch mutations with a required retry identity", async () => {
		const now = "2026-07-30T00:00:00.000Z";
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockImplementation(async (_request, init) =>
				json({
					id: "task_batch",
					kind: init?.method === "PUT" ? "batch_update" : "batch_delete",
					status: "pending",
					attempts: 0,
					max_attempts: 5,
					error: null,
					next_attempt_at: now,
					result: null,
					created_at: now,
					updated_at: now,
				}),
			);
		const client = new FishMem({
			apiKey: "fm_test",
			baseUrl: "https://memory.example",
			fetch,
		});

		await client.memories.batchUpdate(
			{
				memories: [
					{ memory_id: "mem_1", content: "Updated" },
					{ memory_id: "mem_2", metadata: { tier: "pro" } },
				],
			},
			{ idempotencyKey: "batch-update-1" },
		);
		await client.memories.batchDelete(
			{
				memories: [{ memory_id: "mem_1" }, { memory_id: "mem_2" }],
			},
			{ idempotencyKey: "batch-delete-1" },
		);

		expect(fetch).toHaveBeenCalledTimes(2);
		expect(String(fetch.mock.calls[0]![0])).toBe(
			"https://memory.example/v1/memories/batch",
		);
		expect(fetch.mock.calls[0]![1]?.method).toBe("PUT");
		expect(
			new Headers(fetch.mock.calls[0]![1]?.headers).get("Idempotency-Key"),
		).toBe("batch-update-1");
		expect(JSON.parse(String(fetch.mock.calls[1]![1]?.body))).toEqual({
			memories: [{ memory_id: "mem_1" }, { memory_id: "mem_2" }],
		});
		expect(fetch.mock.calls[1]![1]?.method).toBe("DELETE");

		expect(() =>
			client.memories.batchUpdate(
				{ memories: [{ memory_id: "mem_1", content: "Updated" }] },
				{ idempotencyKey: " " },
			),
		).toThrow("memories.batchUpdate requires a non-empty idempotencyKey");
	});

	it("gets, sets, and clears native memory feedback", async () => {
		const now = "2026-07-31T00:00:00.000Z";
		const feedback = {
			id: "feedback_1",
			memory_id: "memory/1",
			rating: "negative",
			reason: "Out of date",
			request_id: "req_1",
			created_at: now,
		} as const;
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(json({ feedback: null }))
			.mockResolvedValueOnce(json({ feedback }))
			.mockResolvedValueOnce(json({ cleared: true }));
		const client = new FishMem({ apiKey: "fm_test", fetch });

		await client.memories.getFeedback("memory/1");
		await client.memories.setFeedback(
			"memory/1",
			{
				rating: "negative",
				reason: "Out of date",
				request_id: "req_1",
			},
			{ idempotencyKey: "feedback-set-1" },
		);
		await client.memories.clearFeedback("memory/1", {
			idempotencyKey: "feedback-clear-1",
		});

		expect(String(fetch.mock.calls[0]![0])).toBe(
			"https://fishmem.com/v1/memories/memory%2F1/feedback",
		);
		expect(fetch.mock.calls[1]![1]?.method).toBe("POST");
		expect(JSON.parse(String(fetch.mock.calls[1]![1]?.body))).toEqual({
			rating: "negative",
			reason: "Out of date",
			request_id: "req_1",
		});
		expect(
			new Headers(fetch.mock.calls[1]![1]?.headers).get("Idempotency-Key"),
		).toBe("feedback-set-1");
		expect(fetch.mock.calls[2]![1]?.method).toBe("DELETE");
	});

	it("covers source ingest, search, original content, and permanent delete", async () => {
		const document = {
			id: "doc_1",
			source_key: "docs/guide.md",
			content_hash: "a".repeat(64),
			version_hash: "b".repeat(64),
			title: "Guide",
			mime_type: "text/markdown",
			source_uri: null,
			user_id: "ada",
			agent_id: null,
			run_id: null,
			metadata: null,
			size_bytes: 20,
			created_at: "2026-07-30T00:00:00.000Z",
		};
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockImplementation(async (request, init) => {
				const url = new URL(String(request));
				if (url.pathname === "/v1/documents" && init?.method === "POST") {
					return json({ document, chunks: 1, created: true });
				}
				if (url.pathname === "/v1/documents/search") {
					return json({ results: [] });
				}
				if (url.pathname === "/v1/documents/doc_1/content") {
					return json({
						id: "doc_1",
						content: "violet release token",
						content_hash: document.content_hash,
					});
				}
				if (
					url.pathname === "/v1/documents/doc_1" &&
					init?.method === "DELETE"
				) {
					return json({
						id: "doc_1",
						deleted: true,
						versions: 1,
						chunks: 1,
					});
				}
				throw new Error(`Unexpected request: ${init?.method} ${url.pathname}`);
			});
		const client = new FishMem({ apiKey: "fm_test", fetch });

		await expect(
			client.documents.ingest(
				{
					source_key: "docs/guide.md",
					content: "violet release token",
					mime_type: "text/markdown",
					user_id: "ada",
				},
				{ idempotencyKey: "guide-1" },
			),
		).resolves.toMatchObject({ document: { id: "doc_1" }, chunks: 1 });
		await expect(
			client.documents.search({ query: "violet", user_id: "ada" }),
		).resolves.toEqual({ results: [] });
		await expect(client.documents.content("doc_1")).resolves.toMatchObject({
			content: "violet release token",
		});
		await expect(
			client.documents.delete("doc_1", { idempotencyKey: "guide-delete" }),
		).resolves.toMatchObject({ deleted: true, versions: 1 });

		expect(
			new Headers(fetch.mock.calls[0]?.[1]?.headers).get("Idempotency-Key"),
		).toBe("guide-1");
		expect(
			new Headers(fetch.mock.calls[3]?.[1]?.headers).get("Idempotency-Key"),
		).toBe("guide-delete");
	});

	it("uploads exact source bytes through the asynchronous asset lifecycle", async () => {
		const now = "2026-07-30T00:00:00.000Z";
		const sourceAsset = {
			id: "asset_upload",
			operation_id: "task_upload",
			source_key: "docs/upload.md",
			filename: "upload.md",
			content_type: "text/markdown",
			size_bytes: 23,
			checksum_sha256: null,
			status: "awaiting_upload",
			title: "Upload",
			source_uri: null,
			user_id: "ada",
			agent_id: null,
			run_id: null,
			metadata: { channel: "sdk" },
			artifact_id: null,
			document_id: null,
			error: null,
			uploaded_at: null,
			created_at: now,
			updated_at: now,
		};
		const operation = {
			id: "task_upload",
			kind: "document_extract",
			status: "awaiting_upload",
			attempts: 0,
			max_attempts: 5,
			error: null,
			next_attempt_at: null,
			result: null,
			created_at: now,
			updated_at: now,
		};
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockImplementation(async (request, init) => {
				const url = new URL(String(request));
				if (
					url.pathname === "/v1/document-uploads" &&
					init?.method === "POST"
				) {
					return json({
						source_asset: sourceAsset,
						upload: {
							method: "PUT",
							url: "https://uploads.example/signed/asset_upload",
							headers: { "content-type": "text/markdown" },
							max_bytes: 25_000_000,
						},
						operation,
					});
				}
				if (
					url.hostname === "uploads.example" &&
					url.pathname === "/signed/asset_upload" &&
					init?.method === "PUT"
				) {
					return new Response(null, { status: 204 });
				}
				if (
					url.pathname === "/v1/document-uploads/asset_upload/complete" &&
					init?.method === "POST"
				) {
					return json(
						{
							source_asset: { ...sourceAsset, status: "queued" },
							operation: { ...operation, status: "pending" },
						},
						202,
					);
				}
				if (
					url.pathname === "/v1/document-uploads/asset_upload" &&
					init?.method === "DELETE"
				) {
					return new Response(null, { status: 204 });
				}
				throw new Error(`Unexpected request: ${init?.method} ${url.pathname}`);
			});
		const client = new FishMem({
			apiKey: "fm_test",
			baseUrl: "https://memory.example",
			fetch,
			headers: { "x-fishmem-tenant": "private-tenant" },
		});

		await expect(
			client.documents.upload(
				{
					file: new Blob(["# Exact\n\nViolet bytes.\n"], {
						type: "text/markdown",
					}),
					filename: "upload.md",
					source_key: "docs/upload.md",
					title: "Upload",
					user_id: "ada",
					metadata: { channel: "sdk" },
				},
				{ idempotencyKey: "upload-1" },
			),
		).resolves.toMatchObject({
			source_asset: { id: "asset_upload", status: "queued" },
			operation: { id: "task_upload", status: "pending" },
		});
		await expect(
			client.documents.deleteUpload("asset_upload"),
		).resolves.toBeUndefined();

		expect(fetch).toHaveBeenCalledTimes(4);
		const [createUrl, createInit] = fetch.mock.calls[0]!;
		expect(String(createUrl)).toBe(
			"https://memory.example/v1/document-uploads",
		);
		expect(new Headers(createInit?.headers).get("Content-Type")).toBe(
			"application/json",
		);
		expect(new Headers(createInit?.headers).get("Idempotency-Key")).toBe(
			"upload-1",
		);
		expect(JSON.parse(String(createInit?.body))).toMatchObject({
			filename: "upload.md",
			source_key: "docs/upload.md",
			title: "Upload",
			user_id: "ada",
			metadata: { channel: "sdk" },
			size_bytes: 23,
			content_type: "text/markdown",
			checksum_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
		});

		const [contentUrl, contentInit] = fetch.mock.calls[1]!;
		expect(String(contentUrl)).toBe(
			"https://uploads.example/signed/asset_upload",
		);
		expect(contentInit?.body).toBeInstanceOf(Blob);
		expect(new Headers(contentInit?.headers).get("Content-Type")).toBe(
			"text/markdown",
		);
		expect(new Headers(contentInit?.headers).get("Idempotency-Key")).toBeNull();
		expect(new Headers(contentInit?.headers).get("Authorization")).toBeNull();
		expect(
			new Headers(contentInit?.headers).get("x-fishmem-tenant"),
		).toBeNull();
		await expect((contentInit?.body as Blob).text()).resolves.toBe(
			"# Exact\n\nViolet bytes.\n",
		);

		const [completeUrl, completeInit] = fetch.mock.calls[2]!;
		expect(String(completeUrl)).toBe(
			"https://memory.example/v1/document-uploads/asset_upload/complete",
		);
		expect(completeInit?.method).toBe("POST");
		expect(String(fetch.mock.calls[3]?.[0])).toBe(
			"https://memory.example/v1/document-uploads/asset_upload",
		);
		expect(fetch.mock.calls[3]?.[1]?.method).toBe("DELETE");
	});

	it("iterates cursor pages without buffering the full collection", async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(
				json({
					results: [{ id: "m1", memory: "first" }],
					next_cursor: "page-2",
				}),
			)
			.mockResolvedValueOnce(
				json({
					results: [{ id: "m2", memory: "second" }],
					next_cursor: null,
				}),
			);
		const client = new FishMem({ apiKey: "fm_test", fetch });
		const ids: string[] = [];

		for await (const memory of client.memories.listAll({ user_id: "alex" })) {
			ids.push(memory.id);
		}

		expect(ids).toEqual(["m1", "m2"]);
		expect(String(fetch.mock.calls[1]?.[0])).toContain("cursor=page-2");
	});

	it("surfaces structured API failures", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
			json(
				{
					error: {
						code: "INVALID_REQUEST",
						message: "One memory scope is required",
						request_id: "req_123",
					},
				},
				400,
			),
		);
		const client = new FishMem({ apiKey: "fm_test", fetch });

		await expect(
			client.memories.search({ query: "red", user_id: "alex" }),
		).rejects.toMatchObject({
			name: "FishMemError",
			status: 400,
			code: "INVALID_REQUEST",
			requestId: "req_123",
		});
	});

	it("covers the complete memory, state, profile, and operation surface", async () => {
		const now = "2026-07-30T00:00:00.000Z";
		const operation = {
			id: "op_1",
			kind: "export",
			status: "pending",
			attempts: 0,
			error: null,
			created_at: now,
			updated_at: now,
		};
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockImplementation(async (request, init) => {
				const url = new URL(String(request));
				if (url.pathname === "/v1/memories/m1" && init?.method === "PUT") {
					return json({ id: "m1", memory: "green tea", event: "UPDATE" });
				}
				if (
					url.pathname === "/v1/memories/m1/history" &&
					init?.method === "GET"
				) {
					return json({ results: [] });
				}
				if (url.pathname === "/v1/state/history") {
					return json({ data: [] });
				}
				if (url.pathname === "/v1/state") {
					return json({ data: null });
				}
				if (url.pathname === "/v1/beliefs") {
					return json({
						data: {
							projection_status: "ready",
							winner: null,
							candidates: [],
						},
					});
				}
				if (url.pathname === "/v1/profile") {
					return json({ data: "## Preferences" });
				}
				if (url.pathname === "/v1/health") {
					return json({
						status: "ok",
						checked_at: now,
						engine: { configured: true, initialized: true, code: null },
						operations: {
							pending: 0,
							failed: 0,
							oldest_pending_at: null,
						},
						tasks: { pending: 0, dead: 0, oldest_pending_at: null },
						projections: { vector_pending: 0, derived_pending: 0 },
						warnings: { last_24h: 0 },
					});
				}
				if (url.pathname === "/v1/operations" && init?.method === "GET") {
					return json({ results: [operation] });
				}
				if (url.pathname === "/v1/operations/op_1") {
					return json(operation);
				}
				if (url.pathname === "/v1/operations/op_1/retry") {
					return json({ ...operation, status: "pending" }, 202);
				}
				if (url.pathname === "/v1/exports") {
					return json(operation, 202);
				}
				if (url.pathname === "/v1/imports") {
					return json({ ...operation, kind: "import" }, 202);
				}
				throw new Error(`Unexpected request: ${init?.method} ${url.pathname}`);
			});
		const client = new FishMem({ apiKey: "fm_test", fetch });

		await expect(
			client.memories.update("m1", { content: "green tea" }),
		).resolves.toMatchObject({ event: "UPDATE" });
		await expect(client.memories.history("m1")).resolves.toEqual({
			results: [],
		});
		await expect(
			client.state.get({
				user_id: "ada",
				subject: "Ada",
				attribute: "drink",
			}),
		).resolves.toBeNull();
		await expect(
			client.state.history({
				user_id: "ada",
				subject: "Ada",
				attribute: "drink",
			}),
		).resolves.toEqual([]);
		await expect(
			client.beliefs.get({
				user_id: "ada",
				subject: "Ada",
				attribute: "drink",
				view: "audit",
			}),
		).resolves.toMatchObject({ projection_status: "ready", candidates: [] });
		await expect(client.profile.get({ user_id: "ada" })).resolves.toBe(
			"## Preferences",
		);
		await expect(client.health.get()).resolves.toMatchObject({ status: "ok" });
		await expect(client.operations.list()).resolves.toMatchObject({
			results: [{ id: "op_1" }],
		});
		await expect(client.operations.get("op_1")).resolves.toMatchObject({
			id: "op_1",
		});
		await expect(client.operations.retry("op_1")).resolves.toMatchObject({
			id: "op_1",
			status: "pending",
		});
		await expect(
			client.exports.create({ idempotencyKey: "export-1" }),
		).resolves.toMatchObject({ kind: "export" });
		await expect(
			client.imports.create(
				{ snapshot: { format: "fishmem.namespace-snapshot" } },
				{ idempotencyKey: "import-1" },
			),
		).resolves.toMatchObject({ kind: "import" });

		const exportCall = fetch.mock.calls.find(([url]) =>
			String(url).endsWith("/v1/exports"),
		);
		expect(new Headers(exportCall?.[1]?.headers).get("Idempotency-Key")).toBe(
			"export-1",
		);
		const importCall = fetch.mock.calls.find(([url]) =>
			String(url).endsWith("/v1/imports"),
		);
		expect(JSON.parse(String(importCall?.[1]?.body))).toEqual({
			snapshot: { format: "fishmem.namespace-snapshot" },
		});
	});

	it("waits for an asynchronous operation to reach a terminal status", async () => {
		const now = "2026-07-30T00:00:00.000Z";
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(
				json({
					id: "op_1",
					kind: "export",
					status: "processing",
					attempts: 1,
					error: null,
					created_at: now,
					updated_at: now,
				}),
			)
			.mockResolvedValueOnce(
				json({
					id: "op_1",
					kind: "export",
					status: "success",
					attempts: 1,
					error: null,
					result: { snapshot: {} },
					created_at: now,
					updated_at: now,
				}),
			);
		const client = new FishMem({ apiKey: "fm_test", fetch });

		await expect(
			client.operations.wait("op_1", { intervalMs: 0, timeoutMs: 100 }),
		).resolves.toMatchObject({
			status: "success",
			result: { snapshot: {} },
		});
		expect(fetch).toHaveBeenCalledTimes(2);
	});
});
