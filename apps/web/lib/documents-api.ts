import type {
  CompleteDocumentUploadResponseWire,
  CreateDocumentUploadResponseWire,
  DeleteDocumentResponseWire,
  DocumentContentWire,
  DocumentSearchHitWire,
  DocumentWire,
  IngestDocumentResponseWire,
  SourceAssetWire,
} from "@fishmem/contracts";
import { apiFetch } from "@/lib/api";

export type DocumentRow = DocumentWire;
export type DocumentSearchHit = DocumentSearchHitWire;
export type SourceAssetRow = SourceAssetWire;

function documentQuery(
  params: Record<string, string | number | null | undefined>,
) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      search.set(key, String(value));
    }
  }
  return search.toString();
}

export async function fetchDocuments(
  jwt: string,
  params: {
    workspace?: string | null;
    query?: string;
    source_key?: string;
    cursor?: string;
    limit?: number;
  },
) {
  const query = documentQuery(params);
  return apiFetch<{
    results: DocumentRow[];
    next_cursor: string | null;
  }>(`/api/documents${query ? `?${query}` : ""}`, { jwt });
}

export async function fetchAllDocuments(
  jwt: string,
  params: { workspace?: string | null; source_key?: string },
) {
  const results: DocumentRow[] = [];
  let cursor: string | undefined;
  do {
    const page = await fetchDocuments(jwt, {
      ...params,
      cursor,
      limit: 100,
    });
    results.push(...page.results);
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return results;
}

export async function searchDocuments(
  jwt: string,
  params: {
    workspace?: string | null;
    query: string;
    source_key?: string;
    limit?: number;
    neighbors?: number;
  },
) {
  const query = documentQuery(params);
  const response = await apiFetch<{ results: DocumentSearchHit[] }>(
    `/api/documents?${query}`,
    { jwt },
  );
  return response.results;
}

export async function fetchDocumentUploads(
  jwt: string,
  workspace?: string | null,
) {
  const query = documentQuery({ workspace, limit: 100 });
  const response = await apiFetch<{ data: SourceAssetRow[] }>(
    `/api/document-uploads${query ? `?${query}` : ""}`,
    { jwt },
  );
  return response.data;
}

export async function deleteDocumentUpload(
  jwt: string,
  assetId: string,
  workspace?: string | null,
) {
  const query = documentQuery({ workspace });
  const response = await apiFetch<{
    data: { source_assets: number; artifacts: number };
  }>(
    `/api/document-uploads/${encodeURIComponent(assetId)}${
      query ? `?${query}` : ""
    }`,
    { jwt, method: "DELETE" },
  );
  return response.data;
}

export async function ingestDocument(
  jwt: string,
  input: {
    workspace?: string | null;
    source_key: string;
    content: string;
    title?: string;
    mime_type?: string;
    source_uri?: string;
    metadata?: Record<string, unknown>;
  },
) {
  const response = await apiFetch<{ data: IngestDocumentResponseWire }>(
    "/api/documents",
    {
      jwt,
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify(input),
    },
  );
  return response.data;
}

export async function uploadDocumentFile(
  jwt: string,
  input: {
    workspace?: string | null;
    file: File;
    source_key?: string;
    title?: string;
    mime_type?: string;
    source_uri?: string;
    metadata?: Record<string, unknown>;
  },
) {
  if (!input.file.size) throw new Error("Source files must not be empty");
  const bytes = new Uint8Array(await input.file.arrayBuffer());
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
  );
  const checksum = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const query = documentQuery({ workspace: input.workspace });
  const idempotencyKey = crypto.randomUUID();
  const created = await apiFetch<{ data: CreateDocumentUploadResponseWire }>(
    `/api/document-uploads${query ? `?${query}` : ""}`,
    {
      jwt,
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({
        filename: input.file.name,
        size_bytes: input.file.size,
        content_type:
          input.mime_type || input.file.type || "application/octet-stream",
        checksum_sha256: checksum,
        source_key: input.source_key || input.file.name,
        title: input.title || input.file.name,
        ...(input.source_uri ? { source_uri: input.source_uri } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      }),
    },
  );
  const assetId = created.data.source_asset.id;
  await apiFetch<void>(
    `/api/document-uploads/${encodeURIComponent(assetId)}/content${
      query ? `?${query}` : ""
    }`,
    {
      jwt,
      method: "PUT",
      headers: {
        "Content-Type":
          created.data.upload.headers["content-type"] ??
          input.mime_type ??
          input.file.type ??
          "application/octet-stream",
      },
      body: input.file,
    },
  );
  const completed = await apiFetch<{
    data: CompleteDocumentUploadResponseWire;
  }>(
    `/api/document-uploads/${encodeURIComponent(assetId)}/complete${
      query ? `?${query}` : ""
    }`,
    { jwt, method: "POST" },
  );
  return completed.data;
}

export async function fetchDocumentContent(
  jwt: string,
  documentId: string,
  workspace?: string | null,
) {
  const query = documentQuery({ workspace });
  const response = await apiFetch<{ data: DocumentContentWire }>(
    `/api/documents/${encodeURIComponent(documentId)}/content${
      query ? `?${query}` : ""
    }`,
    { jwt },
  );
  return response.data;
}

export async function deleteDocument(
  jwt: string,
  documentId: string,
  workspace?: string | null,
) {
  const query = documentQuery({ workspace });
  const response = await apiFetch<{ data: DeleteDocumentResponseWire }>(
    `/api/documents/${encodeURIComponent(documentId)}${
      query ? `?${query}` : ""
    }`,
    {
      jwt,
      method: "DELETE",
      headers: { "Idempotency-Key": crypto.randomUUID() },
    },
  );
  return response.data;
}
