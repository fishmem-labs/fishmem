"""The Python client may only call operations the public OpenAPI contract
documents. The fixture is generated from ``@fishmem/contracts`` and a
contracts test fails when it is stale, so contract changes surface here."""

from __future__ import annotations

import ast
import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLIENT = ROOT / "src" / "fishmem" / "_client.py"
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "openapi-operations.json"
HTTP_METHODS = {"GET", "PUT", "POST", "DELETE", "PATCH", "HEAD", "OPTIONS"}


def _template(node: ast.expr) -> str | None:
    """Render a literal or f-string path with every placeholder as ``{}``."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr):
        parts: list[str] = []
        for value in node.values:
            if isinstance(value, ast.Constant):
                parts.append(str(value.value))
            else:
                parts.append("{}")
        return "".join(parts)
    return None


def client_operations() -> set[tuple[str, str]]:
    tree = ast.parse(CLIENT.read_text(encoding="utf-8"))
    operations: set[tuple[str, str]] = set()
    for node in ast.walk(tree):
        if not (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "request"
            and len(node.args) >= 2
        ):
            continue
        method, path = node.args[0], node.args[1]
        if not (
            isinstance(method, ast.Constant)
            and isinstance(method.value, str)
            and method.value.upper() in HTTP_METHODS
        ):
            continue
        template = _template(path)
        if template is not None and template.startswith("/v1/"):
            operations.add((method.value.upper(), template))
    return operations


def contract_operations() -> set[tuple[str, str]]:
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    operations: set[tuple[str, str]] = set()
    for entry in fixture["operations"]:
        method, path = entry.split(" ", 1)
        operations.add((method, re.sub(r"\{[^}]+\}", "{}", path)))
    return operations


class OpenApiRouteConformanceTest(unittest.TestCase):
    def test_client_calls_only_documented_operations(self) -> None:
        client = client_operations()
        # Guard against the AST scan silently matching nothing.
        self.assertGreater(len(client), 20)
        undocumented = sorted(client - contract_operations())
        self.assertEqual(
            undocumented,
            [],
            "Python client calls operations missing from the OpenAPI contract",
        )


if __name__ == "__main__":
    unittest.main()
