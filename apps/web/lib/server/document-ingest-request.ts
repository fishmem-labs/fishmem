import {
  IngestDocumentCommandSchema,
  MAX_DOCUMENT_SOURCE_BYTES,
  type IngestDocumentCommand,
} from "@fishmem/contracts";
import { MemoryApplicationError } from "@fishmem/application";

type Scope = {
  user_id?: string;
  agent_id?: string;
  run_id?: string;
};

export type ParsedDocumentIngestRequest = {
  command: IngestDocumentCommand;
  workspace?: string;
};

const DOCUMENT_MIME_BY_EXTENSION: Record<string, string> = {
  css: "text/css",
  csv: "text/csv",
  go: "text/plain",
  htm: "text/html",
  html: "text/html",
  ini: "text/plain",
  java: "text/plain",
  js: "text/javascript",
  json: "application/json",
  jsonl: "application/json",
  jsx: "text/javascript",
  log: "text/plain",
  markdown: "text/markdown",
  md: "text/markdown",
  py: "text/x-python",
  rs: "text/plain",
  sh: "text/x-shellscript",
  sql: "text/plain",
  toml: "application/toml",
  ts: "text/typescript",
  tsv: "text/tab-separated-values",
  tsx: "text/typescript",
  txt: "text/plain",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
};

function requestError(code: string, message: string, status = 400): never {
  throw new MemoryApplicationError(code, message, status);
}

function mediaType(value: string | null | undefined) {
  return value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function isJsonMediaType(value: string) {
  return value === "application/json" || value.endsWith("+json");
}

function isSupportedDocumentMediaType(value: string) {
  return (
    value.startsWith("text/") ||
    value === "application/json" ||
    value.endsWith("+json") ||
    value === "application/xml" ||
    value.endsWith("+xml") ||
    value === "application/yaml" ||
    value === "application/x-yaml" ||
    value === "application/toml"
  );
}

function inferredMediaType(filename: string) {
  const extension = filename.toLowerCase().split(".").pop();
  return (extension && DOCUMENT_MIME_BY_EXTENSION[extension]) || "text/plain";
}

function hasScope(value: Record<string, unknown>) {
  return ["user_id", "agent_id", "run_id"].some(
    (key) => typeof value[key] === "string" && value[key].trim().length > 0,
  );
}

function withDefaultScope(
  value: Record<string, unknown>,
  defaultScope?: Scope,
) {
  if (hasScope(value) || !defaultScope) return value;
  return { ...value, ...defaultScope };
}

function workspaceFrom(value: Record<string, unknown>) {
  return typeof value.workspace === "string" && value.workspace.trim()
    ? value.workspace.trim()
    : undefined;
}

function stringField(form: FormData, name: string) {
  const values = form.getAll(name);
  if (!values.length) return undefined;
  if (values.length !== 1 || typeof values[0] !== "string") {
    return requestError(
      "INVALID_MULTIPART_FIELD",
      `${name} must be provided once as text`,
    );
  }
  return values[0];
}

function metadataField(form: FormData) {
  const source = stringField(form, "metadata");
  if (source === undefined || !source.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return requestError(
      "INVALID_DOCUMENT_METADATA",
      "metadata must be a JSON object",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return requestError(
      "INVALID_DOCUMENT_METADATA",
      "metadata must be a JSON object",
    );
  }
  return parsed as Record<string, unknown>;
}

function multipartFile(form: FormData) {
  const entries = form.getAll("file");
  if (
    entries.length !== 1 ||
    typeof entries[0] === "string" ||
    typeof entries[0]?.arrayBuffer !== "function"
  ) {
    return requestError(
      "DOCUMENT_FILE_REQUIRED",
      "multipart document ingestion requires exactly one file",
    );
  }
  return entries[0];
}

function resolvedFileMediaType(file: File, override?: string) {
  const declared = mediaType(file.type);
  if (
    declared &&
    declared !== "application/octet-stream" &&
    !isSupportedDocumentMediaType(declared)
  ) {
    return requestError(
      "UNSUPPORTED_DOCUMENT_MEDIA_TYPE",
      `Unsupported textual document media type: ${declared}`,
      415,
    );
  }

  const requested = mediaType(override);
  if (requested && !isSupportedDocumentMediaType(requested)) {
    return requestError(
      "UNSUPPORTED_DOCUMENT_MEDIA_TYPE",
      `Unsupported textual document media type: ${requested}`,
      415,
    );
  }
  return (
    requested ||
    (isSupportedDocumentMediaType(declared) ? declared : "") ||
    inferredMediaType(file.name)
  );
}

async function parseMultipart(
  request: Request,
  defaultScope?: Scope,
): Promise<ParsedDocumentIngestRequest> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return requestError(
      "INVALID_MULTIPART_BODY",
      "Could not parse multipart document upload",
    );
  }

  const file = multipartFile(form);
  if (file.size > MAX_DOCUMENT_SOURCE_BYTES) {
    return requestError(
      "DOCUMENT_TOO_LARGE",
      `Document files must be at most ${MAX_DOCUMENT_SOURCE_BYTES} UTF-8 bytes`,
      413,
    );
  }

  let content: string;
  try {
    content = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(await file.arrayBuffer());
  } catch {
    return requestError(
      "INVALID_UTF8",
      "Document files must contain valid UTF-8 text",
    );
  }

  const input = withDefaultScope(
    {
      source_key: stringField(form, "source_key") || file.name,
      content,
      title: stringField(form, "title") || file.name,
      mime_type: resolvedFileMediaType(
        file,
        stringField(form, "mime_type"),
      ),
      source_uri: stringField(form, "source_uri"),
      metadata: metadataField(form),
      user_id: stringField(form, "user_id"),
      agent_id: stringField(form, "agent_id"),
      run_id: stringField(form, "run_id"),
      workspace: stringField(form, "workspace"),
    },
    defaultScope,
  );

  return {
    command: IngestDocumentCommandSchema.parse(input),
    ...(workspaceFrom(input) ? { workspace: workspaceFrom(input) } : {}),
  };
}

async function parseJson(
  request: Request,
  defaultScope?: Scope,
): Promise<ParsedDocumentIngestRequest> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return requestError("INVALID_JSON_BODY", "Invalid JSON body");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return requestError("INVALID_JSON_BODY", "JSON body must be an object");
  }
  const input = withDefaultScope(
    body as Record<string, unknown>,
    defaultScope,
  );
  const workspace = workspaceFrom(input);
  return {
    command: IngestDocumentCommandSchema.parse(input),
    ...(workspace ? { workspace } : {}),
  };
}

export async function parseDocumentIngestRequest(
  request: Request,
  options: { defaultScope?: Scope } = {},
): Promise<ParsedDocumentIngestRequest> {
  const type = mediaType(request.headers.get("content-type"));
  if (type === "multipart/form-data") {
    return parseMultipart(request, options.defaultScope);
  }
  if (isJsonMediaType(type)) {
    return parseJson(request, options.defaultScope);
  }
  return requestError(
    "UNSUPPORTED_DOCUMENT_CONTENT_TYPE",
    "Use application/json or multipart/form-data for document ingestion",
    415,
  );
}
