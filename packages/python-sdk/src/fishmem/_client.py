from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator, Iterator, Mapping
from typing import Any
from urllib.parse import quote, urljoin, urlsplit

import httpx

from ._document_upload import (
    DocumentUploadSource,
    prepare_api_document_upload,
)
from ._errors import (
    FishMemError,
    FishMemEventError,
    FishMemEventTimeoutError,
    FishMemOperationError,
    FishMemOperationTimeoutError,
)

JsonObject = dict[str, Any]


def _compact(value: Mapping[str, Any]) -> JsonObject:
    return {key: item for key, item in value.items() if item is not None}


def _scope_params(scope: Mapping[str, Any]) -> JsonObject:
    return _compact(
        {
            "user_id": scope.get("user_id"),
            "agent_id": scope.get("agent_id"),
            "run_id": scope.get("run_id"),
        }
    )


def _segment(value: str) -> str:
    return quote(value, safe="")


def _required_idempotency_key(
    value: str | None, operation: str = "documents.upload"
) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(
            f"{operation} requires a non-empty idempotency_key"
        )
    return value.strip()


def _upload_target(base_url: str, value: str) -> tuple[str, bool]:
    target = urljoin(f"{base_url.rstrip('/')}/", value)
    parsed = urlsplit(target)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("FishMem upload URLs must use HTTP or HTTPS")
    base = urlsplit(base_url)
    return target, (
        parsed.scheme.lower(),
        parsed.hostname,
        parsed.port,
    ) == (
        base.scheme.lower(),
        base.hostname,
        base.port,
    )


def _raise_for_fishmem(response: httpx.Response) -> Any:
    try:
        payload: Any = response.json() if response.content else None
    except ValueError as cause:
        if response.is_success:
            raise FishMemError(
                "FishMem returned invalid JSON",
                status=response.status_code,
            ) from cause
        payload = None
    if response.is_success:
        return payload
    error = payload.get("error", payload) if isinstance(payload, dict) else None
    record = error if isinstance(error, dict) else {}
    message = record.get("message")
    if not isinstance(message, str):
        message = (
            payload
            if isinstance(payload, str)
            else f"FishMem request failed with status {response.status_code}"
        )
    raise FishMemError(
        message,
        status=response.status_code,
        code=record.get("code") if isinstance(record.get("code"), str) else None,
        request_id=(
            record.get("request_id")
            if isinstance(record.get("request_id"), str)
            else None
        ),
        details=record.get("details"),
    )


