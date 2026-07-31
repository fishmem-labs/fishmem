import { copyFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../../../LICENSE", import.meta.url));
const target = fileURLToPath(new URL("../LICENSE", import.meta.url));
const action = process.argv[2];

if (action === "prepare") {
  copyFileSync(source, target);
} else if (action === "cleanup") {
  rmSync(target, { force: true });
} else {
  throw new Error("Expected package-license action: prepare or cleanup");
}
