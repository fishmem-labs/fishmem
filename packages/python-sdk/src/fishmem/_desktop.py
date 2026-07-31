from __future__ import annotations

import json
import subprocess
from collections.abc import Callable, Iterator, Mapping, Sequence
from typing import Any

from ._document_upload import DocumentUploadSource, prepare_document_upload
from ._errors import FishMemDesktopError

JsonObject = dict[str, Any]
DesktopRunner = Callable[
    [Sequence[str], float, str | None], subprocess.CompletedProcess[str]
]


def _run(
    args: Sequence[str], timeout: float, stdin: str | None
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        check=False,
        capture_output=True,
        input=stdin,
        text=True,
        timeout=timeout,
        shell=False,
    )


def _with_idempotency(
    input: Mapping[str, Any], idempotency_key: str | None
) -> JsonObject:
    return {
        **input,
        **(
            {"idempotency_key": idempotency_key}
            if idempotency_key is not None
            else {}
        ),
    }

def _with_required_idempotency(
    input: Mapping[str, Any],
    idempotency_key: str,
    operation: str,
) -> JsonObject:
    if not isinstance(idempotency_key, str) or not idempotency_key.strip():
        raise ValueError(f"{operation} requires a non-empty idempotency_key")
    return {**input, "idempotency_key": idempotency_key.strip()}


def _memory_to_wire(memory: Mapping[str, Any]) -> JsonObject:
    return {
        "id": memory["id"],
        "memory": memory["content"],
        "memory_type": memory["memoryType"],
        "importance": memory["importance"],
        "user_id": memory.get("userId"),
        "agent_id": memory.get("agentId"),
        "run_id": memory.get("runId"),
        "metadata": memory.get("metadata"),
        "created_at": memory["createdAt"],
        "updated_at": memory["updatedAt"],
        "event_date": memory.get("eventDate"),
        "valid_from": memory.get("validFrom"),
        "valid_to": memory.get("validTo"),
        "subject": memory.get("subject"),
        "attribute": memory.get("attribute"),
        "superseded_by": memory.get("supersededBy"),
        "access_count": memory["accessCount"],
        "last_accessed_at": memory["lastAccessedAt"],
        **({"score": memory["score"]} if "score" in memory else {}),
    }


