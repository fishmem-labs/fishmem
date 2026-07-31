import { app, BrowserWindow, ipcMain } from "electron";
import { randomBytes } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { DesktopMemoryService } from "./memory-service";
import { IntegrationService } from "./integration-service";
import { startRpcServer } from "./rpc-server";
import type {
  DesktopIpcMethod,
  IntegrationClient,
} from "../shared/protocol";

let mainWindow: BrowserWindow | undefined;
let service: DesktopMemoryService;
let integrationService: IntegrationService;
let socketPath: string;

async function bootstrap() {
  if (process.platform === "darwin" && !app.isPackaged) {
    if (!app.dock) throw new Error("macOS Dock integration is unavailable");
    app.dock.setIcon(join(app.getAppPath(), "build", "icon.png"));
  }
  const userData = app.getPath("userData");
  // Remote embedding support was removed. Delete the exact legacy settings
  // file so an encrypted provider key is not retained on disk.
  await rm(join(userData, "config.json"), { force: true });
  socketPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\fishmem-desktop-${process.env.USERNAME ?? "user"}`
      : join(tmpdir(), `fishmem-desktop-${process.getuid?.() ?? "user"}.sock`);
  service = new DesktopMemoryService(
    join(userData, "fishmem.db"),
    join(userData, "models"),
    socketPath,
  );
  integrationService = new IntegrationService(
    app.isPackaged
      ? join(process.resourcesPath, "bin", platformCliName())
      : join(app.getAppPath(), "out", "cli", platformCliName()),
    app.isPackaged
      ? join(process.resourcesPath, "skills", "fishmem")
      : join(app.getAppPath(), "resources", "skills", "fishmem"),
  );
  await service.initialize();
  ipcMain.handle(
    "fishmem:invoke",
    (_event, method: DesktopIpcMethod, params?: unknown) => {
      if (method === "integrationStatus") return integrationService.status();
      if (method === "connectIntegration") {
        return integrationService.connect(integrationClient(params));
      }
      if (method === "disconnectIntegration") {
        return integrationService.disconnect(integrationClient(params));
      }
      return service.invoke(method, params);
    },
  );
  await startRpcServer({
    service,
    socketPath,
    token: randomBytes(32).toString("hex"),
    descriptorPath: join(homedir(), ".fishmem", "desktop.json"),
  });
  createWindow();
}

function integrationClient(params: unknown): IntegrationClient {
  const client = (params as { client?: unknown } | undefined)?.client;
  if (client !== "codex" && client !== "claude-code") {
    throw new Error("Integration client must be codex or claude-code");
  }
  return client;
}

function platformCliName() {
  return process.platform === "win32" ? "fishmem.exe" : "fishmem";
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 960,
    minHeight: 700,
    title: "FishMem",
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.whenReady().then(bootstrap).catch((error) => {
    console.error(error);
    app.quit();
  });
}
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
app.on("before-quit", () => {
  if (service) void service.close();
  if (process.platform !== "win32" && socketPath) {
    void rm(socketPath, { force: true });
  }
});
