import { copyFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const packageRoot = new URL("../", import.meta.url);
const repositoryRoot = new URL("../../../", import.meta.url);
const action = process.argv[2];
const generatedFiles = ["LICENSE", "CHANGELOG.md"];

if (action === "prepare") {
  for (const fileName of generatedFiles) {
    copyFileSync(
      fileURLToPath(new URL(fileName, repositoryRoot)),
      fileURLToPath(new URL(fileName, packageRoot)),
    );
  }
} else if (action === "cleanup") {
  for (const fileName of generatedFiles) {
    rmSync(fileURLToPath(new URL(fileName, packageRoot)), { force: true });
  }
} else {
  throw new Error("Expected package-files action: prepare or cleanup");
}
