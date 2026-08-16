from __future__ import annotations

import json
import hashlib
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any

import httpx

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

from fishmem import AsyncFishMem, FishMem, FishMemDesktop, FishMemError


def response(payload: Any, status: int = 200) -> httpx.Response:
    return httpx.Response(status, json=payload)


class FishMemClientTest(unittest.TestCase):
    def test_structural_scope_entities_resource(self) -> None:
        calls: list[httpx.Request] = []
        now = "2026-07-31T00:00:00.000Z"
        first = {
            "id": "ada/team",
            "type": "user",
            "total_memories": 3,
            "created_at": now,
            "updated_at": now,
        }
        second = {
            "id": "run-2",
            "type": "run",
            "total_memories": 1,
            "created_at": now,
            "updated_at": now,
        }

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            if request.url.path == "/v1/entities":
                if request.url.params.get("cursor") == "page two":
                    return response(
                        {"results": [second], "next_cursor": None}
                    )
                return response(
                    {"results": [first], "next_cursor": "page two"}
                )
            if request.method == "GET":
                return response(first)
            return response(
                {
                    "id": first["id"],
                    "type": first["type"],
                    "deleted_memories": 3,
                }
            )

        with FishMem(
            api_key="fm_test", transport=httpx.MockTransport(handler)
        ) as client:
            self.assertEqual(
                [entity["id"] for entity in client.entities.list_all(limit=1)],
                ["ada/team", "run-2"],
            )
            self.assertEqual(
                client.entities.get("user", "ada/team"), first
            )
            deleted = client.entities.delete(
                "user",
                "ada/team",
                idempotency_key="delete-ada-team-1",
            )
            self.assertEqual(deleted["deleted_memories"], 3)
            with self.assertRaisesRegex(
                ValueError,
                "entities.delete requires a non-empty idempotency_key",
            ):
                client.entities.delete(
                    "user", "ada", idempotency_key=" "
                )

        self.assertEqual(calls[0].url.params["limit"], "1")
        self.assertEqual(calls[1].url.params["cursor"], "page two")
        self.assertEqual(
            calls[2].url.raw_path,
            b"/v1/entities/user/ada%2Fteam",
        )
        self.assertEqual(calls[3].method, "DELETE")
        self.assertEqual(
            calls[3].headers["idempotency-key"],
            "delete-ada-team-1",
        )

    def test_native_memory_feedback_surface(self) -> None:
        calls: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            if request.method == "GET":
                return response({"feedback": None})
            if request.method == "POST":
                return response(
                    {
                        "feedback": {
                            "id": "feedback_1",
                            "memory_id": "memory/1",
                            "rating": "negative",
                            "reason": "Out of date",
                            "request_id": "req_1",
                            "created_at": "2026-07-31T00:00:00.000Z",
                        }
                    }
                )
            return response({"cleared": True})

        with FishMem(
            api_key="fm_test", transport=httpx.MockTransport(handler)
        ) as client:
            self.assertEqual(
                client.memories.get_feedback("memory/1"),
                {"feedback": None},
            )
            client.memories.set_feedback(
                "memory/1",
                {
                    "rating": "negative",
                    "reason": "Out of date",
                    "request_id": "req_1",
                },
                idempotency_key="feedback-set-1",
            )
            client.memories.clear_feedback(
                "memory/1", idempotency_key="feedback-clear-1"
            )

        self.assertEqual(
            calls[0].url.raw_path, b"/v1/memories/memory%2F1/feedback"
        )
        self.assertEqual(calls[1].method, "POST")
        self.assertEqual(calls[1].headers["idempotency-key"], "feedback-set-1")
        self.assertEqual(json.loads(calls[1].content)["rating"], "negative")
        self.assertEqual(calls[2].method, "DELETE")

    def test_async_inference_uses_event_api(self) -> None:
        calls: list[httpx.Request] = []
        now = "2026-07-31T00:00:00.000Z"
        polls = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal polls
            calls.append(request)
            if request.url.path == "/v1/memories":
                return response(
                    {
                        "message": "Memory inference accepted",
                        "status": "PENDING",
                        "event_id": "task_infer",
                    },
                    202,
                )
            if request.url.path == "/v1/events/task_infer":
                polls += 1
                return response(
                    {
                        "id": "task_infer",
                        "event_type": "ADD",
                        "status": (
                            "RUNNING" if polls == 1 else "SUCCEEDED"
                        ),
                        "scope": {"user_id": "ada"},
                        "results": (
                            []
                            if polls == 1
                            else [
                                {
                                    "id": "m1",
                                    "memory": "Ada prefers tea",
                                    "event": "ADD",
                                }
                            ]
                        ),
                        "write_summary": (
                            None
                            if polls == 1
                            else {
                                "outcome": "STORED",
                                "planned": 1,
                                "persisted": 1,
                                "failed": 0,
                            }
                        ),
                        "attempts": 1,
                        "max_attempts": 5,
                        "error": None,
                        "created_at": now,
                        "updated_at": now,
                        "started_at": now,
                        "completed_at": None,
                        "latency_ms": None,
                    }
                )
            raise AssertionError(
                f"Unexpected request: {request.method} {request.url.path}"
            )

        with FishMem(
            api_key="fm_test", transport=httpx.MockTransport(handler)
        ) as client:
            result = client.memories.add_and_wait(
                {"content": "Ada prefers tea", "user_id": "ada"},
                idempotency_key="conversation-1",
                interval=0,
                timeout=1,
            )
        self.assertEqual(result["results"][0]["id"], "m1")
        self.assertEqual(
            calls[0].headers["idempotency-key"], "conversation-1"
        )
        self.assertEqual(polls, 2)

    def test_auth_idempotency_and_complete_resource_surface(self) -> None:
        calls: list[httpx.Request] = []
        now = "2026-07-30T00:00:00.000Z"
        operation = {
            "id": "op_1",
            "kind": "export",
            "status": "pending",
            "attempts": 0,
            "error": None,
            "created_at": now,
            "updated_at": now,
        }

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            path = request.url.path
            if path == "/v1/memories" and request.method == "POST":
                return response(
                    {
                        "results": [
                            {
                                "id": "m1",
                                "memory": "Ada prefers tea",
                                "event": "ADD",
                            }
                        ]
                    }
                )
            if path == "/v1/memories/search":
                return response({"results": []})
            if path == "/v1/memories/batch":
                return response(
                    {
                        **operation,
                        "kind": (
                            "batch_update"
                            if request.method == "PUT"
                            else "batch_delete"
                        ),
                    },
                    202,
                )
            if path == "/v1/memories":
                return response({"results": [], "next_cursor": None})
            if path == "/v1/memories/m1" and request.method == "GET":
                return response({"id": "m1"})
            if path == "/v1/memories/m1" and request.method == "PUT":
                return response(
                    {"id": "m1", "memory": "green tea", "event": "UPDATE"}
                )
            if path == "/v1/memories/m1" and request.method == "DELETE":
                return response({"id": "m1", "deleted": True})
            if path == "/v1/memories/m1/history":
                return response({"results": []})
            if path == "/v1/documents" and request.method == "POST":
                return response(
                    {
                        "document": {
                            "id": "doc_1",
                            "source_key": "docs/guide.md",
                            "content_hash": "a" * 64,
                            "version_hash": "b" * 64,
                        },
                        "chunks": 1,
                        "created": True,
                    }
                )
            if path == "/v1/documents/search":
                return response({"results": []})
            if path == "/v1/documents":
                return response({"results": [], "next_cursor": None})
            if path == "/v1/documents/doc_1/content":
                return response(
                    {
                        "id": "doc_1",
                        "content": "violet release token",
                        "content_hash": "a" * 64,
                    }
                )
            if path == "/v1/documents/doc_1" and request.method == "GET":
                return response({"id": "doc_1"})
            if path == "/v1/documents/doc_1" and request.method == "DELETE":
                return response(
                    {
                        "id": "doc_1",
                        "deleted": True,
                        "versions": 1,
                        "chunks": 1,
                    }
                )
            if (
                path == "/v1/document-uploads/asset_1"
                and request.method == "DELETE"
            ):
                return httpx.Response(204)
            if path == "/v1/state":
                return response({"data": None})
            if path == "/v1/state/history":
                return response({"data": []})
            if path == "/v1/beliefs":
                return response(
                    {
                        "data": {
                            "projection_status": "ready",
                            "winner": None,
                            "candidates": [],
                        }
                    }
                )
            if path == "/v1/profile":
                return response({"data": "## Profile"})
            if path == "/v1/health":
                return response(
                    {
                        "status": "ok",
                        "checked_at": now,
                        "engine": {
                            "configured": True,
                            "initialized": True,
                            "code": None,
                        },
                        "operations": {
                            "pending": 0,
                            "failed": 0,
                            "oldest_pending_at": None,
                        },
                        "tasks": {
                            "pending": 0,
                            "dead": 0,
                            "oldest_pending_at": None,
                        },
                        "projections": {
                            "vector_pending": 0,
                            "derived_pending": 0,
                        },
                        "warnings": {"last_24h": 0},
                    }
                )
            if path == "/v1/operations":
                return response({"results": [operation]})
            if path == "/v1/operations/op_1":
                return response(operation)
            if path == "/v1/operations/op_1/retry":
                return response({**operation, "status": "pending"}, 202)
            if path == "/v1/exports":
                return response(operation, 202)
            if path == "/v1/imports":
                return response({**operation, "kind": "import"}, 202)
            raise AssertionError(f"Unexpected request: {request.method} {path}")

        with FishMem(
            api_key="fm_test",
            base_url="https://memory.example/",
            transport=httpx.MockTransport(handler),
        ) as client:
            client.memories.add(
                {"content": "Ada prefers tea", "user_id": "ada"},
                idempotency_key="add-1",
            )
            self.assertEqual(
                client.memories.search(
                    {
                        "query": "drink",
                        "user_id": "ada",
                        "filters": {
                            "and": [
                                {
                                    "field": "metadata.channel",
                                    "operator": "eq",
                                    "value": "support",
                                },
                                {
                                    "field": "importance",
                                    "operator": "gte",
                                    "value": 0.5,
                                },
                            ]
                        },
                    }
                ),
                {"results": []},
            )
            self.assertEqual(
                client.memories.batch_update(
                    [{"memory_id": "m1", "content": "green tea"}],
                    idempotency_key="batch-update-1",
                )["kind"],
                "batch_update",
            )
            self.assertEqual(
                client.memories.batch_delete(
                    [{"memory_id": "m1"}],
                    idempotency_key="batch-delete-1",
                )["kind"],
                "batch_delete",
            )
            self.assertEqual(
                client.memories.list({"user_id": "ada"})["next_cursor"],
                None,
            )
            self.assertEqual(client.memories.get("m1")["id"], "m1")
            self.assertEqual(
                client.memories.update("m1", {"content": "green tea"})[
                    "event"
                ],
                "UPDATE",
            )
            self.assertTrue(client.memories.delete("m1")["deleted"])
            self.assertEqual(client.memories.history("m1"), {"results": []})
            self.assertEqual(
                client.documents.ingest(
                    {
                        "source_key": "docs/guide.md",
                        "content": "violet release token",
                        "user_id": "ada",
                    },
                    idempotency_key="document-1",
                )["document"]["id"],
                "doc_1",
            )
            self.assertEqual(
                client.documents.search(
                    {"query": "violet", "user_id": "ada"}
                ),
                {"results": []},
            )
            self.assertEqual(
                client.documents.list({"user_id": "ada"})["next_cursor"],
                None,
            )
            self.assertEqual(client.documents.get("doc_1")["id"], "doc_1")
            self.assertEqual(
                client.documents.content("doc_1")["content"],
                "violet release token",
            )
            self.assertTrue(
                client.documents.delete(
                    "doc_1", idempotency_key="document-delete"
                )["deleted"]
            )
            self.assertIsNone(client.documents.delete_upload("asset_1"))
            self.assertIsNone(
                client.state.get(
                    {
                        "user_id": "ada",
                        "subject": "Ada",
                        "attribute": "drink",
                    }
                )
            )
            self.assertEqual(
                client.state.history(
                    {
                        "user_id": "ada",
                        "subject": "Ada",
                        "attribute": "drink",
                    }
                ),
                [],
            )
            self.assertEqual(
                client.beliefs.get(
                    {
                        "user_id": "ada",
                        "subject": "Ada",
                        "attribute": "drink",
                        "view": "audit",
                    }
                )["projection_status"],
                "ready",
            )
            self.assertEqual(
                client.profile.get({"user_id": "ada"}), "## Profile"
            )
            self.assertEqual(client.health.get()["status"], "ok")
            self.assertEqual(client.operations.list()["results"][0]["id"], "op_1")
            self.assertEqual(client.operations.get("op_1")["id"], "op_1")
            self.assertEqual(
                client.operations.retry("op_1")["status"], "pending"
            )
            client.exports.create(idempotency_key="export-1")
            client.imports.create(
                {"format": "fishmem.namespace-snapshot"},
                idempotency_key="import-1",
            )

        add_call = next(
            call
            for call in calls
            if call.url.path == "/v1/memories" and call.method == "POST"
        )
        self.assertEqual(add_call.headers["authorization"], "Bearer fm_test")
        self.assertEqual(add_call.headers["idempotency-key"], "add-1")
        search_call = next(
            call for call in calls if call.url.path == "/v1/memories/search"
        )
        self.assertEqual(
            json.loads(search_call.content)["filters"],
            {
                "and": [
                    {
                        "field": "metadata.channel",
                        "operator": "eq",
                        "value": "support",
                    },
                    {
                        "field": "importance",
                        "operator": "gte",
                        "value": 0.5,
                    },
                ]
            },
        )
        batch_calls = [
            call for call in calls if call.url.path == "/v1/memories/batch"
        ]
        self.assertEqual(
            batch_calls[0].headers["idempotency-key"], "batch-update-1"
        )
        self.assertEqual(
            json.loads(batch_calls[1].content),
            {"memories": [{"memory_id": "m1"}]},
        )
        import_call = next(
            call for call in calls if call.url.path == "/v1/imports"
        )
        self.assertEqual(
            json.loads(import_call.content),
            {"snapshot": {"format": "fishmem.namespace-snapshot"}},
        )
        document_call = next(
            call
            for call in calls
            if call.url.path == "/v1/documents" and call.method == "POST"
        )
        self.assertEqual(
            document_call.headers["idempotency-key"], "document-1"
        )

    def test_document_upload_uses_async_asset_lifecycle_and_exact_bytes(
        self,
    ) -> None:
        calls: list[httpx.Request] = []
        now = "2026-07-30T00:00:00.000Z"

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            if (
                request.url.path == "/v1/document-uploads"
                and request.method == "POST"
            ):
                return response(
                    {
                        "source_asset": {
                            "id": "asset_upload",
                            "operation_id": "task_upload",
                            "status": "awaiting_upload",
                        },
                        "upload": {
                            "method": "PUT",
                            "url": "https://uploads.example/signed/asset_upload",
                            "headers": {"content-type": "text/markdown"},
                            "max_bytes": 25_000_000,
                        },
                        "operation": {
                            "id": "task_upload",
                            "kind": "document_extract",
                            "status": "awaiting_upload",
                            "attempts": 0,
                            "created_at": now,
                            "updated_at": now,
                        },
                    }
                )
            if (
                request.url.host == "uploads.example"
                and request.url.path == "/signed/asset_upload"
            ):
                return httpx.Response(204)
            if request.url.path.endswith("/asset_upload/complete"):
                return response(
                    {
                        "source_asset": {
                            "id": "asset_upload",
                            "status": "queued",
                        },
                        "operation": {
                            "id": "task_upload",
                            "kind": "document_extract",
                            "status": "pending",
                        },
                    },
                    202,
                )
            return response(
                {
                    "code": "UNEXPECTED_REQUEST",
                    "message": str(request.url),
                },
                500,
            )

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "upload.md"
            source.write_bytes(b"# Exact\n\nViolet bytes.\n")
            with FishMem(
                api_key="fm_test",
                base_url="https://memory.example",
                transport=httpx.MockTransport(handler),
            ) as client:
                result = client.documents.upload(
                    source,
                    {
                        "source_key": "docs/upload.md",
                        "title": "Upload",
                        "user_id": "ada",
                        "metadata": {"channel": "sdk"},
                    },
                    idempotency_key="upload-1",
                )

        self.assertEqual(result["source_asset"]["id"], "asset_upload")
        self.assertEqual(result["operation"]["status"], "pending")
        self.assertEqual(len(calls), 3)

        create = calls[0]
        self.assertEqual(create.url.path, "/v1/document-uploads")
        self.assertEqual(create.headers["content-type"], "application/json")
        self.assertEqual(create.headers["idempotency-key"], "upload-1")
        command = json.loads(create.content)
        self.assertEqual(command["filename"], "upload.md")
        self.assertEqual(command["source_key"], "docs/upload.md")
        self.assertEqual(command["content_type"], "text/markdown")
        self.assertEqual(command["size_bytes"], 23)
        self.assertEqual(
            command["checksum_sha256"],
            hashlib.sha256(b"# Exact\n\nViolet bytes.\n").hexdigest(),
        )
        self.assertEqual(command["metadata"], {"channel": "sdk"})

        content = calls[1]
        self.assertEqual(
            str(content.url),
            "https://uploads.example/signed/asset_upload",
        )
        self.assertEqual(content.headers["content-type"], "text/markdown")
        self.assertNotIn("idempotency-key", content.headers)
        self.assertNotIn("authorization", content.headers)
        self.assertEqual(content.content, b"# Exact\n\nViolet bytes.\n")
        self.assertEqual(
            calls[2].url.path,
            "/v1/document-uploads/asset_upload/complete",
        )

    def test_structured_error(self) -> None:
        def handler(_: httpx.Request) -> httpx.Response:
            return response(
                {
                    "code": "INVALID_REQUEST",
                    "message": "scope required",
                    "request_id": "req_1",
                },
                400,
            )

        with FishMem(
            api_key="fm_test", transport=httpx.MockTransport(handler)
        ) as client:
            with self.assertRaises(FishMemError) as caught:
                client.memories.search({"query": "tea"})
        self.assertEqual(caught.exception.status, 400)
        self.assertEqual(caught.exception.code, "INVALID_REQUEST")
        self.assertEqual(caught.exception.request_id, "req_1")


