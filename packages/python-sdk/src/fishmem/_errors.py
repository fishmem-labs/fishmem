from __future__ import annotations

from typing import Any


class FishMemError(Exception):
    """A structured error returned by the FishMem HTTP API."""

    def __init__(
        self,
        message: str,
        *,
        status: int,
        code: str | None = None,
        request_id: str | None = None,
        details: Any = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.request_id = request_id
        self.details = details


class FishMemOperationError(Exception):
    """An asynchronous FishMem operation reached a failed terminal state."""

    def __init__(self, operation: dict[str, Any]) -> None:
        self.operation = operation
        message = operation.get("error") or (
            f"FishMem operation {operation.get('id')} ended with "
            f"status {operation.get('status')}"
        )
        super().__init__(message)


class FishMemOperationTimeoutError(TimeoutError):
    """An asynchronous FishMem operation did not finish before its deadline."""

    def __init__(self, operation_id: str, timeout: float) -> None:
        self.operation_id = operation_id
        self.timeout = timeout
        super().__init__(
            f"FishMem operation {operation_id} did not complete within {timeout}s"
        )


class FishMemEventError(Exception):
    """A memory-inference event reached a failed terminal state."""

    def __init__(self, event: dict[str, Any]) -> None:
        self.event = event
        message = event.get("error") or (
            f"FishMem event {event.get('id')} ended with "
            f"status {event.get('status')}"
        )
        super().__init__(message)


class FishMemEventTimeoutError(TimeoutError):
    """A memory-inference event did not finish before its deadline."""

    def __init__(self, event_id: str, timeout: float) -> None:
        self.event_id = event_id
        self.timeout = timeout
        super().__init__(
            f"FishMem event {event_id} did not complete within {timeout}s"
        )


class FishMemDesktopError(Exception):
    """The local fishmem CLI could not complete a Desktop request."""

    def __init__(
        self,
        message: str,
        *,
        command: str,
        stderr: str | None = None,
    ) -> None:
        super().__init__(message)
        self.command = command
        self.stderr = stderr
