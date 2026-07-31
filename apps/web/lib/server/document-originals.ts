import type {
  DocumentOriginalDescriptor,
  DocumentOriginalStore,
  DocumentSource,
} from "fishmem";

const ROOT_PREFIX = "documents/v1/";
const DELETE_BATCH_SIZE = 1_000;

function namespacePrefix(namespaceId: string) {
  return `${ROOT_PREFIX}${encodeURIComponent(namespaceId)}/`;
}

function objectKey(namespaceId: string, documentId: string) {
  return `${namespacePrefix(namespaceId)}${encodeURIComponent(documentId)}`;
}

function hex(bytes: ArrayBuffer | ArrayBufferView) {
  const view =
    bytes instanceof ArrayBuffer
      ? new Uint8Array(bytes)
      : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return [...view]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256(bytes: Uint8Array) {
  return crypto.subtle.digest(
    "SHA-256",
    bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
  );
}

/**
 * Cloudflare R2 adapter for exact UTF-8 document originals.
 *
 * Object keys are private implementation details derived from structural
 * namespace + immutable document id. D1 remains the descriptor/chunk store;
 * callers can only read an object after the document corpus fences ownership.
 */
export class R2DocumentOriginalStore implements DocumentOriginalStore {
  constructor(private readonly bucket: R2Bucket) {
    if (!bucket) throw new Error("R2 binding is required for document originals");
  }

  async put(source: DocumentSource): Promise<void> {
    const bytes = new TextEncoder().encode(source.content);
    const digest = await sha256(bytes);
    if (hex(digest) !== source.contentHash || bytes.byteLength !== source.sizeBytes) {
      throw new Error(`document original integrity mismatch: ${source.id}`);
    }
    const key = objectKey(source.namespaceId, source.id);
    const existing = await this.bucket.head(key);
    if (existing) {
      if (
        existing.size !== source.sizeBytes ||
        existing.customMetadata?.contentHash !== source.contentHash
      ) {
        throw new Error(`document original id collision: ${source.id}`);
      }
      return;
    }
    await this.bucket.put(key, bytes, {
      httpMetadata: { contentType: source.mimeType },
      customMetadata: {
        contentHash: source.contentHash,
        versionHash: source.versionHash,
      },
      sha256: digest,
    });
  }

  async get(source: DocumentOriginalDescriptor): Promise<string> {
    const object = await this.bucket.get(
      objectKey(source.namespaceId, source.id),
    );
    if (!object) throw new Error(`document original missing: ${source.id}`);
    if (
      object.size !== source.sizeBytes ||
      object.customMetadata?.contentHash !== source.contentHash
    ) {
      throw new Error(`document original integrity mismatch: ${source.id}`);
    }
    const bytes = await object.arrayBuffer();
    try {
      return new TextDecoder("utf-8", {
        fatal: true,
        // Body.text() strips a leading UTF-8 BOM. Originals are byte-exact, so
        // decode the R2 bytes explicitly and preserve it as U+FEFF.
        ignoreBOM: true,
      }).decode(bytes);
    } catch {
      throw new Error(`document original invalid UTF-8: ${source.id}`);
    }
  }

  async delete(namespaceId: string, documentIds: string[]): Promise<void> {
    const keys = [
      ...new Set(
        documentIds.map((documentId) => objectKey(namespaceId, documentId)),
      ),
    ];
    for (let offset = 0; offset < keys.length; offset += DELETE_BATCH_SIZE) {
      await this.bucket.delete(keys.slice(offset, offset + DELETE_BATCH_SIZE));
    }
  }

  deleteNamespace(namespaceId: string): Promise<void> {
    return this.deletePrefix(namespacePrefix(namespaceId));
  }

  clear(): Promise<void> {
    return this.deletePrefix(ROOT_PREFIX);
  }

  private async deletePrefix(prefix: string): Promise<void> {
    while (true) {
      const page = await this.bucket.list({
        prefix,
        limit: DELETE_BATCH_SIZE,
      });
      if (!page.objects.length) return;
      await this.bucket.delete(page.objects.map((object) => object.key));
    }
  }
}
