import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PYTHON_OPENAPI_FIXTURE,
  renderOpenApiFixture,
} from "../scripts/openapi-operations";

describe("Python SDK OpenAPI fixture", () => {
  it("matches the current contract (regenerate with the script it names)", () => {
    expect(readFileSync(PYTHON_OPENAPI_FIXTURE, "utf8")).toBe(
      renderOpenApiFixture(),
    );
  });
});
