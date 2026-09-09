import type {
  DocumentExtractor,
  ExtractedDocument,
} from "@/lib/server/document-ingestion";

export const ANYDOC_EXTRACTOR_NAME = "anydoc";
export const ANYDOC_EXTRACTOR_VERSION = "anydoc-wasm@0.2.4";

/**
 * The subset of the anydoc WebAssembly module this extractor uses. Declared
 * structurally so the module can be supplied by the runtime that knows how to
 * load WebAssembly there, rather than being imported at every call site.
 */
export type AnyDocModule = {
  formatFromBytes(bytes: Uint8Array): string | undefined;
  formatFromExtension(extension: string): string | undefined;
  toMarkdownBytes(bytes: Uint8Array, format?: string | null): string;
};

/**
 * Formats anydoc reads from the container structure itself. A PDF is handled
 * separately: anydoc extracts embedded text but performs no OCR, so a scanned
 * page yields nothing and must go to the OCR-capable extractor instead.
 */
const TEXTUAL_FORMATS = new Set([
  "docx",
  "doc",
  "docm",
  "xlsx",
  "xls",
  "xlsm",
  "pptx",
  "ppt",
  "rtf",
  "odt",
  "ods",
  "odp",
  "epub",
  "csv",
]);

/** A PDF's text layer must clear this before the result is trusted. */
const MIN_PDF_MARKDOWN_CHARS = 32;

/**
 * Largest source this converter will take in process.
 *
 * Conversion allocates WebAssembly memory well in excess of the input, and the
 * decoded markdown lands in the isolate too. Measured on real documents:
 *
 *   3.4 MB in ->  5.4 MB markdown,  39 MB wasm, 192 ms
 *  10.3 MB in -> 16.2 MB markdown, 140 MB wasm, 561 ms
 *  24.2 MB in -> 37.9 MB markdown, 243 MB wasm, 1363 ms
 *
 * An isolate has 128 MB, so anything much past a few megabytes exhausts it —
 * and exhausting it terminates the isolate rather than raising an error the
 * fallback could catch. The ceiling is set well below the first measurement
 * that exceeded the budget, leaving room for the source bytes, the markdown,
 * and the rest of the request.
 */
const MAX_IN_PROCESS_SOURCE_BYTES = 4 * 1024 * 1024;

export class AnyDocUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnyDocUnsupportedError";
  }
}

/**
 * Turn any converter failure into a decline.
 *
 * The extractor this one sits in front of is strictly more capable — it reads
 * the same formats and OCRs the ones without a text layer. So a file this
 * converter cannot parse is not a failed document, it is a document for the
 * other extractor. Answering "I cannot read this" costs one slower extraction;
 * answering with an error would fail work the previous architecture completed.
 */
function decline<T>(filename: string, run: () => T): T {
  try {
    return run();
  } catch (error) {
    throw new AnyDocUnsupportedError(
      `anydoc could not read ${filename}: ${(error as Error).message}`,
    );
  }
}

/**
 * In-process document extraction.
 *
 * The container-based extractor is a network hop to a process that must be
 * running, which costs both latency and billed instance time even for a
 * spreadsheet that parses in a millisecond. This runs the same conversion
 * inside the request isolate for every format that is genuinely a structured
 * text container, and refuses anything it cannot read faithfully so the caller
 * can fall back rather than store an empty document.
 */
export class AnyDocDocumentExtractor implements DocumentExtractor {
  readonly name = ANYDOC_EXTRACTOR_NAME;
  readonly version = ANYDOC_EXTRACTOR_VERSION;

  constructor(private readonly load: () => Promise<AnyDocModule>) {}

