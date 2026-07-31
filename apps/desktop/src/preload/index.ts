import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi, DesktopIpcMethod } from "../shared/protocol";

const api: DesktopApi = {
  invoke: <T>(method: DesktopIpcMethod, params?: unknown) =>
    ipcRenderer.invoke("fishmem:invoke", method, params) as Promise<T>,
};

contextBridge.exposeInMainWorld("fishmem", api);
