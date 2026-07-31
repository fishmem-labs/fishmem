import type { DesktopApi } from "../../shared/protocol";

declare global {
  interface Window {
    fishmem: DesktopApi;
  }
}

export {};
