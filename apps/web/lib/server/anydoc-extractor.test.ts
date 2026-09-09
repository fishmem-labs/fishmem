import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  AnyDocDocumentExtractor,
  AnyDocUnsupportedError,
  CONTAINER_EXTRACTION_CAPABILITY,
  FallbackDocumentExtractor,
  IN_PROCESS_EXTRACTION_CAPABILITY,
  PlainTextDocumentExtractor,
  type AnyDocModule,
} from "./anydoc-extractor";
import type { DocumentExtractor, ExtractedDocument } from "./document-ingestion";

/**
 * Load the converter exactly the way a Worker does: compile the artifact into
 * a `WebAssembly.Module` and hand it to the synchronous initialiser.
 */
async function loadRealAnyDoc(): Promise<AnyDocModule> {
  const require = createRequire(import.meta.url);
  const glue = require.resolve("@firecrawl/anydoc-wasm");
  const wasm = new WebAssembly.Module(
    readFileSync(join(dirname(glue), "anydoc_wasm_bg.wasm")),
  );
  const module = await import(glue);
  module.initSync({ module: wasm });
  return module as AnyDocModule;
}

/** A minimal but structurally valid .docx package. */
function docxFixture(paragraphs: string[]): Uint8Array {
  const body = paragraphs
    .map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`)
    .join("");
  const files: Array<[string, string]> = [
    [
      "[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    ],
    [
      "_rels/.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    ],
    [
      "word/document.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    ],
  ];
  return zipStore(files);
}

/** Stored (uncompressed) ZIP writer — enough for a valid OOXML package. */
function zipStore(files: Array<[string, string]>): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: number[] = [];
  const central: number[] = [];
  let offset = 0;

  const push = (target: number[], ...bytes: number[]) => target.push(...bytes);
  const u16 = (value: number) => [value & 0xff, (value >> 8) & 0xff];
  const u32 = (value: number) => [
    value & 0xff,
    (value >> 8) & 0xff,
    (value >> 16) & 0xff,
    (value >> 24) & 0xff,
  ];

  for (const [name, content] of files) {
    const nameBytes = encoder.encode(name);
    const data = encoder.encode(content);
    const crc = crc32(data);
    const local = [
      ...u32(0x04034b50),
      ...u16(20),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(crc),
      ...u32(data.length),
      ...u32(data.length),
      ...u16(nameBytes.length),
      ...u16(0),
      ...nameBytes,
      ...data,
    ];
    push(chunks, ...local);
    push(
      central,
      ...u32(0x02014b50),
      ...u16(20),
      ...u16(20),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(crc),
      ...u32(data.length),
      ...u32(data.length),
      ...u16(nameBytes.length),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(offset),
      ...nameBytes,
    );
    offset += local.length;
  }

  const end = [
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(files.length),
    ...u16(files.length),
    ...u32(central.length),
    ...u32(offset),
    ...u16(0),
  ];
  return Uint8Array.from([...chunks, ...central, ...end]);
}

function crc32(data: Uint8Array): number {
  let crc = ~0;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

describe("in-process document extraction", () => {
  let anydoc: AnyDocModule;
  let extractor: AnyDocDocumentExtractor;

  beforeAll(async () => {
    anydoc = await loadRealAnyDoc();
    extractor = new AnyDocDocumentExtractor(async () => anydoc);
  });

  it("converts a real Office document to Markdown without leaving the process", async () => {
    const result = await extractor.extract({
      bytes: docxFixture([
        "Memory retention policy",
        "Customer records are retained for 24 months.",
      ]),
      filename: "policy.docx",
      mediaType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });

    expect(result.markdown).toContain("Memory retention policy");
    expect(result.markdown).toContain("retained for 24 months");
    expect(result.structure.format).toBe("docx");
    expect(result.pageCount).toBe(1);
  });

  it("converts tabular sources to Markdown tables", async () => {
    const result = await extractor.extract({
      bytes: new TextEncoder().encode("plan,credits\nstarter,126000\n"),
      filename: "plans.csv",
      mediaType: "text/csv",
    });

    expect(result.markdown).toContain("| plan | credits |");
    expect(result.markdown).toContain("| starter | 126000 |");
  });

  it("declines a PDF it cannot read so the OCR-capable extractor takes over", async () => {
    // Whatever goes wrong inside the converter — no text layer, or a file it
    // simply cannot parse — the answer must be a decline, because the
    // extractor behind it can still complete the job.
    const unreadablePdf = new TextEncoder().encode(
      "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
        "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n" +
        "trailer<</Root 1 0 R>>\n%%EOF",
    );

    const failure = await extractor
      .extract({
        bytes: unreadablePdf,
        filename: "scan.pdf",
        mediaType: "application/pdf",
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AnyDocUnsupportedError);
    // The underlying reason survives so the fallback log stays diagnosable.
    expect((failure as Error).message).toContain("scan.pdf");
  });

  it("only claims formats that are structured text containers", () => {
    expect(AnyDocDocumentExtractor.handles("a.docx", "")).toBe(true);
    expect(AnyDocDocumentExtractor.handles("a.pdf", "application/pdf")).toBe(true);
    // Images are pixels: they need OCR, never this path.
    expect(AnyDocDocumentExtractor.handles("scan.png", "image/png")).toBe(false);
    expect(AnyDocDocumentExtractor.handles("mail.eml", "message/rfc822")).toBe(
      false,
    );
  });

  it("routes a source too large for an isolate away before converting it", () => {
    // Conversion allocates several times the input in WebAssembly memory, and
    // exceeding the isolate's budget terminates it rather than raising an
    // error the fallback could catch — so the size check has to happen during
    // routing, not inside the converter.
    const big = 8 * 1024 * 1024;
    expect(AnyDocDocumentExtractor.handles("huge.docx", "", big)).toBe(false);
    expect(AnyDocDocumentExtractor.handles("small.docx", "", 1024)).toBe(true);
    // An unknown size must not silently opt a large file in.
    expect(AnyDocDocumentExtractor.handles("unknown.docx", "")).toBe(true);
  });

  it("declines an oversized source even if routing let it through", async () => {
    const failure = await extractor
      .extract({
        bytes: new Uint8Array(8 * 1024 * 1024),
        filename: "huge.docx",
        mediaType: "",
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AnyDocUnsupportedError);
    expect((failure as Error).message).toContain("in-process ceiling");
  });
});

describe("extraction fallback", () => {
  const extracted: ExtractedDocument = {
    markdown: "# from the container",
    structure: {},
    pageCount: 3,
  };

  function stub(name: string, behaviour: () => Promise<ExtractedDocument>) {
    return {
      name,
      version: `${name}@1`,
      extract: vi.fn(behaviour),
    } satisfies DocumentExtractor & { extract: ReturnType<typeof vi.fn> };
  }

  const input = {
    bytes: new Uint8Array([1]),
    filename: "scan.pdf",
    mediaType: "application/pdf",
  };

  it("uses the container only when the in-process extractor declines", async () => {
    const primary = stub("anydoc", async () => {
      throw new AnyDocUnsupportedError("needs OCR");
    });
    const fallback = stub("docling", async () => extracted);
    const onFallback = vi.fn();

    const result = await new FallbackDocumentExtractor(
      primary,
      fallback,
      () => true,
      onFallback,
    ).extract(input);

    expect(result).toEqual(extracted);
    expect(fallback.extract).toHaveBeenCalledOnce();
    expect(onFallback).toHaveBeenCalledWith("needs OCR", "scan.pdf");
  });

  it("never reaches the container for a format handled in process", async () => {
    const primary = stub("anydoc", async () => extracted);
    const fallback = stub("docling", async () => extracted);

    await new FallbackDocumentExtractor(primary, fallback, () => true).extract(
      input,
    );

    expect(primary.extract).toHaveBeenCalledOnce();
    expect(fallback.extract).not.toHaveBeenCalled();
  });

  it("propagates a real primary failure instead of masking it with a retry", async () => {
    const primary = stub("anydoc", async () => {
      throw new Error("out of memory");
    });
    const fallback = stub("docling", async () => extracted);

    await expect(
      new FallbackDocumentExtractor(primary, fallback, () => true).extract(input),
    ).rejects.toThrow("out of memory");
    expect(fallback.extract).not.toHaveBeenCalled();
  });

  it("identifies itself distinctly so cached artifacts are not confused", () => {
    const pair = new FallbackDocumentExtractor(
      stub("anydoc", async () => extracted),
      stub("docling", async () => extracted),
      () => true,
    );

    expect(pair.name).not.toBe("anydoc");
    expect(pair.name).not.toBe("docling");
    expect(pair.version).toBe("anydoc@1|docling@1");
  });
});

describe("already-textual sources", () => {
  const extractor = new PlainTextDocumentExtractor();

  it("passes text through byte-for-byte rather than reformatting it", async () => {
    const source = '{"plan":"starter","credits":120000}';
    const result = await extractor.extract({
      bytes: new TextEncoder().encode(source),
      filename: "plans.json",
      mediaType: "application/json",
    });

    // Re-serialising would change content a caller may be relying on.
    expect(result.markdown).toBe(source);
  });

  it("claims text media types and nothing else", () => {
    for (const type of [
      "text/plain",
      "text/markdown",
      "application/json",
      "application/xml",
      "application/yaml",
      "message/rfc822",
      "application/ld+json",
      "image/svg+xml",
    ]) {
      expect(PlainTextDocumentExtractor.handles("f", type), type).toBe(true);
    }
    for (const type of ["image/png", "application/pdf", "application/msword"]) {
      expect(PlainTextDocumentExtractor.handles("f", type), type).toBe(false);
    }
  });

  it("refuses binary mislabelled as text instead of storing mojibake", async () => {
    await expect(
      extractor.extract({
        bytes: new Uint8Array([0xff, 0xfe, 0x00, 0x80, 0x9f]),
        filename: "image.json",
        mediaType: "application/json",
      }),
    ).rejects.toBeInstanceOf(AnyDocUnsupportedError);
  });
});

describe("advertised extraction capability", () => {
  it("excludes images when no OCR-capable extractor is configured", () => {
    for (const type of [
      "image/png",
      "image/jpeg",
      "image/tiff",
      "image/bmp",
      "image/webp",
    ]) {
      // An upload that cannot be converted must be refused at the door, not
      // accepted, stored, billed, and failed asynchronously.
      expect(IN_PROCESS_EXTRACTION_CAPABILITY.mediaTypes.has(type), type).toBe(
        false,
      );
      expect(CONTAINER_EXTRACTION_CAPABILITY.mediaTypes.has(type), type).toBe(
        true,
      );
    }
  });

  it("advertises every format the in-process converters actually read", () => {
    for (const type of [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/pdf",
      "application/epub+zip",
      "application/json",
      "message/rfc822",
    ]) {
      expect(IN_PROCESS_EXTRACTION_CAPABILITY.mediaTypes.has(type), type).toBe(
        true,
      );
    }
  });

  it("advertises a size ceiling an isolate can actually convert", () => {
    expect(IN_PROCESS_EXTRACTION_CAPABILITY.maxSourceBytes).toBeLessThan(
      CONTAINER_EXTRACTION_CAPABILITY.maxSourceBytes,
    );
    // Measured: a 10 MB source already needs 140 MB of WebAssembly memory
    // against an isolate's 128 MB budget.
    expect(IN_PROCESS_EXTRACTION_CAPABILITY.maxSourceBytes).toBeLessThan(
      10 * 1024 * 1024,
    );
  });
});
