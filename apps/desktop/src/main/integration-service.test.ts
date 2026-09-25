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

  it("installs Claude Code recall hooks on connect and removes them on disconnect", async () => {
    const home = await mkdtemp(join(tmpdir(), "fishmem-integration-"));
    homes.push(home);
    const source = join(home, "source");
    const cli = join(source, "fishmem");
    const skill = join(source, "skill");
    await mkdir(skill, { recursive: true });
    await writeFile(cli, "fishmem-cli");
    await writeFile(join(skill, "SKILL.md"), "skill {{FISHMEM_CLIENT}}");
    const settingsPath = join(home, ".claude", "settings.json");
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify({ model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } }),
    );
    const service = new IntegrationService(cli, skill, home);
    const installedCli = join(home, ".fishmem", "bin", "fishmem");

    const connected = await service.connect("claude-code");
    expect(connected.claudeCode.hooks).toBe(true);
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(settings.model).toBe("opus");
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toBe(
      `${installedCli} hook prompt`,
    );
    // Reconnecting does not duplicate hooks.
    await service.connect("claude-code");
    const again = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(again.hooks.SessionStart).toHaveLength(1);
    expect(again.hooks.UserPromptSubmit).toHaveLength(1);

    // Codex connect never touches Claude settings.
    await service.connect("codex");
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual(again);

    const disconnected = await service.disconnect("claude-code");
    expect(disconnected.claudeCode.hooks).toBe(false);
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
      model: "opus",
      hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] },
    });
  });

  it("leaves invalid Claude settings untouched", async () => {
    const home = await mkdtemp(join(tmpdir(), "fishmem-integration-"));
    homes.push(home);
    const cli = join(home, "fishmem");
    const skill = join(home, "skill");
    await mkdir(skill, { recursive: true });
    await writeFile(cli, "cli");
    await writeFile(join(skill, "SKILL.md"), "skill");
    await mkdir(join(home, ".claude"), { recursive: true });
    const settingsPath = join(home, ".claude", "settings.json");
    await writeFile(settingsPath, "{ broken");
    const service = new IntegrationService(cli, skill, home);
    await expect(service.connect("claude-code")).rejects.toThrow("not valid JSON");
    expect(await readFile(settingsPath, "utf8")).toBe("{ broken");
  });
});
