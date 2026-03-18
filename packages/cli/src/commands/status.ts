import { sendIPC, isDaemonRunning } from "../ipc-client.js";
import { displayStatus, displayError, displayInfo } from "../display.js";

// ─── Status Command ─────────────────────────────────────────

export async function statusCommand(projectRoot: string): Promise<void> {
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
