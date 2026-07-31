import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { invokeDesktop } from "../bridge/client";

type DesktopStartDependencies = {
  status(): Promise<unknown>;
  launch(): Promise<void>;
  now(): number;
  wait(delayMs: number): Promise<void>;
};

export async function startDesktop(
  options: { timeoutMs?: number } = {},
  dependencies: DesktopStartDependencies = {
    status: () => invokeDesktop("status"),
    launch: () => launchDesktopApplication(),
    now: Date.now,
    wait,
  },
) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const startedAt = dependencies.now();
  try {
    const desktop = await dependencies.status();
    return {
      status: "ready" as const,
      launched: false,
      waited_ms: 0,
      desktop,
    };
  } catch {
    await dependencies.launch();
  }

  const deadline = startedAt + timeoutMs;
  let lastError: unknown;
  while (dependencies.now() < deadline) {
    try {
      const desktop = await dependencies.status();
      return {
        status: "ready" as const,
        launched: true,
        waited_ms: Math.max(0, dependencies.now() - startedAt),
        desktop,
      };
    } catch (error) {
      lastError = error;
      await dependencies.wait(250);
    }
  }
  throw new Error(
    `FishMem Desktop launched but did not become ready within ${
      timeoutMs / 1_000
    } seconds${lastError instanceof Error ? `: ${lastError.message}` : ""}`,
  );
}

export async function launchDesktopApplication(
  platform = process.platform,
  environment = process.env,
) {
  const override = environment.FISHMEM_DESKTOP_EXECUTABLE?.trim();
  if (platform === "darwin") {
    if (override) {
      await run("open", [override]);
      return;
    }
    try {
      await run("open", ["-b", "com.fishmem.desktop"]);
    } catch {
      await run("open", ["-a", "FishMem"]);
    }
    return;
  }

  if (override) {
    launchDetached(override);
    return;
  }

  if (platform === "win32") {
    const candidates = [
      environment.LOCALAPPDATA
        ? join(
            environment.LOCALAPPDATA,
            "Programs",
            "FishMem",
            "FishMem.exe",
          )
        : null,
      environment.ProgramFiles
        ? join(environment.ProgramFiles, "FishMem", "FishMem.exe")
        : null,
    ].filter((candidate): candidate is string => Boolean(candidate));
    for (const candidate of candidates) {
      try {
        await access(candidate);
        launchDetached(candidate);
        return;
      } catch {
        // Try the next installer location.
      }
    }
    throw new Error(
      "FishMem Desktop is not installed in a standard location. Set FISHMEM_DESKTOP_EXECUTABLE to its executable path.",
    );
  }

  const candidates = [
    join(homedir(), ".local", "bin", "fishmem-desktop"),
    "/usr/local/bin/fishmem-desktop",
    "/usr/bin/fishmem-desktop",
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      launchDetached(candidate);
      return;
    } catch {
      // Try the next installation location.
    }
  }
  try {
    await run("gtk-launch", ["fishmem"]);
  } catch {
    throw new Error(
      "FishMem Desktop could not be located. Set FISHMEM_DESKTOP_EXECUTABLE to the AppImage or executable path.",
    );
  }
}

function launchDetached(command: string) {
  const child = spawn(command, [], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function run(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    execFile(command, args, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function wait(delayMs: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}
