import { sendIPC } from "../ipc-client.js";
import { displaySuccess, displayError } from "../display.js";

// ─── Resume Command ─────────────────────────────────────────

export interface ResumeOptions {
  force?: boolean;
}

export async function resumeCommand(projectRoot: string, options: ResumeOptions = {}): Promise<void> {
  try {
    const response = await sendIPC(projectRoot, {
      type: "resume",
      source: "user",
      force: options.force,
    });
    if (response.type === "ok") {
      const msg = options.force
        ? "Sync resumed — all pause reasons force-cleared"
        : "Sync resumed — buffered changes applied";
      displaySuccess(msg);
    } else if (response.type === "error") {
      displayError(response.message);
      process.exitCode = 1;
    }
  } catch (err) {
    displayError(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
