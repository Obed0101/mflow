import { sendIPC } from "../ipc-client.js";
import { displayError, displaySuccess } from "../display.js";

export async function claimCommand(
  projectRoot: string,
  pattern: string,
  options: { timeout?: string; priority?: string; duration?: string },
): Promise<void> {
  try {
    const timeoutMs = parseDuration(options.timeout ?? "120s");
    const leaseDurationMs = parseDuration(options.duration ?? "2m");
    const priority = Number.parseInt(options.priority ?? "0", 10);
    if (!timeoutMs || !leaseDurationMs || !Number.isInteger(priority) || priority < 0 || priority > 9) {
      displayError("Invalid claim options");
      process.exitCode = 1;
      return;
    }
    const path = `scope:${pattern}`;
    const response = await sendIPC(projectRoot, {
      type: "lock",
      path,
      leaseDurationMs,
      wait: true,
      timeoutMs,
      priority,
      source: "user",
    });
    if (response.type === "lock-result" && response.data.granted) {
      displaySuccess(`Claimed ${pattern} (token: ${response.data.lock.token})`);
      return;
    }
    if (response.type === "error") {
      displayError(response.message);
      process.exitCode = 1;
    }
  } catch (err) {
    displayError(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

function parseDuration(input: string): number | undefined {
  const match = input.match(/^(\d+)(s|m)$/);
  if (!match) return undefined;
  const value = Number.parseInt(match[1], 10);
  return match[2] === "s" ? value * 1_000 : value * 60_000;
}
