from __future__ import annotations

import json
import hashlib
import mimetypes
from dataclasses import dataclass
from os import PathLike
from pathlib import Path
from typing import Any, BinaryIO, Mapping

MAX_DOCUMENT_SOURCE_BYTES = 1_000_000
MAX_DOCUMENT_UPLOAD_BYTES = 25_000_000
DocumentUploadSource = str | PathLike[str] | BinaryIO
JsonObject = dict[str, Any]

MIME_BY_EXTENSION = {
    ".bmp": "image/bmp",
    ".css": "text/css",
    ".csv": "text/csv",
    ".doc": "application/msword",
    ".docx": (
        "application/vnd.openxmlformats-officedocument."
        "wordprocessingml.document"
    ),
    ".eml": "message/rfc822",
    ".epub": "application/epub+zip",
    ".html": "text/html",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "text/javascript",
    ".json": "application/json",
    ".jsonl": "application/json",
    ".md": "text/markdown",
    ".odp": "application/vnd.oasis.opendocument.presentation",
    ".ods": "application/vnd.oasis.opendocument.spreadsheet",
    ".odt": "application/vnd.oasis.opendocument.text",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": (
        "application/vnd.openxmlformats-officedocument."
        "presentationml.presentation"
    ),
    ".py": "text/x-python",
    ".rtf": "application/rtf",
    ".sh": "text/x-shellscript",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".toml": "application/toml",
    ".ts": "text/typescript",
    ".tsv": "text/tab-separated-values",
    ".txt": "text/plain",
    ".webp": "image/webp",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": (
        "application/vnd.openxmlformats-officedocument."
        "spreadsheetml.sheet"
    ),
    ".xml": "application/xml",
    ".yaml": "application/yaml",
    ".yml": "application/yaml",
}


def _guess_media_type(filename: str, fallback: str) -> str:
    return (
        MIME_BY_EXTENSION.get(Path(filename).suffix.lower())
        or mimetypes.guess_type(filename)[0]
        or fallback
    )


@dataclass(frozen=True)
class PreparedDocumentUpload:
    content: bytes
    text: str
    filename: str
    media_type: str
    fields: dict[str, str]
    command: JsonObject


@dataclass(frozen=True)
class PreparedApiDocumentUpload:
    content: bytes
    filename: str
    media_type: str
    command: JsonObject


def _read_source(source: DocumentUploadSource) -> tuple[bytes, str | None]:
    if isinstance(source, (str, PathLike)):
        path = Path(source)
        return path.read_bytes(), path.name
    value = source.read()
    if isinstance(value, str):
        content = value.encode("utf-8")
    elif isinstance(value, bytes):
        content = value
    else:
        raise TypeError("documents.upload file objects must return bytes or text")
    name = getattr(source, "name", None)
    return content, Path(name).name if isinstance(name, str) and name else None


def prepare_document_upload(
    source: DocumentUploadSource,
    input: Mapping[str, Any],
    *,
    filename: str | None = None,
) -> PreparedDocumentUpload:
    content, source_filename = _read_source(source)
    if len(content) > MAX_DOCUMENT_SOURCE_BYTES:
        raise ValueError(
            f"Document files must be at most {MAX_DOCUMENT_SOURCE_BYTES} bytes"
        )
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError as cause:
        raise ValueError(
            "Document files must contain valid UTF-8 text"
        ) from cause

    source_key_value = input.get("source_key")
    source_key = (
        str(source_key_value).strip()
        if isinstance(source_key_value, str)
        else ""
    )
    upload_filename = (
        (filename or "").strip()
        or source_filename
        or Path(source_key).name
        or "document.txt"
    )
    source_key = source_key or upload_filename
    requested_media_type = input.get("mime_type")
    media_type = (
        str(requested_media_type).strip()
        if isinstance(requested_media_type, str)
        and requested_media_type.strip()
        else _guess_media_type(upload_filename, "text/plain")
    )

    fields: dict[str, str] = {
        "source_key": source_key,
        "mime_type": media_type,
    }
    command: JsonObject = {
        "source_key": source_key,
        "content": text,
        "title": input.get("title") or upload_filename,
        "mime_type": media_type,
    }
    for key in ("title", "source_uri", "user_id", "agent_id", "run_id"):
        value = input.get(key)
        if isinstance(value, str) and value:
            fields[key] = value
            command[key] = value
    metadata = input.get("metadata")
    if metadata is not None:
        fields["metadata"] = json.dumps(
            metadata,
            ensure_ascii=False,
            separators=(",", ":"),
        )
        command["metadata"] = metadata

    return PreparedDocumentUpload(
        content=content,
        text=text,
        filename=upload_filename,
        media_type=media_type,
        fields=fields,
        command=command,
    )


def prepare_api_document_upload(
    source: DocumentUploadSource,
    input: Mapping[str, Any],
    *,
    filename: str | None = None,
) -> PreparedApiDocumentUpload:
    content, source_filename = _read_source(source)
    if not content:
        raise ValueError("Document files must not be empty")
    if len(content) > MAX_DOCUMENT_UPLOAD_BYTES:
        raise ValueError(
            f"Document files must be at most {MAX_DOCUMENT_UPLOAD_BYTES} bytes"
        )
    source_key_value = input.get("source_key")
    source_key = (
        str(source_key_value).strip()
        if isinstance(source_key_value, str)
        else ""
    )
    upload_filename = (
        (filename or "").strip()
        or source_filename
        or Path(source_key).name
        or "document.bin"
    )
    source_key = source_key or upload_filename
    requested_media_type = input.get("mime_type")
    media_type = (
        str(requested_media_type).split(";", 1)[0].strip().lower()
        if isinstance(requested_media_type, str)
        and requested_media_type.strip()
        else _guess_media_type(upload_filename, "application/octet-stream")
    )
    command: JsonObject = {
        "filename": upload_filename,
        "size_bytes": len(content),
        "content_type": media_type,
        "checksum_sha256": hashlib.sha256(content).hexdigest(),
        "source_key": source_key,
        "title": input.get("title") or upload_filename,
    }
    for key in ("source_uri", "user_id", "agent_id", "run_id"):
        value = input.get(key)
        if isinstance(value, str) and value:
            command[key] = value
    metadata = input.get("metadata")
    if metadata is not None:
        command["metadata"] = metadata
    return PreparedApiDocumentUpload(
        content=content,
        filename=upload_filename,
        media_type=media_type,
        command=command,
    )