class DesktopMemories:
    def __init__(self, desktop: FishMemDesktop) -> None:
        self._desktop = desktop

    def add(
        self,
        input: Mapping[str, Any],
        *,
        idempotency_key: str | None = None,
    ) -> JsonObject:
        if input.get("infer") is True:
            raise ValueError(
                "FishMem Desktop accepts distilled records only; infer must be false"
            )
        if not isinstance(input.get("content"), str):
            raise ValueError("FishMem Desktop add requires content")
        return self._desktop.call(
            "add", _with_idempotency(input, idempotency_key)
        )

    def search(self, input: Mapping[str, Any]) -> JsonObject:
        result = self._desktop.call("search", input)
        return {
            **result,
            "results": [
                _memory_to_wire(memory)
                for memory in result.get("results", [])
            ]
        }

    def batch_update(
        self,
        memories: list[Mapping[str, Any]],
        *,
        idempotency_key: str,
    ) -> JsonObject:
        return self._desktop.call(
            "batchUpdate",
            _with_required_idempotency(
                {
                    "memories": [
                        dict(memory) for memory in memories
                    ]
                },
                idempotency_key,
                "memories.batch_update",
            ),
        )

    def batch_delete(
        self,
        memories: list[Mapping[str, Any]],
        *,
        idempotency_key: str,
    ) -> JsonObject:
        return self._desktop.call(
            "batchDelete",
            _with_required_idempotency(
                {
                    "memories": [
                        dict(memory) for memory in memories
                    ]
                },
                idempotency_key,
                "memories.batch_delete",
            ),
        )

    def list(
        self,
        scope: Mapping[str, Any],
        *,
        cursor: str | None = None,
        limit: int | None = None,
    ) -> JsonObject:
        result = self._desktop.call(
            "list",
            {
                **scope,
                **({"cursor": cursor} if cursor is not None else {}),
                **({"limit": limit} if limit is not None else {}),
            },
        )
        return {
            "results": [
                _memory_to_wire(memory)
                for memory in result.get("results", [])
            ],
            "next_cursor": result.get("nextCursor"),
        }

    def list_all(
        self,
        scope: Mapping[str, Any],
        *,
        limit: int | None = None,
    ) -> Iterator[JsonObject]:
        cursor: str | None = None
        while True:
            page = self.list(scope, cursor=cursor, limit=limit)
            yield from page["results"]
            cursor = page.get("next_cursor")
            if not cursor:
                return

    def get(self, memory_id: str) -> JsonObject:
        return _memory_to_wire(self._desktop.call("get", {"id": memory_id}))

    def update(
        self,
        memory_id: str,
        input: Mapping[str, Any],
        *,
        idempotency_key: str | None = None,
    ) -> JsonObject:
        return self._desktop.call(
            "update",
            _with_idempotency(
                {"id": memory_id, **input}, idempotency_key
            ),
        )

    def delete(
        self,
        memory_id: str,
        *,
        idempotency_key: str | None = None,
    ) -> JsonObject:
        return self._desktop.call(
            "delete",
            _with_idempotency({"id": memory_id}, idempotency_key),
        )

    def delete_all(
        self,
        scope: Mapping[str, Any],
        *,
        idempotency_key: str | None = None,
    ) -> JsonObject:
        return self._desktop.call(
            "deleteAll", _with_idempotency(scope, idempotency_key)
        )

    def history(self, memory_id: str) -> JsonObject:
        return self._desktop.call("history", {"id": memory_id})

    def get_feedback(self, memory_id: str) -> JsonObject:
        return self._desktop.call("getFeedback", {"id": memory_id})

    def set_feedback(
        self,
        memory_id: str,
        input: Mapping[str, Any],
        *,
        idempotency_key: str,
    ) -> JsonObject:
        return self._desktop.call(
            "setFeedback",
            _with_required_idempotency(
                {"id": memory_id, **dict(input)},
                idempotency_key,
                "memories.set_feedback",
            ),
        )

    def clear_feedback(
        self,
        memory_id: str,
        *,
        idempotency_key: str,
    ) -> JsonObject:
        return self._desktop.call(
            "clearFeedback",
            _with_required_idempotency(
                {"id": memory_id},
                idempotency_key,
                "memories.clear_feedback",
            ),
        )


class DesktopEntities:
    """Structural user, agent, and run scopes through the local CLI."""

    def __init__(self, desktop: FishMemDesktop) -> None:
        self._desktop = desktop

    def list(
        self,
        *,
        entity_type: str | None = None,
        cursor: str | None = None,
        limit: int | None = None,
    ) -> JsonObject:
        return self._desktop.call(
            "entityList",
            {
                **(
                    {"type": entity_type}
                    if entity_type is not None
                    else {}
                ),
                **({"cursor": cursor} if cursor is not None else {}),
                **({"limit": limit} if limit is not None else {}),
            },
        )

    def list_all(
        self,
        *,
        entity_type: str | None = None,
        limit: int | None = None,
    ) -> Iterator[JsonObject]:
        cursor: str | None = None
        while True:
            page = self.list(
                entity_type=entity_type,
                cursor=cursor,
                limit=limit,
            )
            yield from page.get("results", [])
            cursor = page.get("next_cursor")
            if not cursor:
                return

    def get(self, entity_type: str, entity_id: str) -> JsonObject:
        return self._desktop.call(
            "entityGet", {"type": entity_type, "id": entity_id}
        )

    def delete(
        self,
        entity_type: str,
        entity_id: str,
        *,
        idempotency_key: str,
    ) -> JsonObject:
        return self._desktop.call(
            "entityDelete",
            _with_required_idempotency(
                {"type": entity_type, "id": entity_id},
                idempotency_key,
                "entities.delete",
            ),
        )