  /**
   * Whether this extractor should be attempted for a given file at all.
   *
   * Size is part of the question, not a detail: a source too large to convert
   * inside an isolate must be routed away before conversion starts, because
   * running out of memory kills the isolate instead of failing in a way the
   * fallback can catch.
   */
  static handles(filename: string, mediaType: string, byteLength = 0): boolean {
    if (byteLength > MAX_IN_PROCESS_SOURCE_BYTES) return false;
    const extension = filename.split(".").pop()?.toLowerCase() ?? "";
    if (TEXTUAL_FORMATS.has(extension)) return true;
    if (extension === "pdf" || mediaType === "application/pdf") return true;
    return false;
  }

  async extract(input: {
    bytes: Uint8Array;
    filename: string;
    mediaType: string;
  }): Promise<ExtractedDocument> {
    const startedAt = Date.now();
    if (input.bytes.byteLength > MAX_IN_PROCESS_SOURCE_BYTES) {
      throw new AnyDocUnsupportedError(
        `${input.filename} is ${input.bytes.byteLength} bytes, above the ` +
          `${MAX_IN_PROCESS_SOURCE_BYTES}-byte in-process ceiling`,
      );
    }
    const anydoc = await this.load();

    const extension = input.filename.split(".").pop()?.toLowerCase() ?? "";
    const format = decline(input.filename, () => {
      return (
        anydoc.formatFromBytes(input.bytes) ??
        anydoc.formatFromExtension(extension)
      );
    });
    if (!format) {
      throw new AnyDocUnsupportedError(
        `anydoc could not identify ${input.filename} (${input.mediaType})`,
      );
    }

    const markdown = decline(input.filename, () =>
      anydoc.toMarkdownBytes(input.bytes, format),
    );
    const trimmed = markdown.trim();
    if (!trimmed) {
      throw new AnyDocUnsupportedError(
        `anydoc produced no content for ${input.filename}`,
      );
    }
    // A PDF whose pages are images has no text layer to extract. Too little
    // text is the signal that this file needs OCR, not that it is empty.
    if (format === "pdf" && trimmed.length < MIN_PDF_MARKDOWN_CHARS) {
      throw new AnyDocUnsupportedError(
        `anydoc found no usable text layer in ${input.filename}; it likely needs OCR`,
      );
    }

    return {
      markdown,
      structure: { format, source: ANYDOC_EXTRACTOR_VERSION },
      pageCount: estimatePageCount(trimmed, format),
      processingTimeSeconds: (Date.now() - startedAt) / 1000,
    };
  }
}

/**
 * Try the in-process extractor first and fall back to a second one when it
 * declines. Only `AnyDocUnsupportedError` is a fallback signal: a genuine
 * failure inside the primary extractor propagates so it is not silently
 * masked by a slower path.
 */
export class FallbackDocumentExtractor implements DocumentExtractor {
  constructor(
    private readonly primary: DocumentExtractor,
    private readonly fallback: DocumentExtractor,
    private readonly shouldTryPrimary: (
      filename: string,
      mediaType: string,
      byteLength: number,
    ) => boolean,
    private readonly onFallback?: (reason: string, filename: string) => void,
  ) {}

  // The artifact cache is keyed by extractor identity, so the pair must name
  // itself distinctly from either member.
  readonly name = "anydoc+fallback";
  get version() {
    return `${this.primary.version}|${this.fallback.version}`;
  }

  async extract(input: {
    bytes: Uint8Array;
    filename: string;
    mediaType: string;
  }): Promise<ExtractedDocument> {
    if (
      this.shouldTryPrimary(
        input.filename,
        input.mediaType,
        input.bytes.byteLength,
      )
    ) {
      try {
        return await this.primary.extract(input);
      } catch (error) {
        if (!(error instanceof AnyDocUnsupportedError)) throw error;
        this.onFallback?.((error as Error).message, input.filename);
      }
    }
    return this.fallback.extract(input);
  }
}

/**
 * Page count is a reporting field, not a billing input — extraction is billed
 * on source bytes. Formats without pagination report one page.
 */
