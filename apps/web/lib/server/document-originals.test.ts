import type { DocumentSource } from "fishmem";
import { describe, expect, it } from "vitest";
import { R2DocumentOriginalStore } from "./document-originals";

type StoredObject = {
  bytes: Uint8Array;
  customMetadata?: Record<string, string>;
  httpMetadata?: R2HTTPMetadata;
};

class FakeR2Bucket {
  readonly objects = new Map<string, StoredObject>();
  puts = 0;

  private metadata(key: string, value: StoredObject) {
    return {
      key,
      size: value.bytes.byteLength,
      customMetadata: value.customMetadata,
      httpMetadata: value.httpMetadata,
    };
  }

  async head(key: string) {
    const value = this.objects.get(key);
    return value ? (this.metadata(key, value) as R2Object) : null;
  }

  async get(key: string) {
    const value = this.objects.get(key);
    if (!value) return null;
    return {
      ...this.metadata(key, value),
      arrayBuffer: async () =>
        value.bytes.buffer.slice(
          value.bytes.byteOffset,
          value.bytes.byteOffset + value.bytes.byteLength,
        ) as ArrayBuffer,
      text: async () => new TextDecoder().decode(value.bytes),
    } as R2ObjectBody;
  }

  async put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | string,
    options?: R2PutOptions,
  ) {
    this.puts += 1;
    const bytes =
      typeof value === "string"
        ? new TextEncoder().encode(value)
        : value instanceof ArrayBuffer
          ? new Uint8Array(value)
          : new Uint8Array(
              value.buffer,
              value.byteOffset,
              value.byteLength,
            );
    const stored = {
      bytes: new Uint8Array(bytes),
      customMetadata: options?.customMetadata,
      httpMetadata:
        options?.httpMetadata instanceof Headers
          ? undefined
          : options?.httpMetadata,
    };
    this.objects.set(key, stored);
    return this.metadata(key, stored) as R2Object;
  }

  async delete(keys: string | string[]) {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      this.objects.delete(key);
    }
  }

  async list(options?: R2ListOptions) {
    const prefix = options?.prefix ?? "";
    const limit = options?.limit ?? 1_000;
    const objects = [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .slice(0, limit)
      .map(([key, value]) => this.metadata(key, value) as R2Object);
    return { objects, delimitedPrefixes: [], truncated: false } as R2Objects;
  }
}

async function source(
  namespaceId: string,
  id: string,
  content: string,
): Promise<DocumentSource> {
  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
  );
  const contentHash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return {
    id,
    namespaceId,
    sourceKey: `${id}.txt`,
    contentHash,
    versionHash: contentHash,
    content,
    mimeType: "text/plain",
    sizeBytes: bytes.byteLength,
    createdAt: new Date("2026-07-30T00:00:00.000Z"),
  };
}

describe("R2DocumentOriginalStore", () => {
  it("writes immutable UTF-8 originals and replays idempotently", async () => {
    const bucket = new FakeR2Bucket();
    const store = new R2DocumentOriginalStore(
      bucket as unknown as R2Bucket,
    );
    const document = await source("workspace", "doc-1", "原文 evidence");

    await store.put(document);
    await store.put(document);

    expect(bucket.puts).toBe(1);
    await expect(store.get(document)).resolves.toBe(document.content);
  });

  it("preserves a UTF-8 BOM instead of applying Body.text semantics", async () => {
    const bucket = new FakeR2Bucket();
    const store = new R2DocumentOriginalStore(
      bucket as unknown as R2Bucket,
    );
    const document = await source(
      "workspace",
      "doc-bom",
      "\uFEFF# Exact source\r\n中文 🐟\r\n",
    );

    await store.put(document);

    await expect(store.get(document)).resolves.toBe(document.content);
  });

  it("deletes exact ids, namespaces, and only the owned root prefix", async () => {
    const bucket = new FakeR2Bucket();
    const store = new R2DocumentOriginalStore(
      bucket as unknown as R2Bucket,
    );
    const first = await source("workspace-a", "doc-1", "first");
    const second = await source("workspace-b", "doc-2", "second");
    await store.put(first);
    await store.put(second);
    bucket.objects.set("unrelated/file", {
      bytes: new TextEncoder().encode("keep"),
    });

    await store.delete("workspace-a", [first.id]);
    await expect(store.get(first)).rejects.toThrow("original missing");
    await expect(store.get(second)).resolves.toBe("second");

    await store.clear();
    expect(bucket.objects.has("unrelated/file")).toBe(true);
    await expect(store.get(second)).rejects.toThrow("original missing");
  });
});
