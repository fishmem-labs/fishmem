import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import type {
  DesktopMethod,
  RpcRequest,
  RpcResponse,
} from "../shared/protocol";

type DesktopDescriptor = {
  socketPath: string;
  token: string;
};

export async function invokeDesktop(
  method: DesktopMethod,
  params?: unknown,
): Promise<unknown> {
  const descriptor = await readDescriptor();
  const id = crypto.randomUUID();
  const request: RpcRequest = {
    id,
    token: descriptor.token,
    method,
    params,
  };

  return new Promise((resolve, reject) => {
    const socket = connect(descriptor.socketPath);
    let buffer = "";
    const timeoutMs =
      method === "documentIngest"
        ? 300_000
        : method === "documentSearch"
          ? 60_000
          : 10_000;
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(
        new Error(
          `FishMem Desktop did not respond within ${timeoutMs / 1_000} seconds`,
        ),
      );
    }, timeoutMs);

    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `Cannot connect to FishMem Desktop: ${error.message}. Make sure FishMem is running.`,
        ),
      );
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timeout);
      socket.end();
      const response = JSON.parse(buffer.slice(0, newline)) as RpcResponse;
      if (response.id !== id) {
        reject(new Error("FishMem Desktop returned an unexpected response"));
      } else if (response.error) {
        reject(new Error(response.error.message));
      } else {
        resolve(response.result);
      }
    });
  });
}

async function readDescriptor(): Promise<DesktopDescriptor> {
  let value: unknown;
  try {
    value = JSON.parse(
      await readFile(join(homedir(), ".fishmem", "desktop.json"), "utf8"),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("FishMem Desktop is not running");
    }
    throw error;
  }
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as DesktopDescriptor).socketPath !== "string" ||
    typeof (value as DesktopDescriptor).token !== "string"
  ) {
    throw new Error("FishMem Desktop connection descriptor is invalid");
  }
  return value as DesktopDescriptor;
}
