import { afterEach, describe, expect, it } from "vitest";
import type { EmbeddingOptions } from "fishmem";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DesktopMemoryService,
	type LocalEmbeddingRuntime,
} from "./memory-service";
import type { LocalEmbeddingState } from "./local-embedder";
import type {
	DesktopMemoryPage,
	DesktopMemoryRecord,
	DesktopRememberResult,
	DesktopSummary,
} from "../shared/protocol";

/** Deterministic topic embedder: texts sharing a keyword embed identically. */
class TopicEmbedder implements LocalEmbeddingRuntime {
	readonly dimensions = 4;
	readonly model = "test/topic-e5";
	state: LocalEmbeddingState = { phase: "ready" };
	gate?: Promise<void>;

	async prepare(): Promise<void> {}

	async embed(text: string, options?: EmbeddingOptions): Promise<number[]> {
		const [vector] = await this.embedBatch([text], options);
		return vector!;
	}

	async embedBatch(
		texts: string[],
		_options?: EmbeddingOptions,
	): Promise<number[][]> {
		if (this.gate && texts.some((text) => text.includes("SLOW"))) {
			await this.gate;
		}
		return texts.map((text) => {
			const value = text.toLowerCase();
			if (value.includes("tabs")) return [1, 0.02, 0, 0];
			if (value.includes("spaces")) return [0.02, 1, 0, 0];
			if (value.includes("deploy")) return [0, 0, 1, 0.02];
			return [0, 0, 0.02, 1];
		});
	}
}

type AddResult = {
	results: Array<{ id: string; memory: string; event: string }>;
	deduplicated?: boolean;
	duplicate_of?: string;
	needs_review?: boolean;
	similar?: Array<{ id: string; similarity: number }>;
};

