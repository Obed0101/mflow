import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { MFLOW_SOCK_FILE } from "../../shared/src/index.js";
import type { IPCRequest, IPCResponse } from "../../shared/src/index.js";

// ─── IPC Client ─────────────────────────────────────────────

const IPC_TIMEOUT_MS = 5_000;

/**
 * Send a request to the daemon via Unix Domain Socket and return the response.
 * Uses JSON-lines protocol: one JSON object per line, newline-delimited.
 */
export function sendIPC(
  projectRoot: string,
  request: IPCRequest,
): Promise<IPCResponse> {
  const sockPath = join(projectRoot, MFLOW_SOCK_FILE);

  return new Promise<IPCResponse>((resolve, reject) => {
    let buffer = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.destroy();
        reject(new Error(`IPC timeout after ${IPC_TIMEOUT_MS}ms — is the daemon running?`));
      }
    }, IPC_TIMEOUT_MS);

    const socket: Socket = connect({ path: sockPath }, () => {
      socket.write(JSON.stringify(request) + "\n");
    });

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx);
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          socket.destroy();
          try {
            resolve(JSON.parse(line) as IPCResponse);
          } catch {
            reject(new Error(`Invalid IPC response: ${line}`));
          }
        }
      }
    });

    socket.on("error", (err: Error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new Error("Daemon not running — start it with: mflow start"));
        } else if ((err as NodeJS.ErrnoException).code === "ECONNREFUSED") {
          reject(new Error("Daemon socket exists but connection refused — try: mflow stop && mflow start"));
        } else {
          reject(new Error(`IPC error: ${err.message}`));
        }
      }
    });
  });
}

/**
 * Check if the daemon is running by attempting to connect to the socket.
 */
export async function isDaemonRunning(projectRoot: string): Promise<boolean> {
  try {
    const response = await sendIPC(projectRoot, { type: "health" });
    return response.type === "ok" || response.type === "status";
  } catch {
    return false;
  }
}
