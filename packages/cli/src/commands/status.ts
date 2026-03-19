import { sendIPC, isDaemonRunning } from "../ipc-client.js";
import { displayStatus, displayError, displayInfo } from "../display.js";
import { Dashboard } from "../dashboard.js";

// ─── Status Command Options ────────────────────────────────

export interface StatusOptions {
  watch?: boolean;
}

// ─── Status Command ─────────────────────────────────────────

export async function statusCommand(
  projectRoot: string,
  options: StatusOptions = {},
): Promise<void> {
  if (!(await isDaemonRunning(projectRoot))) {
    displayInfo("Daemon not running — starting it...");
    const { startCommand } = await import("./start.js");
    await startCommand(projectRoot, {});

    // Wait briefly for daemon to initialize
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    if (!(await isDaemonRunning(projectRoot))) {
      displayError("Daemon failed to start");
      process.exitCode = 1;
      return;
    }
  }

  // Watch mode: launch live dashboard
  if (options.watch) {
    const dashboard = new Dashboard(projectRoot);
    await dashboard.start();
    return;
  }

  // Static mode: print snapshot and exit
  try {
    const response = await sendIPC(projectRoot, { type: "status" });
    if (response.type === "status") {
      displayStatus(response.data);
    } else if (response.type === "error") {
      displayError(response.message);
      process.exitCode = 1;
    }
  } catch (err) {
    displayError(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
