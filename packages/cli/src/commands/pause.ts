import { sendIPC } from "../ipc-client.js";
import { displaySuccess, displayError } from "../display.js";

// ─── Pause Command ──────────────────────────────────────────

export async function pauseCommand(projectRoot: string): Promise<void> {
  try {
    const response = await sendIPC(projectRoot, { type: "pause" });
    if (response.type === "ok") {
      displaySuccess("Sync paused — incoming changes will be buffered");
    } else if (response.type === "error") {
      displayError(response.message);
      process.exitCode = 1;
    }
  } catch (err) {
    displayError(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
