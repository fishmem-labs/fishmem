import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createServer, type Socket } from "node:net";
import {
  DesktopServiceError,
  type DesktopMemoryService,
} from "./memory-service";
import type { RpcRequest, RpcResponse } from "../shared/protocol";

export async function startRpcServer(options: {
  service: DesktopMemoryService;
  socketPath: string;
  token: string;
  descriptorPath: string;
}) {
  if (process.platform !== "win32") {
    await rm(options.socketPath, { force: true });
  }
  const server = createServer((socket) => handleSocket(socket, options));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, resolve);
  });
  if (process.platform !== "win32") await chmod(options.socketPath, 0o600);
  await mkdir(dirname(options.descriptorPath), { recursive: true });
  await writeFile(
    options.descriptorPath,
    JSON.stringify({ socketPath: options.socketPath, token: options.token }),
    { mode: 0o600 },
  );
  return server;
}

function handleSocket(
  socket: Socket,
  options: {
    service: DesktopMemoryService;
    token: string;
  },
) {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      void respond(socket, line, options);
      newline = buffer.indexOf("\n");
    }
  });
}

async function respond(
  socket: Socket,
  line: string,
  options: { service: DesktopMemoryService; token: string },
) {
  let request: RpcRequest | undefined;
  try {
    request = JSON.parse(line) as RpcRequest;
    if (request.token !== options.token) throw new Error("Unauthorized");
    const result = await options.service.invoke(request.method, request.params);
    send(socket, { id: request.id, result });
  } catch (error) {
    send(socket, {
      id: request?.id ?? "",
      error: {
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof DesktopServiceError ? { code: error.code } : {}),
      },
    });
  }
}

function send(socket: Socket, response: RpcResponse) {
  socket.write(`${JSON.stringify(response)}\n`);
}
