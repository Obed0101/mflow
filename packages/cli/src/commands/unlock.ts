import { sendIPC } from "../ipc-client.js";
import { displaySuccess, displayError } from "../display.js";

// ─── Unlock Command ────────────────────────────────────────

export async function unlockCommand(
  projectRoot: string,
  path: string,
  options: { force?: boolean },
): Promise<void> {
  try {
    const response = await sendIPC(projectRoot, {
      type: "unlock",
      path,
      source: "user",
      force: options.force,
    });

    if (response.type === "ok") {
      displaySuccess(`Unlocked ${path}${options.force ? " (force)" : ""}`);
    } else if (response.type === "error") {
      displayError(response.message);
      process.exitCode = 1;
    }
  } catch (err) {
    displayError(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
