import { sendIPC, isDaemonRunning } from "../ipc-client.js";
import { displayStatus, displayError, displayInfo } from "../display.js";
import { Dashboard } from "../dashboard.js";
import { join } from "node:path";
import { MFLOW_CONFIG_FILE } from "../../../shared/src/index.js";

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
      await displayDashboardHint(projectRoot, response.data.roomId);
    } else if (response.type === "error") {
      displayError(response.message);
      process.exitCode = 1;
    }
  } catch (err) {
    displayError(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

async function displayDashboardHint(projectRoot: string, roomId: string | null): Promise<void> {
  const relay = await readConfiguredRelay(projectRoot);
  if (!relay) return;
  console.log("");
  displayInfo(`Hosted dashboard: ${relay.replace(/^wss?:\/\//, "https://").replace(/\/$/, "")}/dashboard`);
  if (roomId) {
    displayInfo(`Paste the same room secret to monitor room "${roomId}".`);
  }
  displayInfo("Stop the local daemon with: mflow stop");
}

async function readConfiguredRelay(projectRoot: string): Promise<string | null> {
  try {
    const content = await Bun.file(join(projectRoot, MFLOW_CONFIG_FILE)).text();
    const match = content.match(/^signaling\s*=\s*"([^"]+)"/m);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}
