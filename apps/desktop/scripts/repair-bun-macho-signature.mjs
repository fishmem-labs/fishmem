import { readFile, truncate } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const MACHO_64_LE_MAGIC = 0xfeedfacf;
const MACHO_64_HEADER_BYTES = 32;
const LOAD_COMMAND_HEADER_BYTES = 8;
const LC_CODE_SIGNATURE = 0x1d;

/**
 * Bun 1.3.13 leaves bytes from the template signature after the replacement
 * signature and hashes the last partial page incorrectly. Apple codesign cannot
 * replace that malformed signature until the stale tail is removed.
 *
 * Upstream: https://github.com/oven-sh/bun/issues/32159
 * Fix in progress: https://github.com/oven-sh/bun/pull/32162
 */
export function readMachOSignatureBoundary(bytes) {
  if (
    bytes.byteLength < MACHO_64_HEADER_BYTES ||
    bytes.readUInt32LE(0) !== MACHO_64_LE_MAGIC
  ) {
    throw new Error("Expected a thin little-endian 64-bit Mach-O executable");
  }

  const commandCount = bytes.readUInt32LE(16);
  let offset = MACHO_64_HEADER_BYTES;
  for (let index = 0; index < commandCount; index += 1) {
    if (offset + LOAD_COMMAND_HEADER_BYTES > bytes.byteLength) {
      throw new Error("Mach-O load command header is out of bounds");
    }
    const command = bytes.readUInt32LE(offset);
    const commandBytes = bytes.readUInt32LE(offset + 4);
    if (
      commandBytes < LOAD_COMMAND_HEADER_BYTES ||
      offset + commandBytes > bytes.byteLength
    ) {
      throw new Error("Mach-O load command is out of bounds");
    }
    if (command === LC_CODE_SIGNATURE) {
      if (commandBytes < 16) {
        throw new Error("Mach-O LC_CODE_SIGNATURE command is truncated");
      }
      const dataOffset = bytes.readUInt32LE(offset + 8);
      const dataBytes = bytes.readUInt32LE(offset + 12);
      const signatureEnd = dataOffset + dataBytes;
      if (
        signatureEnd < dataOffset ||
        dataOffset > bytes.byteLength ||
        signatureEnd > bytes.byteLength
      ) {
        throw new Error("Mach-O code signature is out of bounds");
      }
      return {
        dataOffset,
        dataBytes,
        signatureEnd,
        staleTailBytes: bytes.byteLength - signatureEnd,
      };
    }
    offset += commandBytes;
  }
  throw new Error("Mach-O executable has no LC_CODE_SIGNATURE command");
}

function runCodesign(args, executablePath) {
  const result = spawnSync("codesign", [...args, executablePath], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(`codesign ${args.join(" ")} failed: ${detail}`);
  }
}

export async function repairBunMachOSignature(
  executablePath,
  platform = process.platform,
) {
  if (platform !== "darwin") return { repaired: false, staleTailBytes: 0 };

  const bytes = await readFile(executablePath);
  const boundary = readMachOSignatureBoundary(bytes);
  if (boundary.staleTailBytes > 0) {
    await truncate(executablePath, boundary.signatureEnd);
  }

  // Rebuild the invalid last-page hash. electron-builder will replace this
  // ad-hoc signature with the configured Developer ID signature later.
  runCodesign(["--force", "--sign", "-"], executablePath);
  runCodesign(["--verify", "--strict", "--verbose=4"], executablePath);
  return {
    repaired: true,
    staleTailBytes: boundary.staleTailBytes,
  };
}

async function main() {
  const executablePath = process.argv[2];
  if (!executablePath) {
    throw new Error(
      "Usage: node repair-bun-macho-signature.mjs <executable>",
    );
  }
  const result = await repairBunMachOSignature(executablePath);
  if (result.repaired) {
    console.log(
      `Verified macOS CLI signature after removing ${result.staleTailBytes} stale bytes`,
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
