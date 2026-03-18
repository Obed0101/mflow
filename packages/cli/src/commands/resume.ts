import { sendIPC } from "../ipc-client.js";
import { displaySuccess, displayError } from "../display.js";

// ─── Resume Command ─────────────────────────────────────────

export async function resumeCommand(projectRoot: string): Promise<void> {
  try {
    const response = await sendIPC(projectRoot, { type: "resume" });
    if (response.type === "ok") {
      displaySuccess("Sync resumed — buffered changes applied");
    } else if (response.type === "error") {
      displayError(response.message);
      process.exitCode = 1;
    }
  } catch (err) {
    displayError(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