class DesktopDocuments:
    def __init__(self, desktop: FishMemDesktop) -> None:
        self._desktop = desktop

    def ingest(
        self,
        input: Mapping[str, Any],
        *,
        idempotency_key: str | None = None,
    ) -> JsonObject:
        return self._desktop.call(
            "documentIngest", _with_idempotency(input, idempotency_key)
        )

    def upload(
        self,
        file: DocumentUploadSource,
        input: Mapping[str, Any],
        *,
        filename: str | None = None,
        idempotency_key: str | None = None,
    ) -> JsonObject:
        upload = prepare_document_upload(file, input, filename=filename)
        return self.ingest(
            upload.command,
            idempotency_key=idempotency_key,
        )

    def search(self, input: Mapping[str, Any]) -> JsonObject:
        return self._desktop.call("documentSearch", input)

    def list(
        self,
        input: Mapping[str, Any],
        *,
        cursor: str | None = None,
        limit: int | None = None,
    ) -> JsonObject:
        return self._desktop.call(
            "documentList",
            {
                **input,
                **({"cursor": cursor} if cursor is not None else {}),
                **({"limit": limit} if limit is not None else {}),
            },
        )

    def list_all(
        self,
        input: Mapping[str, Any],
        *,
        limit: int | None = None,
    ) -> Iterator[JsonObject]:
        cursor: str | None = None
        while True:
            page = self.list(input, cursor=cursor, limit=limit)
            yield from page.get("results", [])
            cursor = page.get("next_cursor")
            if not cursor:
                return

    def get(self, document_id: str) -> JsonObject:
        return self._desktop.call("documentGet", {"id": document_id})

    def content(self, document_id: str) -> JsonObject:
        return self._desktop.call("documentContent", {"id": document_id})

    def delete(
        self,
        document_id: str,
        *,
        idempotency_key: str | None = None,
    ) -> JsonObject:
        return self._desktop.call(
            "documentDelete",
            _with_idempotency({"id": document_id}, idempotency_key),
        )


class FishMemDesktop:
    """Python adapter for the local machine-oriented ``fishmem`` CLI."""

    def __init__(
        self,
        *,
        command: str = "fishmem",
        timeout: float = 300,
        runner: DesktopRunner | None = None,
    ) -> None:
        if not command.strip():
            raise ValueError("command is required")
        if timeout <= 0:
            raise ValueError("timeout must be positive")
        self.command = command
        self.timeout = timeout
        self._runner = runner or _run
        self.documents = DesktopDocuments(self)
        self.entities = DesktopEntities(self)
        self.memories = DesktopMemories(self)

    def status(self) -> JsonObject:
        return self.call("status")

    def call(
        self, method: str, params: Mapping[str, Any] | None = None
    ) -> JsonObject:
        args = [self.command, "call", method]
        stdin: str | None = None
        if params is not None:
            args.append("--input-stdin")
            stdin = json.dumps(dict(params))
        try:
            result = self._runner(args, self.timeout, stdin)
        except (OSError, subprocess.SubprocessError) as cause:
            raise FishMemDesktopError(
                str(cause), command=self.command
            ) from cause
        if result.returncode != 0:
            message = result.stderr.strip() or (
                f"fishmem CLI failed with exit code {result.returncode}"
            )
            try:
                payload = json.loads(result.stderr)
                if isinstance(payload, dict) and isinstance(
                    payload.get("error"), str
                ):
                    message = payload["error"]
            except ValueError:
                pass
            raise FishMemDesktopError(
                message,
                command=self.command,
                stderr=result.stderr,
            )
        try:
            payload = json.loads(result.stdout)
        except ValueError as cause:
            raise FishMemDesktopError(
                "fishmem CLI returned invalid JSON",
                command=self.command,
                stderr=result.stderr,
            ) from cause
        if not isinstance(payload, dict):
            raise FishMemDesktopError(
                "fishmem CLI returned a non-object response",
                command=self.command,
                stderr=result.stderr,
            )
        return payload