function estimatePageCount(markdown: string, format: string): number {
  if (format !== "pdf") return 1;
  const breaks = markdown.match(/\n---\n|\f/g)?.length ?? 0;
  return Math.max(1, breaks + 1);
}

export const PLAIN_TEXT_EXTRACTOR_NAME = "plain-text";
export const PLAIN_TEXT_EXTRACTOR_VERSION = "plain-text@1";

/**
 * Media types whose bytes are already the content.
 *
 * These never needed a converter at all — routing them to an out-of-process
 * document parser was only ever a consequence of having one extractor for
 * everything. Decoding them here costs a UTF-8 decode.
 */
const PLAIN_TEXT_MEDIA_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/yaml",
  "message/rfc822",
]);

function isPlainTextMediaType(mediaType: string) {
  return (
    mediaType.startsWith("text/") ||
    mediaType.endsWith("+json") ||
    mediaType.endsWith("+xml") ||
    PLAIN_TEXT_MEDIA_TYPES.has(mediaType)
  );
}

/**
 * Pass-through extractor for sources that are already text.
 *
 * It preserves the bytes rather than reformatting them: a JSON or YAML source
 * is most useful to later retrieval exactly as written, and re-serialising it
 * would change content the caller may be relying on.
 */
export class PlainTextDocumentExtractor implements DocumentExtractor {
  readonly name = PLAIN_TEXT_EXTRACTOR_NAME;
  readonly version = PLAIN_TEXT_EXTRACTOR_VERSION;

  static handles(filename: string, mediaType: string, byteLength = 0): boolean {
    if (byteLength > MAX_IN_PROCESS_SOURCE_BYTES) return false;
    return isPlainTextMediaType(mediaType);
  }

  async extract(input: {
    bytes: Uint8Array;
    filename: string;
    mediaType: string;
  }): Promise<ExtractedDocument> {
    const startedAt = Date.now();
    if (!isPlainTextMediaType(input.mediaType)) {
      throw new AnyDocUnsupportedError(
        `${input.mediaType} is not a text media type`,
      );
    }
    // `fatal` rejects mislabelled binary rather than storing replacement
    // characters that would look like successfully extracted content.
    let markdown: string;
    try {
      markdown = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes);
    } catch {
      throw new AnyDocUnsupportedError(
        `${input.filename} is labelled ${input.mediaType} but is not valid UTF-8`,
      );
    }
    if (!markdown.trim()) {
      throw new AnyDocUnsupportedError(`${input.filename} is empty`);
    }
    return {
      markdown,
      structure: { format: "text", source: PLAIN_TEXT_EXTRACTOR_VERSION },
      pageCount: 1,
      processingTimeSeconds: (Date.now() - startedAt) / 1000,
    };
  }
}

/**
 * What a deployment can actually convert.
 *
 * The accepted media types and the size ceiling are properties of the
 * configured extractor, not global constants: a deployment without an
 * OCR-capable extractor must reject a scanned page at upload rather than
 * accept it and fail asynchronously.
 */
export type ExtractionCapability = {
  mediaTypes: ReadonlySet<string>;
  maxSourceBytes: number;
};

/** Everything the in-process converters read. No OCR, no images. */
export const IN_PROCESS_EXTRACTION_CAPABILITY: ExtractionCapability = {
  mediaTypes: new Set([
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
    "message/rfc822",
  ]),
  maxSourceBytes: MAX_IN_PROCESS_SOURCE_BYTES,
};

/**
 * The wider set an OCR-capable extractor unlocks: images and scanned pages on
 * top of everything the in-process converters read.
 */
export const CONTAINER_EXTRACTION_CAPABILITY: ExtractionCapability = {
  mediaTypes: new Set([
    ...IN_PROCESS_EXTRACTION_CAPABILITY.mediaTypes,
    "image/bmp",
    "image/jpeg",
    "image/png",
    "image/tiff",
    "image/webp",
  ]),
  maxSourceBytes: 25_000_000,
};
