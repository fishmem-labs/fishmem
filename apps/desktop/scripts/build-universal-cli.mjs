import { spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { repairBunMachOSignature } from "./repair-bun-macho-signature.mjs";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = join(desktopRoot, "out", "cli", "fishmem");

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: desktopRoot,
      env: process.env,
      stdio: "inherit",
      ...options,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      reject(
        new Error(
          `${command} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`,
        ),
      );
    });
  });
}

if (process.platform !== "darwin") {
  throw new Error("Universal FishMem CLI builds require macOS and Apple's lipo tool");
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "fishmem-cli-universal-"));
const arm64Path = join(temporaryRoot, "fishmem-arm64");
const x64Path = join(temporaryRoot, "fishmem-x64");

try {
  await mkdir(dirname(outputPath), { recursive: true });
  await run("bun", [
    "build",
    "src/cli/index.ts",
    "--compile",
    "--minify",
    "--target=bun-darwin-arm64",
    `--outfile=${arm64Path}`,
  ]);
  await run("bun", [
    "build",
    "src/cli/index.ts",
    "--compile",
    "--minify",
    "--target=bun-darwin-x64",
    `--outfile=${x64Path}`,
  ]);

  // Bun 1.3.13 produces a malformed replaceable signature. Repair each thin
  // slice before lipo; the final ad-hoc signature is replaced by Developer ID
  // when electron-builder signs FishMem.app.
  await repairBunMachOSignature(arm64Path);
  await repairBunMachOSignature(x64Path);
  await rm(outputPath, { force: true });
  await run("lipo", [arm64Path, x64Path, "-create", "-output", outputPath]);
  await chmod(outputPath, 0o755);
  await run("codesign", ["--force", "--sign", "-", outputPath]);
  await run("codesign", ["--verify", "--strict", "--verbose=4", outputPath]);
  await run("lipo", [outputPath, "-verify_arch", "arm64", "x86_64"]);
  await run("lipo", ["-info", outputPath]);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