class AsyncFishMemClientTest(unittest.IsolatedAsyncioTestCase):
    async def test_async_structural_scope_entities_resource(self) -> None:
        calls: list[httpx.Request] = []
        now = "2026-07-31T00:00:00.000Z"
        entity = {
            "id": "agent/codex",
            "type": "agent",
            "total_memories": 2,
            "created_at": now,
            "updated_at": now,
        }

        async def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            if request.url.path == "/v1/entities":
                return response({"results": [entity], "next_cursor": None})
            if request.method == "GET":
                return response(entity)
            return response(
                {
                    "id": entity["id"],
                    "type": entity["type"],
                    "deleted_memories": 2,
                }
            )

        async with AsyncFishMem(
            api_key="fm_test", transport=httpx.MockTransport(handler)
        ) as client:
            found = [
                item async for item in client.entities.list_all(
                    entity_type="agent"
                )
            ]
            fetched = await client.entities.get("agent", "agent/codex")
            deleted = await client.entities.delete(
                "agent",
                "agent/codex",
                idempotency_key="delete-agent-codex-1",
            )

        self.assertEqual(found, [entity])
        self.assertEqual(fetched, entity)
        self.assertEqual(deleted["deleted_memories"], 2)
        self.assertEqual(calls[0].url.params["type"], "agent")
        self.assertEqual(
            calls[1].url.raw_path,
            b"/v1/entities/agent/agent%2Fcodex",
        )
        self.assertEqual(
            calls[2].headers["idempotency-key"],
            "delete-agent-codex-1",
        )

    async def test_async_inference_event_wait(self) -> None:
        polls = 0

        async def handler(request: httpx.Request) -> httpx.Response:
            nonlocal polls
            if request.url.path == "/v1/memories":
                return response(
                    {
                        "message": "Memory inference accepted",
                        "status": "PENDING",
                        "event_id": "task_async",
                    },
                    202,
                )
            if request.url.path == "/v1/events/task_async":
                polls += 1
                return response(
                    {
                        "id": "task_async",
                        "status": "SUCCEEDED",
                        "results": [
                            {
                                "id": "m1",
                                "memory": "Ada prefers tea",
                                "event": "ADD",
                            }
                        ],
                    }
                )
            raise AssertionError(f"Unexpected request: {request.url.path}")

        async with AsyncFishMem(
            api_key="fm_test",
            transport=httpx.MockTransport(handler),
        ) as client:
            result = await client.memories.add_and_wait(
                {"content": "Ada prefers tea", "user_id": "ada"},
                idempotency_key="async-conversation-1",
                interval=0,
                timeout=1,
            )
        self.assertEqual(result["results"][0]["id"], "m1")
        self.assertEqual(polls, 1)

    async def test_async_client_uses_the_same_contract(self) -> None:
        async def handler(request: httpx.Request) -> httpx.Response:
            self.assertEqual(request.headers["authorization"], "Bearer fm_test")
            if request.url.path == "/v1/health":
                return response({"status": "ok"})
            if request.url.path == "/v1/documents/search":
                return response({"results": []})
            if request.url.path == "/v1/memories/batch":
                return response(
                    {
                        "id": "batch_1",
                        "kind": "batch_update",
                        "status": "pending",
                    },
                    202,
                )
            if request.url.path == "/v1/document-uploads/asset_1":
                return httpx.Response(204)
            if request.url.path == "/v1/operations/op_1/retry":
                return response(
                    {
                        "id": "op_1",
                        "kind": "document_extract",
                        "status": "pending",
                    },
                    202,
                )
            if request.url.path == "/v1/beliefs":
                return response(
                    {
                        "data": {
                            "projection_status": "ready",
                            "winner": None,
                            "candidates": [],
                        }
                    }
                )
            return response({"results": [], "next_cursor": None})

        async with AsyncFishMem(
            api_key="fm_test",
            transport=httpx.MockTransport(handler),
        ) as client:
            page = await client.memories.list({"user_id": "ada"})
            documents = await client.documents.search(
                {"query": "violet", "user_id": "ada"}
            )
            health = await client.health.get()
            batch = await client.memories.batch_update(
                [{"memory_id": "m1", "content": "updated"}],
                idempotency_key="async-batch-1",
            )
            self.assertIsNone(
                await client.documents.delete_upload("asset_1")
            )
            retry = await client.operations.retry("op_1")
            beliefs = await client.beliefs.get(
                {
                    "user_id": "ada",
                    "subject": "Ada",
                    "attribute": "drink",
                }
            )
        self.assertEqual(page, {"results": [], "next_cursor": None})
        self.assertEqual(documents, {"results": []})
        self.assertEqual(health, {"status": "ok"})
        self.assertEqual(batch["kind"], "batch_update")
        self.assertEqual(retry["status"], "pending")
        self.assertEqual(beliefs["projection_status"], "ready")

    async def test_async_document_upload_uses_the_same_asset_contract(
        self,
    ) -> None:
        calls: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            if request.url.path == "/v1/document-uploads":
                return response(
                    {
                        "source_asset": {
                            "id": "asset_async",
                            "status": "awaiting_upload",
                        },
                        "upload": {
                            "method": "PUT",
                            "url": "https://uploads.example/signed/asset_async",
                            "headers": {"content-type": "text/plain"},
                            "max_bytes": 25_000_000,
                        },
                        "operation": {
                            "id": "task_async",
                            "status": "awaiting_upload",
                        },
                    }
                )
            if (
                request.url.host == "uploads.example"
                and request.url.path == "/signed/asset_async"
            ):
                return httpx.Response(204)
            if request.url.path.endswith("/asset_async/complete"):
                return response(
                    {
                        "source_asset": {
                            "id": "asset_async",
                            "status": "queued",
                        },
                        "operation": {
                            "id": "task_async",
                            "status": "pending",
                        },
                    },
                    202,
                )
            return response({"message": "unexpected request"}, 500)

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "async.txt"
            source.write_bytes(b"async exact bytes")
            async with AsyncFishMem(
                api_key="fm_test",
                transport=httpx.MockTransport(handler),
            ) as client:
                result = await client.documents.upload(
                    source,
                    {"agent_id": "codex"},
                    idempotency_key="async-upload-1",
                )

        self.assertEqual(result["source_asset"]["id"], "asset_async")
        self.assertEqual(result["operation"]["status"], "pending")
        self.assertEqual(len(calls), 3)
        self.assertEqual(calls[1].content, b"async exact bytes")
        self.assertEqual(calls[1].headers["content-type"], "text/plain")
        self.assertNotIn("authorization", calls[1].headers)


