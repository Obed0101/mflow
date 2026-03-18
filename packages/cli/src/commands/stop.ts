import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { MFLOW_PID_FILE, MFLOW_SOCK_FILE } from "@mflow/shared";
import { sendIPC, isDaemonRunning } from "../ipc-client.js";
import { displaySuccess, displayError, displayWarning } from "../display.js";

// ─── Stop Command ───────────────────────────────────────────

export async function stopCommand(projectRoot: string): Promise<void> {
  // Try graceful IPC stop first
  if (await isDaemonRunning(projectRoot)) {
    try {
      const response = await sendIPC(projectRoot, { type: "stop" });
      if (response.type === "ok") {
        displaySuccess("Daemon stopped gracefully");
        await cleanupFiles(projectRoot);
        return;
      }
      if (response.type === "error") {
        displayError(`Daemon stop failed: ${response.message}`);
      }
    } catch {
      // IPC failed — fall through to PID kill
    }
  }

  // Fallback: kill by PID
  const pidPath = join(projectRoot, MFLOW_PID_FILE);
  try {
    const pidStr = await readFile(pidPath, "utf-8");
    const pid = parseInt(pidStr.trim(), 10);
    if (!isNaN(pid)) {
      try {
        process.kill(pid, "SIGTERM");
        displaySuccess(`Daemon stopped (PID: ${pid})`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ESRCH") {
          displayWarning("Daemon was not running (stale PID file)");
        } else {
          throw err;
        }
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      displayWarning("No daemon running for this project");
      return;
    }
    throw err;
  }

  await cleanupFiles(projectRoot);
}

async function cleanupFiles(projectRoot: string): Promise<void> {
  const pidPath = join(projectRoot, MFLOW_PID_FILE);
  const sockPath = join(projectRoot, MFLOW_SOCK_FILE);

  await unlink(pidPath).catch(() => {});
  await unlink(sockPath).catch(() => {});
}
