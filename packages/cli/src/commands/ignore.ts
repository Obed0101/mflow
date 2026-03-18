import { appendFile, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { MFLOW_IGNORE_FILE } from "@mflow/shared";
import { sendIPC, isDaemonRunning } from "../ipc-client.js";
import { displaySuccess, displayError, displayInfo } from "../display.js";

// ─── Ignore Command ─────────────────────────────────────────

export async function ignoreCommand(
  projectRoot: string,
  pattern: string,
): Promise<void> {
  const ignorePath = join(projectRoot, MFLOW_IGNORE_FILE);

  // Check if pattern is already in .mflowignore
  try {
    const content = await readFile(ignorePath, "utf-8");
    const lines = content.split(/\r?\n/).map((l) => l.trim());
    if (lines.includes(pattern)) {
      displayInfo(`Pattern already in .mflowignore: ${pattern}`);
      return;
    }
  } catch {
    // File doesn't exist — we'll create it
  }

  // Append pattern to .mflowignore
  const fileExists = await access(ignorePath).then(() => true).catch(() => false);
  const prefix = fileExists ? "\n" : "# Mflow ignore patterns\n\n";
  await appendFile(ignorePath, prefix + pattern + "\n", "utf-8");

  displaySuccess(`Added ignore pattern: ${pattern}`);

  // Notify daemon if running
  if (await isDaemonRunning(projectRoot)) {
    try {
      const response = await sendIPC(projectRoot, { type: "ignore", pattern });
      if (response.type === "ok") {
        displayInfo("Daemon updated — matching files unwatched");
      } else if (response.type === "error") {
        displayError(`Daemon update failed: ${response.message}`);
      }
    } catch {
      displayInfo("Daemon not notified — restart to apply");
    }
  }
}
