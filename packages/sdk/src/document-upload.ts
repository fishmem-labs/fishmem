import type {
  IngestDocumentInput,
  UploadDocumentInput,
} from "./types.js";

const MAX_DOCUMENT_SOURCE_BYTES = 1_000_000;
const MAX_DOCUMENT_UPLOAD_BYTES = 25_000_000;

const MIME_BY_EXTENSION: Record<string, string> = {
  bmp: "image/bmp",
  css: "text/css",
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  eml: "message/rfc822",
  epub: "application/epub+zip",
  html: "text/html",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript",
  json: "application/json",
  jsonl: "application/json",
  jsx: "text/javascript",
  markdown: "text/markdown",
  md: "text/markdown",
  odp: "application/vnd.oasis.opendocument.presentation",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odt: "application/vnd.oasis.opendocument.text",
  pdf: "application/pdf",
  png: "image/png",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  py: "text/x-python",
  rtf: "application/rtf",
  sh: "text/x-shellscript",
  tif: "image/tiff",
  tiff: "image/tiff",
  toml: "application/toml",
  ts: "text/typescript",
  tsv: "text/tab-separated-values",
  tsx: "text/typescript",
  txt: "text/plain",
  webp: "image/webp",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
};

function filenameOf(input: UploadDocumentInput) {
  const fileName =
    input.filename?.trim() ||
    (typeof (input.file as Blob & { name?: unknown }).name === "string"
      ? String((input.file as Blob & { name: string }).name).trim()
      : "") ||
    input.source_key?.split(/[\\/]/).pop()?.trim() ||
    "document.txt";
  return fileName || "document.txt";
}

function sourceKeyOf(input: UploadDocumentInput, filename: string) {
  return input.source_key?.trim() || filename;
}

function inferredMimeType(
  filename: string,
  fallback = "text/plain",
) {
  const extension = filename.toLowerCase().split(".").pop();
  return (extension && MIME_BY_EXTENSION[extension]) || fallback;
}

export async function prepareApiDocumentUpload(input: UploadDocumentInput) {
  if (!(input.file instanceof Blob)) {
    throw new TypeError("documents.upload requires a Blob or File");
  }
  if (input.file.size > MAX_DOCUMENT_UPLOAD_BYTES) {
    throw new RangeError(
      `Document files must be at most ${MAX_DOCUMENT_UPLOAD_BYTES} bytes`,
    );
  }
  if (input.file.size === 0) {
    throw new RangeError("Document files must not be empty");
  }
  const filename = filenameOf(input);
  const mediaType =
    input.mime_type ||
    input.file.type.split(";", 1)[0]?.trim().toLowerCase() ||
    inferredMimeType(filename, "application/octet-stream");
  const bytes = new Uint8Array(await input.file.arrayBuffer());
  const checksum = await crypto.subtle.digest(
    "SHA-256",
    bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
  );
  const checksumSha256 = [...new Uint8Array(checksum)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return {
    file: input.file,
    mediaType,
    command: {
      filename,
      size_bytes: input.file.size,
      content_type: mediaType,
      checksum_sha256: checksumSha256,
      source_key: sourceKeyOf(input, filename),
      title: input.title ?? filename,
      ...(input.source_uri ? { source_uri: input.source_uri } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      ...(input.user_id ? { user_id: input.user_id } : {}),
      ...(input.agent_id ? { agent_id: input.agent_id } : {}),
      ...(input.run_id ? { run_id: input.run_id } : {}),
    },
  };
}

function append(
  form: FormData,
  key: string,
  value: string | undefined,
) {
  if (value !== undefined && value !== "") form.set(key, value);
}

export function createDocumentUploadForm(input: UploadDocumentInput) {
  if (!(input.file instanceof Blob)) {
    throw new TypeError("documents.upload requires a Blob or File");
  }
  if (input.file.size > MAX_DOCUMENT_SOURCE_BYTES) {
    throw new RangeError(
      `Document files must be at most ${MAX_DOCUMENT_SOURCE_BYTES} bytes`,
    );
  }
  const filename = filenameOf(input);
  const form = new FormData();
  form.set("file", input.file, filename);
  form.set("source_key", sourceKeyOf(input, filename));
  append(form, "title", input.title);
  append(form, "mime_type", input.mime_type);
  append(form, "source_uri", input.source_uri);
  append(form, "user_id", input.user_id);
  append(form, "agent_id", input.agent_id);
  append(form, "run_id", input.run_id);
  if (input.metadata !== undefined) {
    form.set("metadata", JSON.stringify(input.metadata));
  }
  return form;
}

export async function documentUploadCommand(
  input: UploadDocumentInput,
): Promise<IngestDocumentInput> {
  if (!(input.file instanceof Blob)) {
    throw new TypeError("documents.upload requires a Blob or File");
  }
  if (input.file.size > MAX_DOCUMENT_SOURCE_BYTES) {
    throw new RangeError(
      `Document files must be at most ${MAX_DOCUMENT_SOURCE_BYTES} bytes`,
    );
  }
  const filename = filenameOf(input);
  let content: string;
  try {
    content = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(await input.file.arrayBuffer());
  } catch {
    throw new TypeError("Document files must contain valid UTF-8 text");
  }
  return {
    source_key: sourceKeyOf(input, filename),
    content,
    title: input.title ?? filename,
    mime_type:
      input.mime_type ||
      input.file.type.split(";", 1)[0]?.trim().toLowerCase() ||
      inferredMimeType(filename),
    ...(input.source_uri ? { source_uri: input.source_uri } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    ...(input.user_id ? { user_id: input.user_id } : {}),
    ...(input.agent_id ? { agent_id: input.agent_id } : {}),
    ...(input.run_id ? { run_id: input.run_id } : {}),
  };
}
