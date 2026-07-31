import {
  access,
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
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
    const [codexCurrent, claudeCurrent] = await Promise.all([
      this.skillIsCurrent("codex"),
      this.skillIsCurrent("claude-code"),
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
      },
    };
  }

  async connect(client: IntegrationClient) {
    await this.installCli();
    await this.installSkill(client);
    return this.status();
  }

  async disconnect(client: IntegrationClient) {
    await rm(this.skillPath(client), { recursive: true, force: true });
    return this.status();
  }

  private skillPath(client: IntegrationClient) {
    return client === "codex"
      ? join(this.homePath, ".agents", "skills", "fishmem")
      : join(this.homePath, ".claude", "skills", "fishmem");
  }

  private async installCli() {
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

async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
