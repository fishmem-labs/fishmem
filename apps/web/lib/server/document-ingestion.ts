import { and, desc, eq, inArray, lt } from "drizzle-orm";
import {
  CreateDocumentUploadCommandSchema,
  MAX_DOCUMENT_SOURCE_BYTES,
  MAX_DOCUMENT_UPLOAD_BYTES,
  MAX_DOCUMENT_UPLOAD_PAGES,
  type CreateDocumentUploadCommand,
} from "@fishmem/contracts";
import { MemoryApplication } from "@fishmem/application";
import { chunkDocumentText, type Memory } from "fishmem";
import type { AppDb } from "@/db";
import {
  extractionArtifacts,
  operationTasks,
  sourceAssets,
} from "@/db/schema";
import { getRuntimeEnv } from "@/lib/cloudflare";
import { IS_CLOUDFLARE } from "@/lib/platform";
import {
  enqueueOperationTask,
  type OperationTask,
} from "@/lib/server/operation-tasks";

export const DOCLING_EXTRACTOR_NAME = "docling";
export const DOCLING_EXTRACTOR_VERSION = "docling-serve@1.21.0";
export const DOCUMENT_QUERY_VISIBILITY_TARGET_MS = 120_000;
const EXTRACTION_TIMEOUT_MS = 10 * 60_000;
const DOCLING_HTTP_TIMEOUT_MS = 30_000;
const DOCLING_POLL_INTERVAL_MS = 1_000;

const SUPPORTED_UPLOAD_MEDIA_TYPES = new Set([
  "application/epub+zip",
  "application/json",
  "application/msword",
  "application/pdf",
  "application/rtf",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.oasis.opendocument.presentation",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/xml",
  "application/yaml",
  "image/bmp",
  "image/jpeg",
  "image/png",
  "image/tiff",
  "image/webp",
  "message/rfc822",
]);

type SourceAssetRow = typeof sourceAssets.$inferSelect;
type ExtractionArtifactRow = typeof extractionArtifacts.$inferSelect;

export class DocumentIngestionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DocumentIngestionError";
  }
}

export type StoredObjectHead = {
  size: number;
  checksumSha256: string;
};

export type StoredObject = StoredObjectHead & {
  bytes: Uint8Array;
};

export interface DocumentObjectStore {
  put(
    key: string,
    bytes: Uint8Array,
    metadata: { contentType: string; checksumSha256: string },
  ): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  head(key: string): Promise<StoredObjectHead | null>;
  delete(key: string): Promise<void>;
}

export type ExtractedDocument = {
  markdown: string;
  structure: Record<string, unknown>;
  pageCount: number;
  processingTimeSeconds?: number;
};

export interface DocumentExtractor {
  readonly name: string;
  readonly version: string;
  extract(input: {
    bytes: Uint8Array;
    filename: string;
    mediaType: string;
  }): Promise<ExtractedDocument>;
}

/**
 * Hosted accounting can authorize the exact deterministic chunk count after
 * extraction but before the canonical document writer runs. The OSS adapter
 * omits this interface entirely.
 */
export interface DocumentExtractionAccounting {
  authorizeIngest(input: {
    task: OperationTask;
    sourceAsset: ReturnType<typeof shapeSourceAsset>;
    artifact: ReturnType<typeof shapeArtifact>;
    projectedChunks: number;
  }): Promise<unknown>;
  settleIngest(input: {
    authorization: unknown;
    outcome: "success" | "failed";
  }): Promise<void>;
}

export class R2DocumentObjectStore implements DocumentObjectStore {
  constructor(private readonly bucket: R2Bucket) {
    if (!bucket) throw new Error("R2 binding is required for document assets");
  }

  async put(
    key: string,
    bytes: Uint8Array,
    metadata: { contentType: string; checksumSha256: string },
  ) {
    const existing = await this.head(key);
    if (existing) {
      assertStoredObjectMatches(key, existing, bytes.length, metadata.checksumSha256);
      return;
    }
    const stored = await this.bucket.put(key, bytes, {
      httpMetadata: { contentType: metadata.contentType },
      customMetadata: { checksumSha256: metadata.checksumSha256 },
      sha256: metadata.checksumSha256,
      onlyIf: { etagDoesNotMatch: "*" },
    });
    if (!stored) {
      const raced = await this.head(key);
      if (!raced) throw new Error(`document object write failed: ${key}`);
      assertStoredObjectMatches(
        key,
        raced,
        bytes.length,
        metadata.checksumSha256,
      );
    }
  }

  async get(key: string): Promise<StoredObject | null> {
    const object = await this.bucket.get(key);
    if (!object) return null;
    const bytes = new Uint8Array(await object.arrayBuffer());
    const checksumSha256 =
      object.customMetadata?.checksumSha256 ?? (await sha256Hex(bytes));
    return { bytes, size: object.size, checksumSha256 };
  }

  async head(key: string): Promise<StoredObjectHead | null> {
    const object = await this.bucket.head(key);
    if (!object) return null;
    const checksumSha256 = object.customMetadata?.checksumSha256;
    if (!checksumSha256) {
      const hydrated = await this.get(key);
      return hydrated
        ? { size: hydrated.size, checksumSha256: hydrated.checksumSha256 }
        : null;
    }
    return { size: object.size, checksumSha256 };
  }

  async delete(key: string) {
    await this.bucket.delete(key);
  }
}

export class LocalDocumentObjectStore implements DocumentObjectStore {
  constructor(private readonly rootDirectory: string) {
    if (!rootDirectory.trim()) {
      throw new Error("FISHMEM_ASSET_DIR must not be blank");
    }
  }

