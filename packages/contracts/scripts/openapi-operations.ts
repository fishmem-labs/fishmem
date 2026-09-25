import { openApiDocument } from "../src/index";

const HTTP_METHODS = new Set([
  "get",
  "put",
  "post",
  "delete",
  "patch",
  "head",
  "options",
]);

/** Sorted `METHOD /path/{param}` list of every documented public operation. */
export function openApiOperations(): string[] {
  const operations: string[] = [];
  for (const [path, item] of Object.entries(openApiDocument.paths)) {
    for (const method of Object.keys(item)) {
      if (HTTP_METHODS.has(method)) {
        operations.push(`${method.toUpperCase()} ${path}`);
      }
    }
  }
  return operations.sort();
}

/** Fixture consumed by the Python SDK route-conformance test. */
export const PYTHON_OPENAPI_FIXTURE = new URL(
  "../../python-sdk/tests/fixtures/openapi-operations.json",
  import.meta.url,
);

export function renderOpenApiFixture(): string {
  return `${JSON.stringify(
    {
      generatedBy:
        "pnpm exec tsx packages/contracts/scripts/write-python-openapi-fixture.ts (repo root)",
      operations: openApiOperations(),
    },
    null,
    2,
  )}\n`;
}
