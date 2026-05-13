import { sendIPC } from "../ipc-client.js";
import { displayLocks, displayError, displayInfo } from "../display.js";

// ─── Locks Command (list active locks) ─────────────────────

export async function locksCommand(projectRoot: string): Promise<void> {
  try {
    const response = await sendIPC(projectRoot, { type: "lock-query" });

    if (response.type === "locks") {
      if (response.data.length === 0 && (response.waiters ?? []).length === 0) {
        displayInfo("No active locks");
      } else {
        displayLocks(response.data, response.waiters);
      }
    } else if (response.type === "error") {
      displayError(response.message);
      process.exitCode = 1;
    }
  } catch (err) {
    displayError(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
