import type { DocumentSource } from "../types.js";

export type DocumentOriginalDescriptor = Omit<DocumentSource, "content">;

/**
 * Optional object-storage seam for exact document originals.
 *
 * The document corpus remains the only writer. Implementations must make
 * `put` idempotent for a document id, return the exact UTF-8 source from
 * `get`, and make every delete operation safe to replay.
 */
export interface DocumentOriginalStore {
  put(source: DocumentSource): Promise<void>;
  get(source: DocumentOriginalDescriptor): Promise<string>;
  delete(namespaceId: string, documentIds: string[]): Promise<void>;
  deleteNamespace(namespaceId: string): Promise<void>;
  clear(): Promise<void>;
}