class _SyncTransport:
    def __init__(
        self,
        *,
        api_key: str,
        base_url: str,
        timeout: float | httpx.Timeout,
        headers: Mapping[str, str] | None,
        transport: httpx.BaseTransport | None,
    ) -> None:
        if not api_key.strip():
            raise ValueError("FishMem api_key is required")
        self._base_url = base_url.rstrip("/")
        merged_headers = dict(headers or {})
        merged_headers.update(
            {
                "Authorization": f"Bearer {api_key.strip()}",
                "Accept": "application/json",
            }
        )
        self.client = httpx.Client(
            headers=merged_headers,
            timeout=timeout,
            transport=transport,
        )

    def request(
        self,
        method: str,
        path: str,
        *,
        body: Any = None,
        data: Mapping[str, Any] | None = None,
        files: Mapping[str, Any] | None = None,
        content: bytes | None = None,
        params: Mapping[str, Any] | None = None,
        idempotency_key: str | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> Any:
        body_kinds = sum(
            (
                body is not None,
                data is not None or files is not None,
                content is not None,
            )
        )
        if body_kinds > 1:
            raise ValueError(
                "A FishMem request cannot contain multiple body encodings"
            )
        request_headers = dict(headers or {})
        if idempotency_key is not None:
            request_headers["Idempotency-Key"] = idempotency_key
        response = self.client.request(
            method,
            f"{self._base_url}{path}",
            json=body,
            data=data,
            files=files,
            content=content,
            params=_compact(params or {}),
            headers=request_headers or None,
        )
        return _raise_for_fishmem(response)

    def upload(
        self,
        method: str,
        url: str,
        *,
        content: bytes,
        headers: Mapping[str, str] | None = None,
    ) -> Any:
        target, authenticated = _upload_target(self._base_url, url)
        upload_headers = dict(headers or {})
        if authenticated:
            response = self.client.request(
                method,
                target,
                content=content,
                headers=upload_headers or None,
            )
        else:
            template = self.client.build_request(
                method,
                target,
                content=content,
                headers=upload_headers or None,
            )
            request = httpx.Request(
                method,
                target,
                content=content,
                headers=upload_headers or None,
                extensions=dict(template.extensions),
            )
            response = self.client.send(request)
        return _raise_for_fishmem(response)


class _AsyncTransport:
    def __init__(
        self,
        *,
        api_key: str,
        base_url: str,
        timeout: float | httpx.Timeout,
        headers: Mapping[str, str] | None,
        transport: httpx.AsyncBaseTransport | None,
    ) -> None:
        if not api_key.strip():
            raise ValueError("FishMem api_key is required")
        self._base_url = base_url.rstrip("/")
        merged_headers = dict(headers or {})
        merged_headers.update(
            {
                "Authorization": f"Bearer {api_key.strip()}",
                "Accept": "application/json",
            }
        )
        self.client = httpx.AsyncClient(
            headers=merged_headers,
            timeout=timeout,
            transport=transport,
        )

    async def request(
        self,
        method: str,
        path: str,
        *,
        body: Any = None,
        data: Mapping[str, Any] | None = None,
        files: Mapping[str, Any] | None = None,
        content: bytes | None = None,
        params: Mapping[str, Any] | None = None,
        idempotency_key: str | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> Any:
        body_kinds = sum(
            (
                body is not None,
                data is not None or files is not None,
                content is not None,
            )
        )
        if body_kinds > 1:
            raise ValueError(
                "A FishMem request cannot contain multiple body encodings"
            )
        request_headers = dict(headers or {})
        if idempotency_key is not None:
            request_headers["Idempotency-Key"] = idempotency_key
        response = await self.client.request(
            method,
            f"{self._base_url}{path}",
            json=body,
            data=data,
            files=files,
            content=content,
            params=_compact(params or {}),
            headers=request_headers or None,
        )
        return _raise_for_fishmem(response)

    async def upload(
        self,
        method: str,
        url: str,
        *,
        content: bytes,
        headers: Mapping[str, str] | None = None,
    ) -> Any:
        target, authenticated = _upload_target(self._base_url, url)
        upload_headers = dict(headers or {})
        if authenticated:
            response = await self.client.request(
                method,
                target,
                content=content,
                headers=upload_headers or None,
            )
        else:
            template = self.client.build_request(
                method,
                target,
                content=content,
                headers=upload_headers or None,
            )
            request = httpx.Request(
                method,
                target,
                content=content,
                headers=upload_headers or None,
                extensions=dict(template.extensions),
            )
            response = await self.client.send(request)
        return _raise_for_fishmem(response)


class Memories:
    def __init__(self, transport: _SyncTransport) -> None:
        self._transport = transport

    def add(
        self,
        input: Mapping[str, Any],
        *,
        idempotency_key: str | None = None,
    ) -> JsonObject:
        key = (
            idempotency_key
            if input.get("infer") is False
            else _required_idempotency_key(
                idempotency_key, "memories.add"
            )
        )
        return self._transport.request(
            "POST",
            "/v1/memories",
            body=dict(input),
            idempotency_key=key,
        )

    def add_async(
        self,
        input: Mapping[str, Any],
        *,
        idempotency_key: str,
    ) -> JsonObject:
        return self.add(
            {**dict(input), "infer": True},
            idempotency_key=_required_idempotency_key(
                idempotency_key, "memories.add_async"
            ),
        )

    def add_and_wait(
        self,
        input: Mapping[str, Any],
        *,
        idempotency_key: str,
        interval: float = 0.5,
        timeout: float = 30,
    ) -> JsonObject:
        receipt = self.add_async(
            input, idempotency_key=idempotency_key
        )
        event = Events(self._transport).wait(
            str(receipt["event_id"]),
            interval=interval,
            timeout=timeout,
        )
        return {"results": event.get("results", [])}

    def search(self, input: Mapping[str, Any]) -> JsonObject:
        return self._transport.request(
            "POST", "/v1/memories/search", body=dict(input)
        )

    def batch_update(
        self,
        memories: list[Mapping[str, Any]],
        *,
        idempotency_key: str,
    ) -> JsonObject:
        key = _required_idempotency_key(
            idempotency_key, "memories.batch_update"
        )
        return self._transport.request(
            "PUT",
            "/v1/memories/batch",
            body={"memories": [dict(memory) for memory in memories]},
            idempotency_key=key,
        )

    def batch_delete(
        self,
        memories: list[Mapping[str, Any]],
        *,
        idempotency_key: str,
    ) -> JsonObject:
        key = _required_idempotency_key(
            idempotency_key, "memories.batch_delete"
        )
        return self._transport.request(
            "DELETE",
            "/v1/memories/batch",
            body={"memories": [dict(memory) for memory in memories]},
            idempotency_key=key,
        )

    def list(
        self,
        scope: Mapping[str, Any],
        *,
        cursor: str | None = None,
        limit: int | None = None,
    ) -> JsonObject:
        return self._transport.request(
            "GET",
            "/v1/memories",
            params={**_scope_params(scope), "cursor": cursor, "limit": limit},
        )

    def list_all(
        self,
        scope: Mapping[str, Any],
        *,
        limit: int | None = None,
    ) -> Iterator[JsonObject]:
        cursor: str | None = None
        while True:
            page = self.list(scope, cursor=cursor, limit=limit)
            yield from page.get("results", [])
            cursor = page.get("next_cursor")
            if not cursor:
                return

    def get(self, memory_id: str) -> JsonObject:
        return self._transport.request(
            "GET", f"/v1/memories/{_segment(memory_id)}"
        )

    def update(
        self,
        memory_id: str,
        input: Mapping[str, Any],
        *,
        idempotency_key: str | None = None,
    ) -> JsonObject:
        return self._transport.request(
            "PUT",
            f"/v1/memories/{_segment(memory_id)}",
            body=dict(input),
            idempotency_key=idempotency_key,
        )

    def delete(
        self,
        memory_id: str,
        *,
        idempotency_key: str | None = None,
    ) -> JsonObject:
        return self._transport.request(
            "DELETE",
            f"/v1/memories/{_segment(memory_id)}",
            idempotency_key=idempotency_key,
        )

    def delete_all(
        self,
        scope: Mapping[str, Any],
        *,
        idempotency_key: str | None = None,
    ) -> JsonObject:
        return self._transport.request(
            "DELETE",
            "/v1/memories",
            params=_scope_params(scope),
            idempotency_key=idempotency_key,
        )

    def history(self, memory_id: str) -> JsonObject:
        return self._transport.request(
            "GET", f"/v1/memories/{_segment(memory_id)}/history"
        )

    def get_feedback(self, memory_id: str) -> JsonObject:
        return self._transport.request(
            "GET", f"/v1/memories/{_segment(memory_id)}/feedback"
        )

    def set_feedback(
        self,
        memory_id: str,
        input: Mapping[str, Any],
        *,
        idempotency_key: str,
    ) -> JsonObject:
        key = _required_idempotency_key(
            idempotency_key, "memories.set_feedback"
        )
        return self._transport.request(
            "POST",
            f"/v1/memories/{_segment(memory_id)}/feedback",
            body=dict(input),
            idempotency_key=key,
        )

    def clear_feedback(
        self,
        memory_id: str,
        *,
        idempotency_key: str,
    ) -> JsonObject:
        key = _required_idempotency_key(
            idempotency_key, "memories.clear_feedback"
        )
        return self._transport.request(
            "DELETE",
            f"/v1/memories/{_segment(memory_id)}/feedback",
            idempotency_key=key,
        )


class Documents:
    def __init__(self, transport: _SyncTransport) -> None:
        self._transport = transport

    def ingest(
        self,
        input: Mapping[str, Any],
        *,
        idempotency_key: str | None = None,
    ) -> JsonObject:
        return self._transport.request(
            "POST",
            "/v1/documents",
            body=dict(input),
            idempotency_key=idempotency_key,
        )

    def upload(
        self,
        file: DocumentUploadSource,
        input: Mapping[str, Any],
        *,
        filename: str | None = None,
        idempotency_key: str,
    ) -> JsonObject:
        key = _required_idempotency_key(idempotency_key)
        upload = prepare_api_document_upload(file, input, filename=filename)
        created = self._transport.request(
            "POST",
            "/v1/document-uploads",
            body=upload.command,
            idempotency_key=key,
        )
        asset_id = str(created["source_asset"]["id"])
        upload_target = created["upload"]
        self._transport.upload(
            str(upload_target.get("method", "PUT")),
            str(upload_target["url"]),
            content=upload.content,
            headers={
                str(key): str(value)
                for key, value in upload_target.get("headers", {}).items()
            },
        )
        return self.complete_upload(asset_id)

    def create_upload(
        self,
        input: Mapping[str, Any],
        *,
        idempotency_key: str,
    ) -> JsonObject:
        key = _required_idempotency_key(idempotency_key)
        return self._transport.request(
            "POST",
            "/v1/document-uploads",
            body=dict(input),
            idempotency_key=key,
        )

    def get_upload(self, asset_id: str) -> JsonObject:
        return self._transport.request(
            "GET", f"/v1/document-uploads/{_segment(asset_id)}"
        )

    def delete_upload(self, asset_id: str) -> None:
        self._transport.request(
            "DELETE", f"/v1/document-uploads/{_segment(asset_id)}"
        )

    def complete_upload(self, asset_id: str) -> JsonObject:
        return self._transport.request(
            "POST",
            f"/v1/document-uploads/{_segment(asset_id)}/complete",
        )

    def search(self, input: Mapping[str, Any]) -> JsonObject:
        return self._transport.request(
            "POST", "/v1/documents/search", body=dict(input)
        )

    def list(
        self,
        input: Mapping[str, Any],
        *,
        cursor: str | None = None,
        limit: int | None = None,
    ) -> JsonObject:
        return self._transport.request(
            "GET",
            "/v1/documents",
            params={**dict(input), "cursor": cursor, "limit": limit},
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
        return self._transport.request(
            "GET", f"/v1/documents/{_segment(document_id)}"
        )

    def content(self, document_id: str) -> JsonObject:
        return self._transport.request(
            "GET", f"/v1/documents/{_segment(document_id)}/content"
        )

    def delete(
        self,
        document_id: str,
        *,
        idempotency_key: str | None = None,
    ) -> JsonObject:
        return self._transport.request(
            "DELETE",
            f"/v1/documents/{_segment(document_id)}",
            idempotency_key=idempotency_key,
        )


class Entities:
    """Structural user, agent, and run scopes derived from memory records."""

    def __init__(self, transport: _SyncTransport) -> None:
        self._transport = transport

    def list(
        self,
        *,
        entity_type: str | None = None,
        cursor: str | None = None,
        limit: int | None = None,
    ) -> JsonObject:
        return self._transport.request(
            "GET",
            "/v1/entities",
            params={
                "type": entity_type,
                "cursor": cursor,
                "limit": limit,
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
        return self._transport.request(
            "GET",
            f"/v1/entities/{_segment(entity_type)}/{_segment(entity_id)}",
        )

    def delete(
        self,
        entity_type: str,
        entity_id: str,
        *,
        idempotency_key: str,
    ) -> JsonObject:
        key = _required_idempotency_key(
            idempotency_key, "entities.delete"
        )
        return self._transport.request(
            "DELETE",
            f"/v1/entities/{_segment(entity_type)}/{_segment(entity_id)}",
            idempotency_key=key,
        )


class Health:
    def __init__(self, transport: _SyncTransport) -> None:
        self._transport = transport

    def get(self) -> JsonObject:
        return self._transport.request("GET", "/v1/health")


class Operations:
    def __init__(self, transport: _SyncTransport) -> None:
        self._transport = transport

    def list(self, *, limit: int | None = None) -> JsonObject:
        return self._transport.request(
            "GET", "/v1/operations", params={"limit": limit}
        )

    def get(self, operation_id: str) -> JsonObject:
        return self._transport.request(
            "GET", f"/v1/operations/{_segment(operation_id)}"
        )

    def retry(self, operation_id: str) -> JsonObject:
        return self._transport.request(
            "POST",
            f"/v1/operations/{_segment(operation_id)}/retry",
        )

    def wait(
        self,
        operation_id: str,
        *,
        interval: float = 0.5,
        timeout: float = 30,
    ) -> JsonObject:
        if interval < 0:
            raise ValueError("interval must be non-negative")
        if timeout <= 0:
            raise ValueError("timeout must be positive")
        deadline = time.monotonic() + timeout
        while True:
            operation = self.get(operation_id)
            status = operation.get("status")
            if status in {"success", "committed"}:
                return operation
            if status in {"dead", "failed"}:
                raise FishMemOperationError(operation)
            if time.monotonic() >= deadline:
                raise FishMemOperationTimeoutError(operation_id, timeout)
            time.sleep(interval)


class Events:
    def __init__(self, transport: _SyncTransport) -> None:
        self._transport = transport

    def list(
        self,
        *,
        cursor: str | None = None,
        limit: int | None = None,
        status: str | None = None,
    ) -> JsonObject:
        return self._transport.request(
            "GET",
            "/v1/events",
            params={"cursor": cursor, "limit": limit, "status": status},
        )

    def get(self, event_id: str) -> JsonObject:
        return self._transport.request(
            "GET", f"/v1/events/{_segment(event_id)}"
        )

    def wait(
        self,
        event_id: str,
        *,
        interval: float = 0.5,
        timeout: float = 30,
    ) -> JsonObject:
        if interval < 0:
            raise ValueError("interval must be non-negative")
        if timeout <= 0:
            raise ValueError("timeout must be positive")
        deadline = time.monotonic() + timeout
        while True:
            event = self.get(event_id)
            status = event.get("status")
            if status == "SUCCEEDED":
                return event
            if status == "FAILED":
                raise FishMemEventError(event)
            if time.monotonic() >= deadline:
                raise FishMemEventTimeoutError(event_id, timeout)
            time.sleep(interval)


class State:
    def __init__(self, transport: _SyncTransport) -> None:
        self._transport = transport

    def get(self, query: Mapping[str, Any]) -> JsonObject | None:
        return self._transport.request(
            "GET", "/v1/state", params=dict(query)
        ).get("data")

    def history(self, query: Mapping[str, Any]) -> list[JsonObject]:
        return self._transport.request(
            "GET", "/v1/state/history", params=dict(query)
        ).get("data", [])


class Beliefs:
    def __init__(self, transport: _SyncTransport) -> None:
        self._transport = transport

    def get(self, query: Mapping[str, Any]) -> JsonObject:
        return self._transport.request(
            "GET", "/v1/beliefs", params=dict(query)
        ).get("data", {})


class Profile:
    def __init__(self, transport: _SyncTransport) -> None:
        self._transport = transport

    def get(self, query: Mapping[str, Any]) -> Any:
        return self._transport.request(
            "GET", "/v1/profile", params=dict(query)
        ).get("data")


class Exports:
    def __init__(self, transport: _SyncTransport) -> None:
        self._transport = transport

    def create(self, *, idempotency_key: str) -> JsonObject:
        return self._transport.request(
            "POST", "/v1/exports", idempotency_key=idempotency_key
        )


class Imports:
    def __init__(self, transport: _SyncTransport) -> None:
        self._transport = transport

    def create(
        self,
        snapshot: Mapping[str, Any],
        *,
        idempotency_key: str,
    ) -> JsonObject:
        return self._transport.request(
            "POST",
            "/v1/imports",
            body={"snapshot": dict(snapshot)},
            idempotency_key=idempotency_key,
        )


class FishMem:
    """Synchronous FishMem Cloud/self-hosted HTTP client."""

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str = "https://fishmem.com",
        timeout: float | httpx.Timeout = 30,
        headers: Mapping[str, str] | None = None,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._transport = _SyncTransport(
            api_key=api_key,
            base_url=base_url,
            timeout=timeout,
            headers=headers,
            transport=transport,
        )
        self.documents = Documents(self._transport)
        self.entities = Entities(self._transport)
        self.events = Events(self._transport)
        self.health = Health(self._transport)
        self.memories = Memories(self._transport)
        self.operations = Operations(self._transport)
        self.state = State(self._transport)
        self.beliefs = Beliefs(self._transport)
        self.profile = Profile(self._transport)
        self.exports = Exports(self._transport)
        self.imports = Imports(self._transport)

    def close(self) -> None:
        self._transport.client.close()

    def __enter__(self) -> FishMem:
        return self

    def __exit__(self, *args: object) -> None:
        self.close()


class AsyncMemories:
    def __init__(self, transport: _AsyncTransport) -> None:
        self._transport = transport

    async def add(
        self,
        input: Mapping[str, Any],
        *,
        idempotency_key: str | None = None,
    ) -> JsonObject:
        key = (
            idempotency_key
            if input.get("infer") is False
            else _required_idempotency_key(
                idempotency_key, "memories.add"
            )
        )
        return await self._transport.request(
            "POST",
            "/v1/memories",
            body=dict(input),
            idempotency_key=key,
        )

    async def add_async(
        self,
        input: Mapping[str, Any],
        *,
        idempotency_key: str,
    ) -> JsonObject:
        return await self.add(
            {**dict(input), "infer": True},
            idempotency_key=_required_idempotency_key(
                idempotency_key, "memories.add_async"
            ),
        )

    async def add_and_wait(
        self,
        input: Mapping[str, Any],
        *,
        idempotency_key: str,
        interval: float = 0.5,
        timeout: float = 30,
    ) -> JsonObject:
        receipt = await self.add_async(
            input, idempotency_key=idempotency_key
        )
        event = await AsyncEvents(self._transport).wait(
            str(receipt["event_id"]),
            interval=interval,
            timeout=timeout,
        )
        return {"results": event.get("results", [])}

    async def search(self, input: Mapping[str, Any]) -> JsonObject:
        return await self._transport.request(
            "POST", "/v1/memories/search", body=dict(input)
        )

    async def batch_update(
        self,
        memories: list[Mapping[str, Any]],
        *,
        idempotency_key: str,
    ) -> JsonObject:
        key = _required_idempotency_key(
            idempotency_key, "memories.batch_update"
        )
        return await self._transport.request(
            "PUT",
            "/v1/memories/batch",
            body={"memories": [dict(memory) for memory in memories]},
            idempotency_key=key,
        )

    async def batch_delete(
        self,
        memories: list[Mapping[str, Any]],
        *,
        idempotency_key: str,
    ) -> JsonObject:
        key = _required_idempotency_key(
            idempotency_key, "memories.batch_delete"
        )
        return await self._transport.request(
            "DELETE",
            "/v1/memories/batch",
            body={"memories": [dict(memory) for memory in memories]},
            idempotency_key=key,
        )

    async def list(
        self,
        scope: Mapping[str, Any],
        *,
        cursor: str | None = None,
        limit: int | None = None,
    ) -> JsonObject:
        return await self._transport.request(
            "GET",
            "/v1/memories",
            params={**_scope_params(scope), "cursor": cursor, "limit": limit},
        )

    async def list_all(
        self,
        scope: Mapping[str, Any],
        *,
        limit: int | None = None,
    ) -> AsyncIterator[JsonObject]:
        cursor: str | None = None
        while True:
            page = await self.list(scope, cursor=cursor, limit=limit)
            for memory in page.get("results", []):
                yield memory
            cursor = page.get("next_cursor")
            if not cursor:
                return

    async def get(self, memory_id: str) -> JsonObject:
        return await self._transport.request(
            "GET", f"/v1/memories/{_segment(memory_id)}"
        )

    async def update(
        self,
        memory_id: str,
        input: Mapping[str, Any],
        *,
        idempotency_key: str | None = None,
    ) -> JsonObject:
        return await self._transport.request(
            "PUT",
            f"/v1/memories/{_segment(memory_id)}",
            body=dict(input),
            idempotency_key=idempotency_key,
        )

    async def delete(
        self,
        memory_id: str,
        *,
        idempotency_key: str | None = None,
    ) -> JsonObject:
        return await self._transport.request(
            "DELETE",
            f"/v1/memories/{_segment(memory_id)}",
            idempotency_key=idempotency_key,
        )

    async def delete_all(
        self,
        scope: Mapping[str, Any],
        *,
        idempotency_key: str | None = None,
    ) -> JsonObject:
        return await self._transport.request(
            "DELETE",
            "/v1/memories",
            params=_scope_params(scope),
            idempotency_key=idempotency_key,
        )

    async def history(self, memory_id: str) -> JsonObject:
        return await self._transport.request(
            "GET", f"/v1/memories/{_segment(memory_id)}/history"
        )

    async def get_feedback(self, memory_id: str) -> JsonObject:
        return await self._transport.request(
            "GET", f"/v1/memories/{_segment(memory_id)}/feedback"
        )

    async def set_feedback(
        self,
        memory_id: str,
        input: Mapping[str, Any],
        *,
        idempotency_key: str,
    ) -> JsonObject:
        key = _required_idempotency_key(
            idempotency_key, "memories.set_feedback"
        )
        return await self._transport.request(
            "POST",
            f"/v1/memories/{_segment(memory_id)}/feedback",
            body=dict(input),
            idempotency_key=key,
        )

    async def clear_feedback(
        self,
        memory_id: str,
        *,
        idempotency_key: str,
    ) -> JsonObject:
        key = _required_idempotency_key(
            idempotency_key, "memories.clear_feedback"
        )
        return await self._transport.request(
            "DELETE",
            f"/v1/memories/{_segment(memory_id)}/feedback",
            idempotency_key=key,
        )


class AsyncDocuments:
    def __init__(self, transport: _AsyncTransport) -> None:
        self._transport = transport

    async def ingest(
        self,
        input: Mapping[str, Any],
        *,
        idempotency_key: str | None = None,
    ) -> JsonObject:
        return await self._transport.request(
            "POST",
            "/v1/documents",
            body=dict(input),
            idempotency_key=idempotency_key,
        )

    async def upload(
        self,
        file: DocumentUploadSource,
        input: Mapping[str, Any],
        *,
        filename: str | None = None,
        idempotency_key: str,
    ) -> JsonObject:
        key = _required_idempotency_key(idempotency_key)
        upload = prepare_api_document_upload(file, input, filename=filename)
        created = await self._transport.request(
            "POST",
            "/v1/document-uploads",
            body=upload.command,
            idempotency_key=key,
        )
        asset_id = str(created["source_asset"]["id"])
        upload_target = created["upload"]
        await self._transport.upload(
            str(upload_target.get("method", "PUT")),
            str(upload_target["url"]),
            content=upload.content,
            headers={
                str(key): str(value)
                for key, value in upload_target.get("headers", {}).items()
            },
        )
        return await self.complete_upload(asset_id)

    async def create_upload(
        self,
        input: Mapping[str, Any],
        *,
        idempotency_key: str,
    ) -> JsonObject:
        key = _required_idempotency_key(idempotency_key)
        return await self._transport.request(
            "POST",
            "/v1/document-uploads",
            body=dict(input),
            idempotency_key=key,
        )

    async def get_upload(self, asset_id: str) -> JsonObject:
        return await self._transport.request(
            "GET", f"/v1/document-uploads/{_segment(asset_id)}"
        )

    async def delete_upload(self, asset_id: str) -> None:
        await self._transport.request(
            "DELETE", f"/v1/document-uploads/{_segment(asset_id)}"
        )

    async def complete_upload(self, asset_id: str) -> JsonObject:
        return await self._transport.request(
            "POST",
            f"/v1/document-uploads/{_segment(asset_id)}/complete",
        )

    async def search(self, input: Mapping[str, Any]) -> JsonObject:
        return await self._transport.request(
            "POST", "/v1/documents/search", body=dict(input)
        )

    async def list(
        self,
        input: Mapping[str, Any],
        *,
        cursor: str | None = None,
        limit: int | None = None,
    ) -> JsonObject:
        return await self._transport.request(
            "GET",
            "/v1/documents",
            params={**dict(input), "cursor": cursor, "limit": limit},
        )

    async def list_all(
        self,
        input: Mapping[str, Any],
        *,
        limit: int | None = None,
    ) -> AsyncIterator[JsonObject]:
        cursor: str | None = None
        while True:
            page = await self.list(input, cursor=cursor, limit=limit)
            for document in page.get("results", []):
                yield document
            cursor = page.get("next_cursor")
            if not cursor:
                return

    async def get(self, document_id: str) -> JsonObject:
        return await self._transport.request(
            "GET", f"/v1/documents/{_segment(document_id)}"
        )

    async def content(self, document_id: str) -> JsonObject:
        return await self._transport.request(
            "GET", f"/v1/documents/{_segment(document_id)}/content"
        )

    async def delete(
        self,
        document_id: str,
        *,
        idempotency_key: str | None = None,
    ) -> JsonObject:
        return await self._transport.request(
            "DELETE",
            f"/v1/documents/{_segment(document_id)}",
            idempotency_key=idempotency_key,
        )


class AsyncEntities:
    """Async structural user, agent, and run scope resource."""

    def __init__(self, transport: _AsyncTransport) -> None:
        self._transport = transport

    async def list(
        self,
        *,
        entity_type: str | None = None,
        cursor: str | None = None,
        limit: int | None = None,
    ) -> JsonObject:
        return await self._transport.request(
            "GET",
            "/v1/entities",
            params={
                "type": entity_type,
                "cursor": cursor,
                "limit": limit,
            },
        )

    async def list_all(
        self,
        *,
        entity_type: str | None = None,
        limit: int | None = None,
    ) -> AsyncIterator[JsonObject]:
        cursor: str | None = None
        while True:
            page = await self.list(
                entity_type=entity_type,
                cursor=cursor,
                limit=limit,
            )
            for entity in page.get("results", []):
                yield entity
            cursor = page.get("next_cursor")
            if not cursor:
                return

    async def get(self, entity_type: str, entity_id: str) -> JsonObject:
        return await self._transport.request(
            "GET",
            f"/v1/entities/{_segment(entity_type)}/{_segment(entity_id)}",
        )

    async def delete(
        self,
        entity_type: str,
        entity_id: str,
        *,
        idempotency_key: str,
    ) -> JsonObject:
        key = _required_idempotency_key(
            idempotency_key, "entities.delete"
        )
        return await self._transport.request(
            "DELETE",
            f"/v1/entities/{_segment(entity_type)}/{_segment(entity_id)}",
            idempotency_key=key,
        )


class AsyncHealth:
    def __init__(self, transport: _AsyncTransport) -> None:
        self._transport = transport

    async def get(self) -> JsonObject:
        return await self._transport.request("GET", "/v1/health")


class AsyncOperations:
    def __init__(self, transport: _AsyncTransport) -> None:
        self._transport = transport

    async def list(self, *, limit: int | None = None) -> JsonObject:
        return await self._transport.request(
            "GET", "/v1/operations", params={"limit": limit}
        )

    async def get(self, operation_id: str) -> JsonObject:
        return await self._transport.request(
            "GET", f"/v1/operations/{_segment(operation_id)}"
        )

    async def retry(self, operation_id: str) -> JsonObject:
        return await self._transport.request(
            "POST",
            f"/v1/operations/{_segment(operation_id)}/retry",
        )

    async def wait(
        self,
        operation_id: str,
        *,
        interval: float = 0.5,
        timeout: float = 30,
    ) -> JsonObject:
        if interval < 0:
            raise ValueError("interval must be non-negative")
        if timeout <= 0:
            raise ValueError("timeout must be positive")
        deadline = time.monotonic() + timeout
        while True:
            operation = await self.get(operation_id)
            status = operation.get("status")
            if status in {"success", "committed"}:
                return operation
            if status in {"dead", "failed"}:
                raise FishMemOperationError(operation)
            if time.monotonic() >= deadline:
                raise FishMemOperationTimeoutError(operation_id, timeout)
            await asyncio.sleep(interval)


class AsyncEvents:
    def __init__(self, transport: _AsyncTransport) -> None:
        self._transport = transport

    async def list(
        self,
        *,
        cursor: str | None = None,
        limit: int | None = None,
        status: str | None = None,
    ) -> JsonObject:
        return await self._transport.request(
            "GET",
            "/v1/events",
            params={"cursor": cursor, "limit": limit, "status": status},
        )

    async def get(self, event_id: str) -> JsonObject:
        return await self._transport.request(
            "GET", f"/v1/events/{_segment(event_id)}"
        )

    async def wait(
        self,
        event_id: str,
        *,
        interval: float = 0.5,
        timeout: float = 30,
    ) -> JsonObject:
        if interval < 0:
            raise ValueError("interval must be non-negative")
        if timeout <= 0:
            raise ValueError("timeout must be positive")
        deadline = time.monotonic() + timeout
        while True:
            event = await self.get(event_id)
            status = event.get("status")
            if status == "SUCCEEDED":
                return event
            if status == "FAILED":
                raise FishMemEventError(event)
            if time.monotonic() >= deadline:
                raise FishMemEventTimeoutError(event_id, timeout)
            await asyncio.sleep(interval)


class AsyncState:
    def __init__(self, transport: _AsyncTransport) -> None:
        self._transport = transport

    async def get(self, query: Mapping[str, Any]) -> JsonObject | None:
        response = await self._transport.request(
            "GET", "/v1/state", params=dict(query)
        )
        return response.get("data")

    async def history(self, query: Mapping[str, Any]) -> list[JsonObject]:
        response = await self._transport.request(
            "GET", "/v1/state/history", params=dict(query)
        )
        return response.get("data", [])


class AsyncBeliefs:
    def __init__(self, transport: _AsyncTransport) -> None:
        self._transport = transport

    async def get(self, query: Mapping[str, Any]) -> JsonObject:
        response = await self._transport.request(
            "GET", "/v1/beliefs", params=dict(query)
        )
        return response.get("data", {})


class AsyncProfile:
    def __init__(self, transport: _AsyncTransport) -> None:
        self._transport = transport

    async def get(self, query: Mapping[str, Any]) -> Any:
        response = await self._transport.request(
            "GET", "/v1/profile", params=dict(query)
        )
        return response.get("data")


class AsyncExports:
    def __init__(self, transport: _AsyncTransport) -> None:
        self._transport = transport

    async def create(self, *, idempotency_key: str) -> JsonObject:
        return await self._transport.request(
            "POST", "/v1/exports", idempotency_key=idempotency_key
        )


class AsyncImports:
    def __init__(self, transport: _AsyncTransport) -> None:
        self._transport = transport

    async def create(
        self,
        snapshot: Mapping[str, Any],
        *,
        idempotency_key: str,
    ) -> JsonObject:
        return await self._transport.request(
            "POST",
            "/v1/imports",
            body={"snapshot": dict(snapshot)},
            idempotency_key=idempotency_key,
        )


class AsyncFishMem:
    """Asynchronous FishMem Cloud/self-hosted HTTP client."""

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str = "https://fishmem.com",
        timeout: float | httpx.Timeout = 30,
        headers: Mapping[str, str] | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._transport = _AsyncTransport(
            api_key=api_key,
            base_url=base_url,
            timeout=timeout,
            headers=headers,
            transport=transport,
        )
        self.documents = AsyncDocuments(self._transport)
        self.entities = AsyncEntities(self._transport)
        self.events = AsyncEvents(self._transport)
        self.health = AsyncHealth(self._transport)
        self.memories = AsyncMemories(self._transport)
        self.operations = AsyncOperations(self._transport)
        self.state = AsyncState(self._transport)
        self.beliefs = AsyncBeliefs(self._transport)
        self.profile = AsyncProfile(self._transport)
        self.exports = AsyncExports(self._transport)
        self.imports = AsyncImports(self._transport)

    async def close(self) -> None:
        await self._transport.client.aclose()

    async def __aenter__(self) -> AsyncFishMem:
        return self

    async def __aexit__(self, *args: object) -> None:
        await self.close()
