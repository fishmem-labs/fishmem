import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { DesktopMemoryService } from "./memory-service";
import { IntegrationService } from "./integration-service";
import { startRpcServer } from "./rpc-server";
import type {
	DesktopIpcMethod,
	DesktopBackupResult,
	IntegrationClient,
} from "../shared/protocol";

let mainWindow: BrowserWindow | undefined;
let service: DesktopMemoryService;
let integrationService: IntegrationService;
let socketPath: string;
let descriptorPath: string;
let rpcServer: Server | undefined;
let shutdownStarted = false;

const MAX_BACKUP_BYTES = 512 * 1024 * 1024;

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
			if (method === "exportBackup") return exportBackup();
			if (method === "restoreBackup") return restoreBackup();
			return service.invoke(method, params);
		},
	);
	descriptorPath = join(homedir(), ".fishmem", "desktop.json");
	rpcServer = await startRpcServer({
		service,
		socketPath,
		token: randomBytes(32).toString("hex"),
		descriptorPath,
	});
	createWindow();
}

async function exportBackup(): Promise<DesktopBackupResult> {
	if (!mainWindow) throw new Error("FishMem window is unavailable");
	const date = new Date().toISOString().slice(0, 10);
	const selected = await dialog.showSaveDialog(mainWindow, {
		title: "Export FishMem backup",
		defaultPath: join(
			app.getPath("documents"),
			`FishMem-backup-${date}.fishmem.json`,
		),
		filters: [{ name: "FishMem backup", extensions: ["json"] }],
	});
	if (selected.canceled || !selected.filePath) return { canceled: true };
	const snapshot = await service.invoke("exportSnapshot");
	await writeJsonAtomically(selected.filePath, snapshot);
	return { canceled: false, path: selected.filePath };
}

async function restoreBackup(): Promise<DesktopBackupResult> {
	if (!mainWindow) throw new Error("FishMem window is unavailable");
	const selected = await dialog.showOpenDialog(mainWindow, {
		title: "Restore FishMem backup",
		defaultPath: app.getPath("documents"),
		properties: ["openFile"],
		filters: [{ name: "FishMem backup", extensions: ["json"] }],
	});
	const filePath = selected.filePaths[0];
	if (selected.canceled || !filePath) return { canceled: true };
	const fileStats = await stat(filePath);
	if (!fileStats.isFile() || fileStats.size > MAX_BACKUP_BYTES) {
		throw new Error("The selected FishMem backup is invalid or exceeds 512 MB");
	}
	let snapshot: unknown;
	try {
		snapshot = JSON.parse(await readFile(filePath, "utf8"));
	} catch {
		throw new Error("The selected file is not valid JSON");
	}
	const restored = (await service.invoke("restoreSnapshot", {
		snapshot,
		confirm: "RESTORE",
	})) as Omit<DesktopBackupResult, "canceled" | "path">;
	return { canceled: false, path: filePath, ...restored };
}

async function writeJsonAtomically(filePath: string, value: unknown) {
	await mkdir(dirname(filePath), { recursive: true });
	const temporaryPath = join(
		dirname(filePath),
		`.${basename(filePath)}.${randomUUID()}.tmp`,
	);
	try {
		await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		await rename(temporaryPath, filePath);
	} finally {
		await rm(temporaryPath, { force: true });
	}
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
	app
		.whenReady()
		.then(bootstrap)
		.catch((error) => {
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
app.on("before-quit", (event) => {
	if (shutdownStarted) return;
	event.preventDefault();
	shutdownStarted = true;
	void shutdown().finally(() => app.exit(0));
});

async function shutdown() {
	if (rpcServer) {
		await new Promise<void>((resolve) => rpcServer?.close(() => resolve()));
		rpcServer = undefined;
	}
	if (service) await service.close();
	await Promise.all([
		process.platform !== "win32" && socketPath
			? rm(socketPath, { force: true })
			: Promise.resolve(),
		descriptorPath ? rm(descriptorPath, { force: true }) : Promise.resolve(),
	]);
}
