import { describe, expect, it } from "vitest";
import {
  readMachOSignatureBoundary,
  repairBunMachOSignature,
} from "../../scripts/repair-bun-macho-signature.mjs";

function machoFixture({ signatureBytes = 20, staleTailBytes = 6 } = {}) {
  const signatureOffset = 64;
  const bytes = Buffer.alloc(
    signatureOffset + signatureBytes + staleTailBytes,
  );
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(1, 16);
  bytes.writeUInt32LE(0x1d, 32);
  bytes.writeUInt32LE(16, 36);
  bytes.writeUInt32LE(signatureOffset, 40);
  bytes.writeUInt32LE(signatureBytes, 44);
  return bytes;
}

describe("Bun Mach-O signature repair", () => {
  it("finds the canonical signature boundary and stale template tail", () => {
    expect(readMachOSignatureBoundary(machoFixture())).toEqual({
      dataOffset: 64,
      dataBytes: 20,
      signatureEnd: 84,
      staleTailBytes: 6,
    });
  });

  it("rejects malformed load commands", () => {
    const bytes = machoFixture();
    bytes.writeUInt32LE(bytes.byteLength + 1, 36);
    expect(() => readMachOSignatureBoundary(bytes)).toThrow(
      "load command is out of bounds",
    );
  });

  it("is a no-op outside macOS", async () => {
    await expect(
      repairBunMachOSignature("/does/not/exist", "linux"),
    ).resolves.toEqual({ repaired: false, staleTailBytes: 0 });
  });
});