describe("DesktopMemoryService recall quality", () => {
	let directory: string | undefined;
	let service: DesktopMemoryService | undefined;
	let embedder: TopicEmbedder;

	afterEach(async () => {
		await service?.close();
		service = undefined;
		if (directory) await rm(directory, { recursive: true, force: true });
	});

	async function start() {
		directory = await mkdtemp(join(tmpdir(), "fishmem-desktop-recall-"));
		embedder = new TopicEmbedder();
		service = new DesktopMemoryService(
			join(directory, "fishmem.db"),
			join(directory, "models"),
			join(directory, "desktop.sock"),
			() => embedder,
		);
		await service.initialize();
		await service.invoke("retryEmbedding");
		return service;
	}

	it("returns the existing record for an exact duplicate instead of writing", async () => {
		const desktop = await start();
		const first = (await desktop.invoke("add", {
			content: "Indent Go code with tabs.",
			project: "acme",
		})) as AddResult;
		expect(first.results[0]?.event).toBe("ADD");
		const again = (await desktop.invoke("add", {
			content: "  indent go code with TABS ",
			project: "acme",
		})) as AddResult;
		expect(again).toMatchObject({
			deduplicated: true,
			duplicate_of: first.results[0]!.id,
			results: [{ id: first.results[0]!.id, event: "NONE" }],
		});
		const page = (await desktop.invoke("list", {
			limit: 10,
			project: "acme",
		})) as DesktopMemoryPage;
		expect(page.results).toHaveLength(1);
		// A different project is a different scope.
		const elsewhere = (await desktop.invoke("add", {
			content: "Indent Go code with tabs.",
			project: "other",
		})) as AddResult;
		expect(elsewhere.results[0]?.event).toBe("ADD");
	});

	it("returns near-duplicates for review and writes only with force", async () => {
		const desktop = await start();
		const original = (await desktop.invoke("add", {
			content: "The team indents with tabs",
			project: "acme",
			check_similar: true,
		})) as AddResult;
		const near = (await desktop.invoke("add", {
			content: "Always use tabs for indentation in this repo",
			project: "acme",
			check_similar: true,
		})) as AddResult;
		expect(near).toMatchObject({
			results: [],
			needs_review: true,
			similar: [{ id: original.results[0]!.id }],
		});
		expect(near.similar?.[0]?.similarity).toBeGreaterThanOrEqual(0.92);
		const unrelated = (await desktop.invoke("add", {
			content: "Deploy with wrangler",
			project: "acme",
			check_similar: true,
		})) as AddResult;
		expect(unrelated.results[0]?.event).toBe("ADD");
		const forced = (await desktop.invoke("add", {
			content: "Always use tabs for indentation in this repo",
			project: "acme",
			force: true,
		})) as AddResult;
		expect(forced.results[0]?.event).toBe("ADD");

		const remembered = (await desktop.invoke("remember", {
			content: "Use tabs, never spaces",
			project: "acme",
		})) as DesktopRememberResult;
		expect(remembered.suggested_action).toBe("review");
		expect(remembered.similar.length).toBeGreaterThanOrEqual(2);
		const fresh = (await desktop.invoke("remember", {
			content: "Unrelated fact about lunch",
			project: "acme",
		})) as DesktopRememberResult;
		expect(fresh.suggested_action).toBe("add");
	});

	it("scopes search and list to the project plus global memories", async () => {
		const desktop = await start();
		await desktop.invoke("add", { content: "Deploy acme with wrangler", project: "acme" });
		await desktop.invoke("add", { content: "Deploy other with fly", project: "other" });
		await desktop.invoke("add", { content: "Deploy nothing on Fridays" });
		const scoped = (await desktop.invoke("search", {
			query: "deploy",
			project: "acme",
		})) as DesktopMemoryPage;
		expect(scoped.results.map((memory) => memory.content).sort()).toEqual([
			"Deploy acme with wrangler",
			"Deploy nothing on Fridays",
		]);
		const everything = (await desktop.invoke("search", {
			query: "deploy",
			project: "acme",
			all_projects: true,
		})) as DesktopMemoryPage;
		expect(everything.results).toHaveLength(3);
		const listed = (await desktop.invoke("list", {
			project: "other",
		})) as DesktopMemoryPage;
		expect(listed.results.map((memory) => memory.content).sort()).toEqual([
			"Deploy nothing on Fridays",
			"Deploy other with fly",
		]);
		const future = (await desktop.invoke("search", {
			query: "deploy",
			since: "2999-01-01T00:00:00.000Z",
		})) as DesktopMemoryPage;
		expect(future.results).toHaveLength(0);
		const similar = (await desktop.invoke("search", {
			query: "deploy",
			project: "acme",
			min_similarity: 0.9,
		})) as { results: DesktopMemoryRecord[] };
		expect(similar.results.length).toBe(2);
		expect(similar.results.every((memory) => (memory.similarity ?? 0) >= 0.9)).toBe(true);
		const none = (await desktop.invoke("search", {
			query: "lunch",
			project: "acme",
			min_similarity: 0.9,
		})) as DesktopMemoryPage;
		expect(none.results).toHaveLength(0);
	});

	it("supersedes and invalidates outdated facts", async () => {
		const desktop = await start();
		const old = (await desktop.invoke("add", {
			content: "Deploy target is Heroku",
			project: "acme",
		})) as AddResult;
		const oldId = old.results[0]!.id;
		const replaced = (await desktop.invoke("supersede", {
			id: oldId,
			content: "Deploy target is Cloudflare Workers",
		})) as { superseded: string; superseded_by: string };
		expect(replaced.superseded).toBe(oldId);
		const previous = (await desktop.invoke("get", { id: oldId })) as DesktopMemoryRecord;
		expect(previous.supersededBy).toBe(replaced.superseded_by);
		const successor = (await desktop.invoke("get", {
			id: replaced.superseded_by,
		})) as DesktopMemoryRecord;
		expect(successor.metadata).toMatchObject({ fishmemProject: "acme" });
		await desktop.invoke("update", {
			id: replaced.superseded_by,
			metadata: { reviewed: true },
		});
		await expect(
			desktop.invoke("get", { id: replaced.superseded_by }),
		).resolves.toMatchObject({
			metadata: { reviewed: true, fishmemProject: "acme" },
		});
		await expect(
			desktop.invoke("supersede", { id: oldId, content: "again" }),
		).rejects.toThrow("already superseded");
		await expect(
			desktop.invoke("invalidate", { id: replaced.superseded_by }),
		).resolves.toMatchObject({ invalidated: true });
		// Re-adding the invalidated content is a fresh assertion, not a duplicate.
		const readded = (await desktop.invoke("add", {
			content: "Deploy target is Cloudflare Workers",
			project: "acme",
		})) as AddResult;
		expect(readded.results[0]?.event).toBe("ADD");
		expect(readded.results[0]?.id).not.toBe(replaced.superseded_by);
	});

	it("does not count UI browsing as recall", async () => {
		const desktop = await start();
		await desktop.invoke("add", { content: "Prefer tabs" });
		await desktop.invoke("search", { query: "tabs", record_access: false });
		await desktop.flushWrites();
		let summary = (await desktop.invoke("summary")) as DesktopSummary;
		expect(summary.recalledToday).toBe(0);
		await desktop.invoke("search", { query: "tabs" });
		await desktop.flushWrites();
		summary = (await desktop.invoke("summary")) as DesktopSummary;
		expect(summary.recalledToday).toBe(1);
	});

	it("answers searches while a slow document ingest is still running", async () => {
		const desktop = await start();
		await desktop.invoke("add", { content: "Prefer tabs" });
		let release!: () => void;
		embedder.gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const ingest = desktop.invoke("documentIngest", {
			source_key: "docs/slow.md",
			content: "SLOW document body",
			idempotency_key: "slow-ingest",
		});
		let ingestDone = false;
		void ingest.then(() => {
			ingestDone = true;
		});
		const search = (await desktop.invoke("search", {
			query: "tabs",
		})) as DesktopMemoryPage;
		expect(search.results[0]?.content).toBe("Prefer tabs");
		expect(ingestDone).toBe(false);
		release();
		await ingest;
	});

	it("reports near-duplicates and removes exact duplicates during maintenance", async () => {
		const desktop = await start();
		const keep = (await desktop.invoke("add", {
			content: "Use tabs",
			project: "acme",
		})) as AddResult;
		const copy = (await desktop.invoke("add", {
			content: "use tabs.",
			project: "acme",
			force: true,
		})) as AddResult;
		await desktop.invoke("add", {
			content: "Tabs are preferred for Go",
			project: "acme",
			force: true,
		});
		const duplicates = (await desktop.invoke("duplicates", {
			project: "acme",
		})) as { pairs: Array<{ exact: boolean; similarity: number }> };
		expect(duplicates.pairs.length).toBe(3);
		expect(duplicates.pairs.filter((pair) => pair.exact)).toHaveLength(1);

		const result = (await desktop.invoke("maintenance")) as {
			exact_duplicates_removed: number;
			removed_ids: string[];
		};
		expect(result.exact_duplicates_removed).toBe(1);
		expect(result.removed_ids).toEqual([copy.results[0]!.id]);
		await expect(
			desktop.invoke("get", { id: keep.results[0]!.id }),
		).resolves.toMatchObject({ content: "Use tabs" });
		const again = (await desktop.invoke("maintenance")) as {
			exact_duplicates_removed: number;
		};
		expect(again.exact_duplicates_removed).toBe(0);
	});
});
