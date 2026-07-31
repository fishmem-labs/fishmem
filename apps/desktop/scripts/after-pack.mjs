import { rm } from "node:fs/promises";
import { join } from "node:path";

export default async function afterPack(context) {
  const isUniversalMacRelease =
    process.env.FISHMEM_MAC_UNIVERSAL === "1" &&
    context.electronPlatformName === "darwin";

  // mac.files excludes non-macOS ONNX assets before ASAR creation. Mutating
  // app.asar.unpacked afterwards would leave stale entries in the ASAR header
  // and make @electron/universal unable to merge the two packages.
  if (isUniversalMacRelease) return;

  // electron-builder invokes afterPack for each thin app and once more after
  // @electron/universal merges them. Non-Universal packages retain the normal
  // target-specific pruning behavior.
  const architecture =
    context.arch === 3 ? "arm64" : context.arch === 1 ? "x64" : undefined;
  if (!architecture) return;

  const resourcesRoot =
    context.electronPlatformName === "darwin"
      ? join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          "Contents",
          "Resources",
        )
      : join(context.appOutDir, "resources");
  const resources = join(resourcesRoot, "app.asar.unpacked");
  const nodeModules = join(resources, "node_modules");
  const onnxPlatforms = join(
    nodeModules,
    "onnxruntime-node",
    "bin",
    "napi-v6",
  );
  const platform =
    context.electronPlatformName === "darwin"
      ? "darwin"
      : context.electronPlatformName === "win32"
        ? "win32"
        : "linux";
  for (const candidatePlatform of ["darwin", "linux", "win32"]) {
    for (const candidateArchitecture of ["arm64", "x64"]) {
      if (
        candidatePlatform === platform &&
        candidateArchitecture === architecture
      ) {
        continue;
      }
      await rm(
        join(onnxPlatforms, candidatePlatform, candidateArchitecture),
        { recursive: true, force: true },
      );
    }
  }
}
