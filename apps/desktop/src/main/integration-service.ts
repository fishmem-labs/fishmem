import {
  access,
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  hasFishMemHooks,
  mergeFishMemHooks,
  parseClaudeSettings,
  removeFishMemHooks,
  type ClaudeSettings,
} from "./claude-hooks";
import type {
  IntegrationClient,
  IntegrationStatus,
} from "../shared/protocol";

export class IntegrationService {
  private readonly cliPath: string;
  private readonly commandPath: string;

  constructor(
    private readonly cliSourcePath: string,
    private readonly skillSourcePath: string,
    private readonly homePath = homedir(),
  ) {
    this.cliPath = join(
      this.homePath,
      ".fishmem",
      "bin",
      process.platform === "win32" ? "fishmem.exe" : "fishmem",
    );
    this.commandPath =
      process.platform === "win32"
        ? this.cliPath
        : join(this.homePath, ".local", "bin", "fishmem");
  }

  async status(): Promise<IntegrationStatus> {
    const cliInstalled = await exists(this.cliPath);
    const [codexCurrent, claudeCurrent, claudeHooks] = await Promise.all([
      this.skillIsCurrent("codex"),
      this.skillIsCurrent("claude-code"),
      this.claudeHooksInstalled(),
    ]);
    return {
      cliPath: this.cliPath,
      commandPath: this.commandPath,
      codex: {
        connected: cliInstalled && codexCurrent,
        skillPath: this.skillPath("codex"),
      },
      claudeCode: {
        connected: cliInstalled && claudeCurrent,
        skillPath: this.skillPath("claude-code"),
        hooks: cliInstalled && claudeHooks,
      },
    };
  }

  async connect(client: IntegrationClient) {
    // Validate Claude settings before changing anything on disk.
    if (client === "claude-code") await this.readClaudeSettings();
    await this.installCli();
    await this.installSkill(client);
    // Codex has no documented prompt-submit context hook; its recall stays
    // skill-driven. Claude Code gets automatic recall hooks.
    if (client === "claude-code") await this.installClaudeHooks();
    return this.status();
  }

  async disconnect(client: IntegrationClient) {
    await rm(this.skillPath(client), { recursive: true, force: true });
    if (client === "claude-code") await this.removeClaudeHooks();
    return this.status();
  }

  get claudeSettingsPath() {
    return join(this.homePath, ".claude", "settings.json");
  }

  private async readClaudeSettings(): Promise<ClaudeSettings | undefined> {
    let text: string;
    try {
      text = await readFile(this.claudeSettingsPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    return parseClaudeSettings(text, this.claudeSettingsPath);
  }

  private async writeClaudeSettings(settings: ClaudeSettings) {
    const path = this.claudeSettingsPath;
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = join(
      dirname(path),
      `.${basename(path)}.${crypto.randomUUID()}.tmp`,
    );
    try {
      await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporaryPath, path);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  private async installClaudeHooks() {
    const settings = (await this.readClaudeSettings()) ?? {};
    await this.writeClaudeSettings(mergeFishMemHooks(settings, this.cliPath));
  }

  private async removeClaudeHooks() {
    const settings = await this.readClaudeSettings();
    if (!settings) return;
    const next = removeFishMemHooks(settings);
    if (JSON.stringify(next) !== JSON.stringify(settings)) {
      await this.writeClaudeSettings(next);
    }
  }

  private async claudeHooksInstalled() {
    try {
      const settings = await this.readClaudeSettings();
      return settings ? hasFishMemHooks(settings, this.cliPath) : false;
    } catch {
      return false;
    }
  }

  private skillPath(client: IntegrationClient) {
    return client === "codex"
      ? join(this.homePath, ".agents", "skills", "fishmem")
      : join(this.homePath, ".claude", "skills", "fishmem");
  }

  private async installCli() {
    if (await samePath(this.cliSourcePath, this.cliPath)) {
      // Invoked from the installed CLI itself; nothing to copy.
      if (process.platform !== "win32") await this.installCommandLink();
      return;
    }
    await mkdir(dirname(this.cliPath), { recursive: true });
    const temporaryPath = `${this.cliPath}.${crypto.randomUUID()}.tmp`;
    await copyFile(this.cliSourcePath, temporaryPath);
    if (process.platform !== "win32") await chmod(temporaryPath, 0o755);
    if (process.platform === "win32") {
      await rm(this.cliPath, { force: true });
    }
    await rename(temporaryPath, this.cliPath);
    if (process.platform !== "win32") await this.installCommandLink();
  }

  private async installCommandLink() {
    await mkdir(dirname(this.commandPath), { recursive: true });
    try {
      const entry = await lstat(this.commandPath);
      if (!entry.isSymbolicLink()) {
        throw new Error(
          `${this.commandPath} already exists and is not managed by FishMem`,
        );
      }
      const target = await readlink(this.commandPath);
      if (target !== this.cliPath) {
        throw new Error(
          `${this.commandPath} already points to another executable`,
        );
      }
      await rm(this.commandPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await symlink(this.cliPath, this.commandPath);
  }

  private async installSkill(client: IntegrationClient) {
    const targetPath = this.skillPath(client);
    await mkdir(dirname(targetPath), { recursive: true });
    const temporaryPath = join(
      dirname(targetPath),
      `${basename(targetPath)}.${crypto.randomUUID()}.tmp`,
    );
    await cp(this.skillSourcePath, temporaryPath, { recursive: true });
    await writeFile(
      join(temporaryPath, "SKILL.md"),
      await this.renderSkill(client),
      "utf8",
    );
    await rm(targetPath, { recursive: true, force: true });
    await rename(temporaryPath, targetPath);
  }

  private async skillIsCurrent(client: IntegrationClient) {
    try {
      const [source, installed] = await Promise.all([
        this.renderSkill(client),
        readFile(join(this.skillPath(client), "SKILL.md"), "utf8"),
      ]);
      return source === installed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private async renderSkill(client: IntegrationClient) {
    const source = await readFile(
      join(this.skillSourcePath, "SKILL.md"),
      "utf8",
    );
    return source.replaceAll("{{FISHMEM_CLIENT}}", client);
  }
}

async function samePath(left: string, right: string) {
  const canonical = async (path: string) => {
    try {
      return await realpath(path);
    } catch {
      return resolve(path);
    }
  };
  return (await canonical(left)) === (await canonical(right));
}

async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
