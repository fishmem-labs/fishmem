import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PYTHON_OPENAPI_FIXTURE,
  renderOpenApiFixture,
} from "./openapi-operations";

const path = fileURLToPath(PYTHON_OPENAPI_FIXTURE);
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, renderOpenApiFixture());
console.log(`wrote ${path}`);
