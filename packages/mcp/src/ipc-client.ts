import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { MFLOW_SOCK_FILE } from "../../shared/src/index.js";
import type { IPCRequest, IPCResponse } from "../../shared/src/index.js";

// ─── IPC Client (adapted from @mflow/cli) ─────────────────────

const IPC_TIMEOUT_MS = 5_000;

/**
 * Send a request to the mflow daemon via Unix Domain Socket.
 * JSON-lines protocol: one JSON object per line, newline-delimited.
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
        reject(new Error("IPC timeout — is the mflow daemon running?"));
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
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          reject(new Error("Daemon not running. Start it with: mflow start"));
        } else if (code === "ECONNREFUSED") {
          reject(new Error("Daemon socket exists but connection refused. Try: mflow stop && mflow start"));
        } else {
          reject(new Error(`IPC error: ${err.message}`));
        }
      }
    });
  });
}

/**
 * Check if the mflow daemon is running.
 */
export async function isDaemonRunning(projectRoot: string): Promise<boolean> {
  try {
    const response = await sendIPC(projectRoot, { type: "health" });
    return response.type === "ok" || response.type === "status";
  } catch {
    return false;
  }
}