class FishMemDesktopTest(unittest.TestCase):
    def test_structural_scope_entities_use_desktop_cli_bridge(self) -> None:
        calls: list[tuple[list[str], str | None]] = []
        now = "2026-07-31T00:00:00.000Z"
        first = {
            "id": "ada/team",
            "type": "user",
            "total_memories": 2,
            "created_at": now,
            "updated_at": now,
        }
        second = {
            "id": "run-2",
            "type": "run",
            "total_memories": 1,
            "created_at": now,
            "updated_at": now,
        }
        list_calls = 0

        def runner(
            args: list[str] | tuple[str, ...],
            _timeout: float,
            stdin: str | None,
        ) -> subprocess.CompletedProcess[str]:
            nonlocal list_calls
            calls.append((list(args), stdin))
            method = args[2]
            if method == "entityList":
                list_calls += 1
                payload = (
                    {"results": [first], "next_cursor": "page-2"}
                    if list_calls == 1
                    else {"results": [second], "next_cursor": None}
                )
            elif method == "entityGet":
                payload = first
            else:
                payload = {
                    "id": first["id"],
                    "type": first["type"],
                    "deleted_memories": 2,
                }
            return subprocess.CompletedProcess(
                args, 0, stdout=json.dumps(payload), stderr=""
            )

        desktop = FishMemDesktop(command="/opt/fishmem", runner=runner)
        self.assertEqual(
            [entity["id"] for entity in desktop.entities.list_all(limit=1)],
            ["ada/team", "run-2"],
        )
        self.assertEqual(
            desktop.entities.get("user", "ada/team"), first
        )
        self.assertEqual(
            desktop.entities.delete(
                "user",
                "ada/team",
                idempotency_key="desktop-entity-delete-1",
            )["deleted_memories"],
            2,
        )
        with self.assertRaisesRegex(
            ValueError,
            "entities.delete requires a non-empty idempotency_key",
        ):
            desktop.entities.delete("user", "ada", idempotency_key=" ")

        self.assertEqual(
            [call[0][2] for call in calls],
            ["entityList", "entityList", "entityGet", "entityDelete"],
        )
        self.assertEqual(
            json.loads(calls[1][1] or ""),
            {"cursor": "page-2", "limit": 1},
        )
        self.assertEqual(
            json.loads(calls[3][1] or "")["idempotency_key"],
            "desktop-entity-delete-1",
        )

    def test_advanced_filters_use_the_desktop_cli_bridge(self) -> None:
        calls: list[tuple[list[str], str | None]] = []

        def runner(
            args: list[str] | tuple[str, ...],
            _timeout: float,
            stdin: str | None,
        ) -> subprocess.CompletedProcess[str]:
            calls.append((list(args), stdin))
            return subprocess.CompletedProcess(
                args,
                0,
                stdout=json.dumps({"results": []}),
                stderr="",
            )

        desktop = FishMemDesktop(command="/opt/fishmem", runner=runner)
        desktop.memories.search(
            {
                "query": "support ticket",
                "user_id": "ada",
                "filters": {
                    "not": {
                        "field": "content",
                        "operator": "icontains",
                        "value": "resolved",
                    }
                },
            }
        )

        self.assertEqual(
            calls[0][0],
            ["/opt/fishmem", "call", "search", "--input-stdin"],
        )
        self.assertEqual(
            json.loads(calls[0][1] or "")["filters"],
            {
                "not": {
                    "field": "content",
                    "operator": "icontains",
                    "value": "resolved",
                }
            },
        )

    def test_feedback_uses_the_desktop_cli_bridge(self) -> None:
        calls: list[tuple[list[str], str | None]] = []

        def runner(
            args: list[str] | tuple[str, ...],
            _timeout: float,
            stdin: str | None,
        ) -> subprocess.CompletedProcess[str]:
            calls.append((list(args), stdin))
            method = args[2]
            payload = (
                {"feedback": None}
                if method == "getFeedback"
                else {"cleared": True}
                if method == "clearFeedback"
                else {
                    "feedback": {
                        "id": "feedback_1",
                        "memory_id": "m1",
                        "rating": "positive",
                        "reason": None,
                        "request_id": "req_1",
                        "created_at": "2026-07-31T00:00:00.000Z",
                    }
                }
            )
            return subprocess.CompletedProcess(
                args, 0, stdout=json.dumps(payload), stderr=""
            )

        desktop = FishMemDesktop(command="/opt/fishmem", runner=runner)
        desktop.memories.get_feedback("m1")
        desktop.memories.set_feedback(
            "m1",
            {"rating": "positive", "request_id": "req_1"},
            idempotency_key="feedback-set-1",
        )
        desktop.memories.clear_feedback(
            "m1", idempotency_key="feedback-clear-1"
        )

        self.assertEqual(
            [call[0][2] for call in calls],
            ["getFeedback", "setFeedback", "clearFeedback"],
        )
        self.assertEqual(
            json.loads(calls[1][1] or ""),
            {
                "id": "m1",
                "rating": "positive",
                "request_id": "req_1",
                "idempotency_key": "feedback-set-1",
            },
        )

    def test_cli_arguments_are_not_shell_interpreted(self) -> None:
        calls: list[tuple[list[str], float, str | None]] = []

        def runner(
            args: list[str] | tuple[str, ...],
            timeout: float,
            stdin: str | None,
        ) -> subprocess.CompletedProcess[str]:
            calls.append((list(args), timeout, stdin))
            return subprocess.CompletedProcess(
                args,
                0,
                stdout=json.dumps(
                    {
                        "results": [
                            {
                                "id": "m1",
                                "memory": "Remember $HOME and `backticks`",
                                "event": "ADD",
                            }
                        ]
                    }
                ),
                stderr="",
            )

        desktop = FishMemDesktop(command="/opt/fishmem", runner=runner)
        desktop.memories.add(
            {
                "content": "Remember $HOME and `backticks`",
                "user_id": "ada",
                "infer": False,
            },
            idempotency_key="add-1",
        )
        desktop.memories.delete_all(
            {"user_id": "ada"}, idempotency_key="delete-all-ada"
        )

        args, _, stdin = calls[0]
        self.assertEqual(
            args, ["/opt/fishmem", "call", "add", "--input-stdin"]
        )
        self.assertEqual(
            json.loads(stdin or ""),
            {
                "content": "Remember $HOME and `backticks`",
                "user_id": "ada",
                "infer": False,
                "idempotency_key": "add-1",
            },
        )
        delete_args, _, delete_stdin = calls[1]
        self.assertEqual(
            delete_args,
            ["/opt/fishmem", "call", "deleteAll", "--input-stdin"],
        )
        self.assertEqual(
            json.loads(delete_stdin or ""),
            {
                "user_id": "ada",
                "idempotency_key": "delete-all-ada",
            },
        )

    def test_documents_use_the_desktop_cli_bridge(self) -> None:
        calls: list[tuple[list[str], str | None]] = []

        def runner(
            args: list[str] | tuple[str, ...],
            _timeout: float,
            stdin: str | None,
        ) -> subprocess.CompletedProcess[str]:
            calls.append((list(args), stdin))
            return subprocess.CompletedProcess(
                args,
                0,
                stdout=json.dumps(
                    {
                        "document": {
                            "id": "d1",
                            "source_key": "docs/guide.md",
                        },
                        "chunks": 1,
                        "created": True,
                    }
                ),
                stderr="",
            )

        desktop = FishMemDesktop(command="/opt/fishmem", runner=runner)
        result = desktop.documents.ingest(
            {
                "source_key": "docs/guide.md",
                "content": "source body",
                "mime_type": "text/markdown",
            },
            idempotency_key="document-1",
        )

        self.assertEqual(result["document"]["id"], "d1")
        args, stdin = calls[0]
        self.assertEqual(
            args,
            [
                "/opt/fishmem",
                "call",
                "documentIngest",
                "--input-stdin",
            ],
        )
        self.assertEqual(
            json.loads(stdin or "")["idempotency_key"], "document-1"
        )

    def test_batch_uses_one_desktop_cli_call(self) -> None:
        calls: list[tuple[list[str], str | None]] = []

        def runner(
            args: list[str] | tuple[str, ...],
            _timeout: float,
            stdin: str | None,
        ) -> subprocess.CompletedProcess[str]:
            calls.append((list(args), stdin))
            return subprocess.CompletedProcess(
                args,
                0,
                stdout=json.dumps(
                    {
                        "id": "desktop_batch_1",
                        "kind": "batch_update",
                        "status": "success",
                        "result": {"succeeded": 1, "failed": 0},
                    }
                ),
                stderr="",
            )

        desktop = FishMemDesktop(command="/opt/fishmem", runner=runner)
        result = desktop.memories.batch_update(
            [{"memory_id": "m1", "content": "Updated"}],
            idempotency_key="desktop-batch-1",
        )

        self.assertEqual(result["kind"], "batch_update")
        args, stdin = calls[0]
        self.assertEqual(
            args,
            ["/opt/fishmem", "call", "batchUpdate", "--input-stdin"],
        )
        self.assertEqual(
            json.loads(stdin or ""),
            {
                "memories": [
                    {"memory_id": "m1", "content": "Updated"}
                ],
                "idempotency_key": "desktop-batch-1",
            },
        )

    def test_document_upload_decodes_locally_for_desktop(self) -> None:
        calls: list[tuple[list[str], str | None]] = []

        def runner(
            args: list[str] | tuple[str, ...],
            _timeout: float,
            stdin: str | None,
        ) -> subprocess.CompletedProcess[str]:
            calls.append((list(args), stdin))
            return subprocess.CompletedProcess(
                args,
                0,
                stdout=json.dumps(
                    {
                        "document": {"id": "d-upload"},
                        "chunks": 1,
                        "created": True,
                    }
                ),
                stderr="",
            )

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "desktop.md"
            source.write_bytes(b"# Exact desktop bytes\n")
            desktop = FishMemDesktop(command="/opt/fishmem", runner=runner)
            result = desktop.documents.upload(
                source,
                {
                    "source_key": "docs/desktop.md",
                    "agent_id": "codex",
                },
                idempotency_key="desktop-upload-1",
            )

        self.assertEqual(result["document"]["id"], "d-upload")
        payload = json.loads(calls[0][1] or "")
        self.assertEqual(payload["content"], "# Exact desktop bytes\n")
        self.assertEqual(payload["source_key"], "docs/desktop.md")
        self.assertEqual(payload["idempotency_key"], "desktop-upload-1")


if __name__ == "__main__":
    unittest.main()
