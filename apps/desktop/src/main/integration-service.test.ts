import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IntegrationService } from "./integration-service";

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(
    homes.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("IntegrationService", () => {
  it("installs one CLI and client-specific skills", async () => {
    const home = await mkdtemp(join(tmpdir(), "fishmem-integration-"));
    homes.push(home);
    const source = join(home, "source");
    const cli = join(source, "fishmem");
    const skill = join(source, "skill");
    await mkdir(join(skill, "agents"), { recursive: true });
    await writeFile(cli, "fishmem-cli");
    await writeFile(
      join(skill, "SKILL.md"),
      "fishmem-skill {{FISHMEM_CLIENT}}",
    );
    await writeFile(join(skill, "agents", "openai.yaml"), "interface: {}");
    const service = new IntegrationService(cli, skill, home);

    expect((await service.status()).codex.connected).toBe(false);
    const connected = await service.connect("codex");
    expect(connected.codex.connected).toBe(true);
    expect(connected.claudeCode.connected).toBe(false);
    expect(
      await readFile(
        join(home, ".agents", "skills", "fishmem", "SKILL.md"),
        "utf8",
      ),
    ).toBe("fishmem-skill codex");
    await access(join(home, ".fishmem", "bin", "fishmem"));

    expect((await service.connect("claude-code")).claudeCode.connected).toBe(
      true,
    );
    expect((await service.disconnect("codex")).codex.connected).toBe(false);
  });
});