  async put(
    key: string,
    bytes: Uint8Array,
    metadata: { contentType: string; checksumSha256: string },
  ) {
    const { dirname } = await import("node:path");
    const { link, mkdir, unlink, writeFile } = await import("node:fs/promises");
    const target = await this.pathFor(key);
    const existing = await this.head(key);
    if (existing) {
      assertStoredObjectMatches(key, existing, bytes.length, metadata.checksumSha256);
      return;
    }
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.upload-${crypto.randomUUID()}`;
    await writeFile(temporary, bytes, { flag: "wx" });
    try {
      await link(temporary, target);
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      const raced = await this.head(key);
      if (!raced) throw error;
      assertStoredObjectMatches(
        key,
        raced,
        bytes.length,
        metadata.checksumSha256,
      );
    } finally {
      await unlink(temporary).catch((error) => {
        if (!isNodeError(error, "ENOENT")) throw error;
      });
    }
  }

  async get(key: string): Promise<StoredObject | null> {
    const { readFile } = await import("node:fs/promises");
    try {
      const value = await readFile(await this.pathFor(key));
      const bytes = Uint8Array.from(value);
      return {
        bytes,
        size: bytes.byteLength,
        checksumSha256: await sha256Hex(bytes),
      };
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return null;
      throw error;
    }
  }

  async head(key: string): Promise<StoredObjectHead | null> {
    const object = await this.get(key);
    return object
      ? { size: object.size, checksumSha256: object.checksumSha256 }
      : null;
  }

  async delete(key: string) {
    const { unlink } = await import("node:fs/promises");
    await unlink(await this.pathFor(key)).catch((error) => {
      if (!isNodeError(error, "ENOENT")) throw error;
    });
  }

  private async pathFor(key: string) {
    const { resolve, sep } = await import("node:path");
    const segments = key.split("/");
    if (
      !segments.length ||
      segments.some(
        (segment) =>
          !segment ||
          segment === "." ||
          segment === ".." ||
          segment.includes("\\"),
      )
    ) {
      throw new Error(`invalid document object key: ${key}`);
    }
    const root = resolve(this.rootDirectory);
    const target = resolve(root, ...segments);
    if (target !== root && !target.startsWith(`${root}${sep}`)) {
      throw new Error(`document object key escapes its storage root: ${key}`);
    }
    return target;
  }
}

export class DoclingDocumentExtractor implements DocumentExtractor {
  readonly name = DOCLING_EXTRACTOR_NAME;
  readonly version = DOCLING_EXTRACTOR_VERSION;

  constructor(
    private readonly fetcher: (
      url: string,
      init: RequestInit,
    ) => Promise<Response>,
    private readonly endpoint = "http://localhost:5001",
  ) {}

  async extract(input: {
    bytes: Uint8Array;
    filename: string;
    mediaType: string;
  }): Promise<ExtractedDocument> {
    const form = new FormData();
    form.set(
      "files",
      new Blob(
        [
          input.bytes.buffer.slice(
            input.bytes.byteOffset,
            input.bytes.byteOffset + input.bytes.byteLength,
          ) as ArrayBuffer,
        ],
        { type: input.mediaType },
      ),
      input.filename,
    );
    form.append("to_formats", "md");
    form.append("to_formats", "json");
    form.set("do_ocr", "true");
    form.set("image_export_mode", "placeholder");
    form.set("table_mode", "accurate");
    form.set("abort_on_error", "true");
    const baseUrl = this.endpoint.replace(/\/+$/, "");
    const submission = await this.fetchJson(
      `${baseUrl}/v1/convert/file/async`,
      {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(DOCLING_HTTP_TIMEOUT_MS),
      },
    );
    const taskId =
      typeof submission.payload?.task_id === "string"
        ? submission.payload.task_id
        : "";
    if (!submission.response.ok || !taskId) {
      throw new Error(`Docling extraction submission failed with status ${
        submission.response.status
      }${compactTaskError(submission.payload)}`);
    }
    const deadline = Date.now() + EXTRACTION_TIMEOUT_MS;
    while (true) {
      if (Date.now() >= deadline) {
        throw new Error(
          `Docling extraction timed out after ${
            EXTRACTION_TIMEOUT_MS / 1_000
          } seconds`,
        );
      }
      const status = await this.fetchJson(
        `${baseUrl}/v1/status/poll/${encodeURIComponent(taskId)}`,
        {
          method: "GET",
          signal: AbortSignal.timeout(DOCLING_HTTP_TIMEOUT_MS),
        },
      );
      if (!status.response.ok || !status.payload) {
        throw new Error(
          `Docling extraction status failed with status ${
            status.response.status
          }${compactTaskError(status.payload)}`,
        );
      }
      const taskStatus = status.payload.task_status;
      if (taskStatus === "failure") {
        throw new Error(
          `Docling extraction failed${compactTaskError(status.payload)}`,
        );
      }
      if (taskStatus === "success") break;
      if (taskStatus !== "pending" && taskStatus !== "started") {
        throw new Error(
          `Docling extraction returned unknown task status ${String(
            taskStatus,
          )}`,
        );
      }
      await delay(DOCLING_POLL_INTERVAL_MS);
    }
    const result = await this.fetchJson(
      `${baseUrl}/v1/result/${encodeURIComponent(taskId)}`,
      {
        method: "GET",
        signal: AbortSignal.timeout(DOCLING_HTTP_TIMEOUT_MS),
      },
    );
    if (!result.response.ok || !result.payload) {
      throw new Error(
        `Docling extraction result failed with status ${
          result.response.status
        }${compactTaskError(result.payload)}`,
      );
    }
    return parseDoclingResult(result.payload);
  }

  private async fetchJson(url: string, init: RequestInit) {
    const response = await this.fetcher(url, init);
    const payload = (await response.json().catch(() => null)) as
      | Record<string, unknown>
      | null;
    return { response, payload };
  }
}

function parseDoclingResult(
  payload: Record<string, unknown>,
): ExtractedDocument {
    if (payload.status !== "success") {
      throw new Error(
        `Docling extraction returned ${String(payload.status)}: ${compactErrors(
          payload.errors,
        )}`,
      );
    }
    const document = asRecord(payload.document);
    const markdown =
      typeof document?.md_content === "string"
        ? document.md_content
        : undefined;
    if (!markdown?.trim()) {
      throw new Error("Docling extraction returned no Markdown content");
    }
    const structure = parseStructure(document?.json_content);
    return {
      markdown,
      structure,
      pageCount: documentPageCount(structure),
      ...(typeof payload.processing_time === "number"
        ? { processingTimeSeconds: payload.processing_time }
        : {}),
    };
}

/**
 * Deep document-ingestion module. HTTP handlers only authenticate and shape
 * responses; all lifecycle, integrity, and idempotency rules live here.
 */
export class DocumentIngestion {
  constructor(
    private readonly db: AppDb,
    private readonly objects: DocumentObjectStore,
  ) {}

  async create(
    workspaceId: string,
    body: unknown,
    idempotencyKey: string,
    requestUrl: string,
    now = new Date(),
  ) {
    const command = parseCreateCommand(body);
    assertSupportedMediaType(command.content_type);
    const assetId = await deterministicId(
      "asset",
      `${workspaceId}\0${idempotencyKey}`,
    );
    const storageKey = sourceObjectKey(workspaceId, assetId);
    const normalized = {
      ...command,
      content_type: normalizeMediaType(command.content_type),
      checksum_sha256: command.checksum_sha256?.toLowerCase(),
      source_key: command.source_key ?? command.filename,
    };
    const [created] = await this.db
      .insert(sourceAssets)
      .values({
        id: assetId,
        documentId: assetId,
        workspaceId,
        idempotencyKey,
        sourceKey: normalized.source_key,
        filename: normalized.filename,
        mimeType: normalized.content_type,
        sizeBytes: normalized.size_bytes,
        expectedChecksumSha256: normalized.checksum_sha256,
        storageKey,
        status: "awaiting_upload",
        title: normalized.title,
        sourceUri: normalized.source_uri,
        metadata: normalized.metadata,
        userId: normalized.user_id,
        agentId: normalized.agent_id,
        runId: normalized.run_id,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();
    const asset =
      created ??
      (await this.db
        .select()
        .from(sourceAssets)
        .where(eq(sourceAssets.id, assetId))
        .get());
    if (!asset) throw new Error("source asset insert could not be resolved");
    assertCreateReplay(asset, normalized);

    const task = await enqueueOperationTask(
      this.db,
      {
        workspaceId,
        operationId: idempotencyKey,
        kind: "document_extract",
        payload: { sourceAssetId: assetId },
        status: "awaiting_upload",
      },
      now,
    );
    await this.db
      .update(sourceAssets)
      .set({ operationTaskId: task.documentId, updatedAt: now })
      .where(
        and(
          eq(sourceAssets.id, assetId),
          eq(sourceAssets.workspaceId, workspaceId),
        ),
      );
    const complete = await this.requireAsset(workspaceId, assetId);
    const uploadUrl = new URL(
      `/v1/document-uploads/${encodeURIComponent(assetId)}/content`,
      requestUrl,
    ).toString();
    return {
      source_asset: shapeSourceAsset(complete),
      upload: {
        method: "PUT" as const,
        url: uploadUrl,
        headers: { "content-type": normalized.content_type },
        max_bytes: MAX_DOCUMENT_UPLOAD_BYTES,
      },
      operation: shapeTask(task),
    };
  }

  async get(workspaceId: string, assetId: string) {
    return shapeSourceAsset(await this.requireAsset(workspaceId, assetId));
  }

  async list(workspaceId: string, limit = 100) {
    const boundedLimit = Number.isFinite(limit)
      ? Math.min(Math.max(Math.trunc(limit), 1), 100)
      : 100;
    const rows = await this.db
      .select()
      .from(sourceAssets)
      .where(eq(sourceAssets.workspaceId, workspaceId))
      .orderBy(desc(sourceAssets.createdAt))
      .limit(boundedLimit);
    return rows.map(shapeSourceAsset);
  }

  /**
   * Remove every raw upload and extraction artifact in the stable source
   * family that produced this document id. The canonical DocumentCorpus
   * deletion remains the authority; this is its object-backed companion.
   */
  async deleteForDocument(workspaceId: string, documentId: string) {
    const seed = await this.db
      .select()
      .from(sourceAssets)
      .where(
        and(
          eq(sourceAssets.workspaceId, workspaceId),
          eq(sourceAssets.ingestedDocumentId, documentId),
        ),
      )
      .get();
    if (!seed) return { source_assets: 0, artifacts: 0 };
    const assets = await this.db
      .select()
      .from(sourceAssets)
      .where(
        and(
          eq(sourceAssets.workspaceId, workspaceId),
          eq(sourceAssets.sourceKey, seed.sourceKey),
        ),
      );
    return this.deleteAssetRows(workspaceId, assets);
  }

  async deleteWorkspace(workspaceId: string) {
    const assets = await this.db
      .select()
      .from(sourceAssets)
      .where(eq(sourceAssets.workspaceId, workspaceId));
    return this.deleteAssetRows(workspaceId, assets);
  }

  /**
   * Cancel an upload/extraction that has not begun executing. Deleting the D1
   * task first is the claim fence: a queued wakeup can no longer acquire work
   * before raw bytes and artifact rows are removed.
   */
  async deleteUpload(
    workspaceId: string,
    assetId: string,
    options: {
      afterTaskFenced?: (task: OperationTask) => Promise<void>;
    } = {},
  ) {
    const asset = await this.requireAsset(workspaceId, assetId);
    if (asset.status === "ready" || asset.ingestedDocumentId) {
      throw new DocumentIngestionError(
        409,
        "SOURCE_ASSET_READY",
        "Delete the indexed document to remove a ready source and its versions",
      );
    }
    if (asset.operationTaskId) {
      const [fenced] = await this.db
        .update(operationTasks)
        .set({
          status: "cancelled",
          nextAttemptAt: null,
          leaseExpiresAt: null,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(operationTasks.workspaceId, workspaceId),
            eq(operationTasks.documentId, asset.operationTaskId),
            inArray(operationTasks.status, [
              "awaiting_upload",
              "pending",
              "retry",
              "dead",
            ]),
          ),
        )
        .returning();
      const current =
        fenced ??
        (await this.db
          .select()
          .from(operationTasks)
          .where(
            and(
              eq(operationTasks.workspaceId, workspaceId),
              eq(operationTasks.documentId, asset.operationTaskId),
            ),
          )
          .get());
      if (current && current.status !== "cancelled") {
          throw new DocumentIngestionError(
            409,
            "SOURCE_ASSET_BUSY",
            `Source asset ${assetId} is ${current.status} and cannot be removed safely`,
          );
      }
      await this.db
        .update(sourceAssets)
        .set({ status: "cancelled", error: null, updatedAt: new Date() })
        .where(
          and(
            eq(sourceAssets.workspaceId, workspaceId),
            eq(sourceAssets.id, assetId),
          ),
        );
      if (current && options.afterTaskFenced) {
        await options.afterTaskFenced(current);
      }
    }
    return this.deleteAssetRows(workspaceId, [asset]);
  }

  async deleteExpiredUploads(before: Date, limit = 500) {
    const stale = await this.db
      .select()
      .from(sourceAssets)
      .where(
        and(
          inArray(sourceAssets.status, ["awaiting_upload", "uploaded"]),
          lt(sourceAssets.updatedAt, before),
        ),
      )
      .orderBy(sourceAssets.updatedAt)
      .limit(
        Number.isFinite(limit)
          ? Math.min(Math.max(Math.trunc(limit), 1), 500)
          : 500,
      );
    const byWorkspace = new Map<string, SourceAssetRow[]>();
    for (const asset of stale) {
      const rows = byWorkspace.get(asset.workspaceId) ?? [];
      rows.push(asset);
      byWorkspace.set(asset.workspaceId, rows);
    }
    let sourceAssetCount = 0;
    let artifactCount = 0;
    for (const [workspaceId, assets] of byWorkspace) {
      const deleted = await this.deleteAssetRows(workspaceId, assets);
      sourceAssetCount += deleted.source_assets;
      artifactCount += deleted.artifacts;
    }
    return {
      source_assets: sourceAssetCount,
      artifacts: artifactCount,
    };
  }

  async deleteExpiredFailures(before: Date, limit = 500) {
    const stale = await this.db
      .select()
      .from(sourceAssets)
      .where(
        and(
          eq(sourceAssets.status, "failed"),
          lt(sourceAssets.updatedAt, before),
        ),
      )
      .orderBy(sourceAssets.updatedAt)
      .limit(
        Number.isFinite(limit)
          ? Math.min(Math.max(Math.trunc(limit), 1), 500)
          : 500,
      );
    let sourceAssetCount = 0;
    let artifactCount = 0;
    for (const asset of stale) {
      try {
        const deleted = await this.deleteUpload(asset.workspaceId, asset.id);
        sourceAssetCount += deleted.source_assets;
        artifactCount += deleted.artifacts;
      } catch (error) {
        if (
          error instanceof DocumentIngestionError &&
          error.code === "SOURCE_ASSET_BUSY"
        ) {
          continue;
        }
        throw error;
      }
    }
    return {
      source_assets: sourceAssetCount,
      artifacts: artifactCount,
    };
  }

  async putContent(
    workspaceId: string,
    assetId: string,
    bytes: Uint8Array,
    now = new Date(),
  ) {
    const asset = await this.requireAsset(workspaceId, assetId);
    if (bytes.byteLength > MAX_DOCUMENT_UPLOAD_BYTES) {
      throw new DocumentIngestionError(
        413,
        "DOCUMENT_UPLOAD_TOO_LARGE",
        `Document uploads must be at most ${MAX_DOCUMENT_UPLOAD_BYTES} bytes`,
      );
    }
    if (bytes.byteLength !== asset.sizeBytes) {
      throw new DocumentIngestionError(
        409,
        "DOCUMENT_UPLOAD_SIZE_MISMATCH",
        `Uploaded ${bytes.byteLength} bytes; expected ${asset.sizeBytes}`,
      );
    }
    const checksumSha256 = await sha256Hex(bytes);
    if (
      asset.expectedChecksumSha256 &&
      asset.expectedChecksumSha256 !== checksumSha256
    ) {
      throw new DocumentIngestionError(
        409,
        "DOCUMENT_UPLOAD_CHECKSUM_MISMATCH",
        "Uploaded bytes do not match checksum_sha256",
      );
    }
    if (asset.status !== "awaiting_upload" && asset.status !== "uploaded") {
      throw new DocumentIngestionError(
        409,
        "DOCUMENT_UPLOAD_IMMUTABLE",
        `Source asset ${assetId} is ${asset.status} and can no longer be replaced`,
      );
    }
    if (
      asset.status === "uploaded" &&
      asset.checksumSha256 !== checksumSha256
    ) {
      throw new DocumentIngestionError(
        409,
        "DOCUMENT_UPLOAD_IMMUTABLE",
        `Source asset ${assetId} already contains different bytes`,
      );
    }
    await this.objects.put(asset.storageKey, bytes, {
      contentType: asset.mimeType,
      checksumSha256,
    });
    await this.db
      .update(sourceAssets)
      .set({
        status: "uploaded",
        checksumSha256,
        error: null,
        uploadedAt: asset.uploadedAt ?? now,
        updatedAt: now,
      })
      .where(
        and(
          eq(sourceAssets.id, assetId),
          eq(sourceAssets.workspaceId, workspaceId),
        ),
      );
    return shapeSourceAsset(await this.requireAsset(workspaceId, assetId));
  }

  async complete(
    workspaceId: string,
    assetId: string,
    now = new Date(),
    options: { taskPayload?: Record<string, unknown> } = {},
  ) {
    let asset = await this.requireAsset(workspaceId, assetId);
    if (!asset.operationTaskId) {
      throw new Error(`source asset has no operation task: ${assetId}`);
    }
    const operationTaskId = asset.operationTaskId;
    if (options.taskPayload && Object.keys(options.taskPayload).length) {
      const currentTask = await this.requireTask(workspaceId, operationTaskId);
      await this.db
        .update(operationTasks)
        .set({
          payload: { ...currentTask.payload, ...options.taskPayload },
          updatedAt: now,
        })
        .where(
          and(
            eq(operationTasks.documentId, operationTaskId),
            eq(operationTasks.workspaceId, workspaceId),
          ),
        );
    }
    if (
      ["queued", "processing", "ready", "failed"].includes(asset.status)
    ) {
      const currentTask = await this.requireTask(
        workspaceId,
        asset.operationTaskId,
      );
      return {
        source_asset: shapeSourceAsset(asset),
        operation: shapeTask(currentTask),
      };
    }
    if (asset.status !== "uploaded" || !asset.checksumSha256) {
      throw new DocumentIngestionError(
        409,
        "DOCUMENT_UPLOAD_INCOMPLETE",
        "Upload the complete source bytes before starting extraction",
      );
    }
    const stored = await this.objects.head(asset.storageKey);
    if (!stored) {
      throw new DocumentIngestionError(
        409,
        "DOCUMENT_UPLOAD_MISSING",
        "Uploaded source bytes are missing",
      );
    }
    assertStoredObjectMatches(
      asset.storageKey,
      stored,
      asset.sizeBytes,
      asset.checksumSha256,
    );
    await this.db
      .update(sourceAssets)
      .set({ status: "queued", error: null, updatedAt: now })
      .where(
        and(
          eq(sourceAssets.id, assetId),
          eq(sourceAssets.workspaceId, workspaceId),
          eq(sourceAssets.status, "uploaded"),
        ),
      );
    await this.db
      .update(operationTasks)
      .set({
        status: "pending",
        nextAttemptAt: now,
        leaseExpiresAt: null,
        error: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(operationTasks.documentId, operationTaskId),
          eq(operationTasks.workspaceId, workspaceId),
          eq(operationTasks.status, "awaiting_upload"),
        ),
      );
    asset = await this.requireAsset(workspaceId, assetId);
    const task = await this.requireTask(workspaceId, operationTaskId);
    return {
      source_asset: shapeSourceAsset(asset),
      operation: shapeTask(task),
    };
  }

  private async requireAsset(workspaceId: string, assetId: string) {
    const asset = await this.db
      .select()
      .from(sourceAssets)
      .where(
        and(
          eq(sourceAssets.id, assetId),
          eq(sourceAssets.workspaceId, workspaceId),
        ),
      )
      .get();
    if (!asset) {
      throw new DocumentIngestionError(
        404,
        "SOURCE_ASSET_NOT_FOUND",
        "Source asset not found",
      );
    }
    return asset;
  }

  private async requireTask(workspaceId: string, taskId: string) {
    const task = await this.db
      .select()
      .from(operationTasks)
      .where(
        and(
          eq(operationTasks.workspaceId, workspaceId),
          eq(operationTasks.documentId, taskId),
        ),
      )
      .get();
    if (!task) throw new Error(`document extraction task missing: ${taskId}`);
    return task;
  }

  private async deleteAssetRows(
    workspaceId: string,
    assets: SourceAssetRow[],
  ) {
    if (!assets.length) return { source_assets: 0, artifacts: 0 };
    let artifactCount = 0;
    for (let offset = 0; offset < assets.length; offset += 100) {
      const batch = assets.slice(offset, offset + 100);
      const assetIds = batch.map((asset) => asset.id);
      const taskIds = batch
        .map((asset) => asset.operationTaskId)
        .filter((id): id is string => Boolean(id));
      if (taskIds.length) {
        await this.db
          .delete(operationTasks)
          .where(
            and(
              eq(operationTasks.workspaceId, workspaceId),
              inArray(operationTasks.documentId, taskIds),
            ),
          );
      }
      const artifacts = await this.db
        .select()
        .from(extractionArtifacts)
        .where(
          and(
            eq(extractionArtifacts.workspaceId, workspaceId),
            inArray(extractionArtifacts.sourceAssetId, assetIds),
          ),
        );
      artifactCount += artifacts.length;
      await Promise.all([
        ...batch.map((asset) => this.objects.delete(asset.storageKey)),
        ...artifacts.flatMap((artifact) => [
          this.objects.delete(artifact.contentKey),
          this.objects.delete(artifact.structureKey),
        ]),
      ]);
      await this.db
        .delete(extractionArtifacts)
        .where(
          and(
            eq(extractionArtifacts.workspaceId, workspaceId),
            inArray(extractionArtifacts.sourceAssetId, assetIds),
          ),
        );
      await this.db
        .delete(sourceAssets)
        .where(
          and(
            eq(sourceAssets.workspaceId, workspaceId),
            inArray(sourceAssets.id, assetIds),
          ),
        );
    }
    return {
      source_assets: assets.length,
      artifacts: artifactCount,
    };
  }
}

export async function processDocumentExtractionTask(
  db: AppDb,
  memory: Pick<Memory, "forNamespace">,
  objects: DocumentObjectStore,
  extractor: DocumentExtractor,
  task: OperationTask,
  accounting?: DocumentExtractionAccounting,
) {
  const assetId =
    typeof task.payload.sourceAssetId === "string"
      ? task.payload.sourceAssetId
      : "";
  if (!assetId) throw new Error("document extraction task has no sourceAssetId");
  let asset = await db
    .select()
    .from(sourceAssets)
    .where(
      and(
        eq(sourceAssets.id, assetId),
        eq(sourceAssets.workspaceId, task.workspaceId),
      ),
    )
    .get();
  if (!asset) throw new Error(`source asset missing: ${assetId}`);
  if (asset.status === "ready" && asset.ingestedDocumentId) {
    return extractionResult(db, asset);
  }
  if (
    !["queued", "processing", "failed"].includes(asset.status) ||
    !asset.checksumSha256
  ) {
    throw new Error(`source asset ${assetId} is not ready for extraction`);
  }
  await db
    .update(sourceAssets)
    .set({ status: "processing", error: null, updatedAt: new Date() })
    .where(eq(sourceAssets.id, assetId));

  let ingestAuthorization: unknown;
  let ingestAuthorized = false;
  try {
    const original = await objects.get(asset.storageKey);
    if (!original) throw new Error(`source asset bytes missing: ${assetId}`);
    assertStoredObjectMatches(
      asset.storageKey,
      original,
      asset.sizeBytes,
      asset.checksumSha256,
    );

    let artifact = await db
      .select()
      .from(extractionArtifacts)
      .where(
        and(
          eq(extractionArtifacts.sourceAssetId, assetId),
          eq(extractionArtifacts.extractor, extractor.name),
          eq(extractionArtifacts.extractorVersion, extractor.version),
        ),
      )
      .get();
    let markdown: string;
    if (artifact) {
      const storedContent = await objects.get(artifact.contentKey);
      if (
        storedContent &&
        storedContent.checksumSha256 === artifact.contentHash
      ) {
        markdown = decodeUtf8(storedContent.bytes, "extraction artifact");
      } else {
        artifact = undefined;
        markdown = "";
      }
    } else {
      markdown = "";
    }

    if (!artifact) {
      const extracted = await extractor.extract({
        bytes: original.bytes,
        filename: asset.filename,
        mediaType: asset.mimeType,
      });
      const markdownBytes = new TextEncoder().encode(extracted.markdown);
      if (!extracted.markdown.trim()) {
        throw new Error("document extraction produced blank content");
      }
      if (markdownBytes.byteLength > MAX_DOCUMENT_SOURCE_BYTES) {
        throw new DocumentIngestionError(
          413,
          "EXTRACTED_DOCUMENT_TOO_LARGE",
          `Extracted content exceeds ${MAX_DOCUMENT_SOURCE_BYTES} UTF-8 bytes`,
        );
      }
      if (extracted.pageCount > MAX_DOCUMENT_UPLOAD_PAGES) {
        throw new DocumentIngestionError(
          413,
          "DOCUMENT_PAGE_LIMIT_EXCEEDED",
          `Documents may contain at most ${MAX_DOCUMENT_UPLOAD_PAGES} pages`,
        );
      }
      const structureBytes = new TextEncoder().encode(
        JSON.stringify(extracted.structure),
      );
      const contentHash = await sha256Hex(markdownBytes);
      const structureHash = await sha256Hex(structureBytes);
      const artifactId = await deterministicId(
        "artifact",
        `${assetId}\0${asset.checksumSha256}\0${extractor.name}\0${extractor.version}`,
      );
      const contentKey = artifactObjectKey(
        task.workspaceId,
        artifactId,
        "content.md",
      );
      const structureKey = artifactObjectKey(
        task.workspaceId,
        artifactId,
        "structure.json",
      );
      await Promise.all([
        objects.put(contentKey, markdownBytes, {
          contentType: "text/markdown",
          checksumSha256: contentHash,
        }),
        objects.put(structureKey, structureBytes, {
          contentType: "application/json",
          checksumSha256: structureHash,
        }),
      ]);
      const [created] = await db
        .insert(extractionArtifacts)
        .values({
          id: artifactId,
          documentId: artifactId,
          workspaceId: task.workspaceId,
          sourceAssetId: assetId,
          extractor: extractor.name,
          extractorVersion: extractor.version,
          contentKey,
          structureKey,
          contentHash,
          sizeBytes: markdownBytes.byteLength,
          pageCount: extracted.pageCount,
          createdAt: new Date(),
        })
        .onConflictDoNothing()
        .returning();
      artifact =
        created ??
        (await db
          .select()
          .from(extractionArtifacts)
          .where(
            and(
              eq(extractionArtifacts.sourceAssetId, assetId),
              eq(extractionArtifacts.extractor, extractor.name),
              eq(extractionArtifacts.extractorVersion, extractor.version),
            ),
          )
          .get());
      if (!artifact) {
        throw new Error(`extraction artifact insert failed: ${artifactId}`);
      }
      if (
        artifact.contentHash !== contentHash ||
        artifact.sizeBytes !== markdownBytes.byteLength
      ) {
        throw new Error(`extraction artifact collision: ${artifact.id}`);
      }
      markdown = extracted.markdown;
    }

    if (accounting) {
      ingestAuthorization = await accounting.authorizeIngest({
        task,
        sourceAsset: shapeSourceAsset(asset),
        artifact: shapeArtifact(artifact),
        projectedChunks: Math.max(1, chunkDocumentText(markdown).length),
      });
      ingestAuthorized = true;
    }
    const application = new MemoryApplication(memory);
    const ingested = await application.ingestDocument(
      task.workspaceId,
      {
        source_key: asset.sourceKey,
        content: markdown,
        title: asset.title ?? asset.filename,
        mime_type: "text/markdown",
        source_uri: asset.sourceUri ?? undefined,
        metadata: asset.metadata ?? undefined,
        user_id: asset.userId ?? undefined,
        agent_id: asset.agentId ?? undefined,
        run_id: asset.runId ?? undefined,
      },
      `document-extract:${artifact.id}`,
    );
    if (accounting && ingestAuthorized) {
      await accounting.settleIngest({
        authorization: ingestAuthorization,
        outcome: "success",
      });
    }
    const completedAt = new Date();
    await db
      .update(extractionArtifacts)
      .set({ ingestedDocumentId: ingested.document.id })
      .where(eq(extractionArtifacts.id, artifact.id));
    await db
      .update(sourceAssets)
      .set({
        status: "ready",
        artifactId: artifact.id,
        ingestedDocumentId: ingested.document.id,
        error: null,
        updatedAt: completedAt,
      })
      .where(eq(sourceAssets.id, assetId));
    asset = (await db
      .select()
      .from(sourceAssets)
      .where(eq(sourceAssets.id, assetId))
      .get())!;
    return {
      source_asset: shapeSourceAsset(asset),
      artifact: shapeArtifact({
        ...artifact,
        ingestedDocumentId: ingested.document.id,
      }),
      document: ingested.document,
      chunks: ingested.chunks,
      created: ingested.created,
      retrieval: {
        status: "propagating" as const,
        visibility_target_ms: DOCUMENT_QUERY_VISIBILITY_TARGET_MS,
      },
    };
  } catch (error) {
    if (accounting && ingestAuthorized) {
      try {
        await accounting.settleIngest({
          authorization: ingestAuthorization,
          outcome: "failed",
        });
      } catch (settlementError) {
        console.error(
          "Failed to release document indexing authorization",
          settlementError,
        );
      }
    }
    await db
      .update(sourceAssets)
      .set({
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        updatedAt: new Date(),
      })
      .where(eq(sourceAssets.id, assetId));
    throw error;
  }
}

export async function createDocumentIngestion(db: AppDb) {
  return new DocumentIngestion(db, await runtimeObjectStore());
}

export async function createDocumentExtractionDependencies(taskId: string) {
  const env = await getRuntimeEnv();
  const objects = await runtimeObjectStore(env);
  if (IS_CLOUDFLARE) {
    const binding = env.DOCUMENT_EXTRACTOR as unknown as {
      getByName(name: string): {
        fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
      };
    };
    if (!binding?.getByName) {
      throw new Error("DOCUMENT_EXTRACTOR container binding is required");
    }
    const pool = `extractor-${stableShard(taskId, 3)}`;
    const stub = binding.getByName(pool);
    return {
      objects,
      extractor: new DoclingDocumentExtractor(
        (url, init) => stub.fetch(url, init),
        "http://container",
      ),
    };
  }
  const endpoint =
    (env as unknown as { FISHMEM_EXTRACTOR_URL?: string })
      .FISHMEM_EXTRACTOR_URL ??
    process.env.FISHMEM_EXTRACTOR_URL ??
    "http://127.0.0.1:5001";
  return {
    objects,
    extractor: new DoclingDocumentExtractor(
      (url, init) => fetch(url, init),
      endpoint,
    ),
  };
}

async function runtimeObjectStore(
  provided?: Awaited<ReturnType<typeof getRuntimeEnv>>,
) {
  const env = provided ?? (await getRuntimeEnv());
  if (IS_CLOUDFLARE) return new R2DocumentObjectStore(env.R2);
  const root =
    (env as unknown as { FISHMEM_ASSET_DIR?: string }).FISHMEM_ASSET_DIR ??
    process.env.FISHMEM_ASSET_DIR ??
    ".data/assets";
  return new LocalDocumentObjectStore(root);
}

async function extractionResult(db: AppDb, asset: SourceAssetRow) {
  const artifact = asset.artifactId
    ? await db
        .select()
        .from(extractionArtifacts)
        .where(eq(extractionArtifacts.id, asset.artifactId))
        .get()
    : undefined;
  return {
    source_asset: shapeSourceAsset(asset),
    artifact: artifact ? shapeArtifact(artifact) : null,
    document: asset.ingestedDocumentId
      ? { id: asset.ingestedDocumentId }
      : null,
    retrieval: {
      status: "propagating" as const,
      visibility_target_ms: DOCUMENT_QUERY_VISIBILITY_TARGET_MS,
    },
  };
}

export function shapeSourceAsset(asset: SourceAssetRow) {
  if (!asset.operationTaskId) {
    throw new Error(`source asset has no operation: ${asset.id}`);
  }
  return {
    id: asset.id,
    operation_id: asset.operationTaskId,
    source_key: asset.sourceKey,
    filename: asset.filename,
    content_type: asset.mimeType,
    size_bytes: asset.sizeBytes,
    checksum_sha256: asset.checksumSha256 ?? null,
    status: asset.status as
      | "awaiting_upload"
      | "uploaded"
      | "queued"
      | "processing"
      | "ready"
      | "failed"
      | "cancelled",
    title: asset.title ?? null,
    source_uri: asset.sourceUri ?? null,
    user_id: asset.userId ?? null,
    agent_id: asset.agentId ?? null,
    run_id: asset.runId ?? null,
    metadata: asset.metadata ?? null,
    artifact_id: asset.artifactId ?? null,
    document_id: asset.ingestedDocumentId ?? null,
    error: asset.error ?? null,
    uploaded_at: asset.uploadedAt?.toISOString() ?? null,
    created_at: asset.createdAt.toISOString(),
    updated_at: asset.updatedAt.toISOString(),
  };
}

export function shapeTask(task: typeof operationTasks.$inferSelect) {
  return {
    id: task.documentId,
    kind: task.kind,
    status: task.status,
    attempts: task.attempts,
    max_attempts: task.maxAttempts,
    error: task.error ?? null,
    next_attempt_at: task.nextAttemptAt?.toISOString() ?? null,
    result: task.result ?? null,
    created_at: task.createdAt.toISOString(),
    updated_at: task.updatedAt.toISOString(),
  };
}

function shapeArtifact(artifact: ExtractionArtifactRow) {
  return {
    id: artifact.id,
    source_asset_id: artifact.sourceAssetId,
    extractor: artifact.extractor,
    extractor_version: artifact.extractorVersion,
    content_hash: artifact.contentHash,
    size_bytes: artifact.sizeBytes,
    page_count: artifact.pageCount,
    document_id: artifact.ingestedDocumentId ?? null,
    created_at: artifact.createdAt.toISOString(),
  };
}

function parseCreateCommand(body: unknown) {
  try {
    return CreateDocumentUploadCommandSchema.parse(body);
  } catch (error) {
    const size =
      asRecord(body) && typeof asRecord(body)?.size_bytes === "number"
        ? asRecord(body)!.size_bytes
        : undefined;
    if (typeof size === "number" && size > MAX_DOCUMENT_UPLOAD_BYTES) {
      throw new DocumentIngestionError(
        413,
        "DOCUMENT_UPLOAD_TOO_LARGE",
        `Document uploads must be at most ${MAX_DOCUMENT_UPLOAD_BYTES} bytes`,
      );
    }
    throw error;
  }
}

function assertCreateReplay(
  asset: SourceAssetRow,
  command: CreateDocumentUploadCommand & {
    content_type: string;
    checksum_sha256?: string;
    source_key: string;
  },
) {
  const prior = stableJson({
    source_key: asset.sourceKey,
    filename: asset.filename,
    content_type: asset.mimeType,
    size_bytes: asset.sizeBytes,
    checksum_sha256: asset.expectedChecksumSha256 ?? undefined,
    title: asset.title ?? undefined,
    source_uri: asset.sourceUri ?? undefined,
    metadata: asset.metadata ?? undefined,
    user_id: asset.userId ?? undefined,
    agent_id: asset.agentId ?? undefined,
    run_id: asset.runId ?? undefined,
  });
  const next = stableJson(command);
  if (prior !== next) {
    throw new DocumentIngestionError(
      409,
      "IDEMPOTENCY_CONFLICT",
      "Idempotency-Key was already used for a different document upload",
    );
  }
}

function assertSupportedMediaType(value: string) {
  const mediaType = normalizeMediaType(value);
  if (
    mediaType.startsWith("text/") ||
    mediaType.endsWith("+json") ||
    mediaType.endsWith("+xml") ||
    SUPPORTED_UPLOAD_MEDIA_TYPES.has(mediaType)
  ) {
    return;
  }
  throw new DocumentIngestionError(
    415,
    "UNSUPPORTED_DOCUMENT_MEDIA_TYPE",
    `Unsupported document media type: ${mediaType}`,
  );
}

function normalizeMediaType(value: string) {
  return value.split(";", 1)[0]!.trim().toLowerCase();
}

function sourceObjectKey(workspaceId: string, assetId: string) {
  return `source-assets/v1/${encodeURIComponent(workspaceId)}/${encodeURIComponent(
    assetId,
  )}/original`;
}

function artifactObjectKey(
  workspaceId: string,
  artifactId: string,
  filename: string,
) {
  return `extraction-artifacts/v1/${encodeURIComponent(
    workspaceId,
  )}/${encodeURIComponent(artifactId)}/${filename}`;
}

function assertStoredObjectMatches(
  key: string,
  object: StoredObjectHead,
  expectedSize: number,
  expectedChecksum: string,
) {
  if (
    object.size !== expectedSize ||
    object.checksumSha256 !== expectedChecksum
  ) {
    throw new DocumentIngestionError(
      409,
      "DOCUMENT_OBJECT_COLLISION",
      `Stored document object does not match immutable metadata: ${key}`,
    );
  }
}

function parseStructure(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return parseStructure(JSON.parse(value));
    } catch {
      throw new Error("Docling returned invalid JSON structure");
    }
  }
  const record = asRecord(value);
  if (!record) throw new Error("Docling returned no JSON structure");
  return record;
}

function documentPageCount(structure: Record<string, unknown>) {
  const pages = structure.pages;
  if (Array.isArray(pages)) return Math.max(1, pages.length);
  const record = asRecord(pages);
  return record ? Math.max(1, Object.keys(record).length) : 1;
}

function compactErrors(value: unknown) {
  if (!Array.isArray(value) || !value.length) return "no error details";
  return value
    .slice(0, 3)
    .map((entry) =>
      typeof entry === "string" ? entry : JSON.stringify(entry),
    )
    .join("; ")
    .slice(0, 1_000);
}

function compactTaskError(payload: Record<string, unknown> | null) {
  const message = payload?.error_message;
  return typeof message === "string" && message.trim()
    ? `: ${message.trim().slice(0, 1_000)}`
    : "";
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function decodeUtf8(bytes: Uint8Array, label: string) {
  try {
    return new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function deterministicId(prefix: string, seed: string) {
  const hash = await sha256Hex(new TextEncoder().encode(seed));
  return `${prefix}_${hash.slice(0, 40)}`;
}

async function sha256Hex(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function stableShard(value: string, count: number) {
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % count;
}

function isNodeError(error: unknown, code: string) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
