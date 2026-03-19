import { sendIPC } from "../ipc-client.js";
import { displaySuccess, displayError } from "../display.js";

// ─── Lock Command ──────────────────────────────────────────

export async function lockCommand(
  projectRoot: string,
  path: string,
  options: { duration?: string },
): Promise<void> {
  try {
    let leaseDurationMs: number | undefined;
    if (options.duration) {
      leaseDurationMs = parseDuration(options.duration);
      if (leaseDurationMs === undefined) {
        displayError(`Invalid duration: ${options.duration} — use format like "30s", "60s", "2m"`);
        process.exitCode = 1;
        return;
      }
    }

    const response = await sendIPC(projectRoot, {
      type: "lock",
      path,
      leaseDurationMs,
      source: "user",
    });

    if (response.type === "lock-result") {
      const { granted, lock } = response.data;
      if (granted) {
        displaySuccess(
          `Locked ${path} (token: ${lock.token}, expires in ${lock.leaseDurationMs / 1000}s)`,
        );
      } else {
        const remaining = Math.max(0, Math.ceil((lock.expiresAt - Date.now()) / 1000));
        displayError(
          `Lock denied — ${path} is locked by ${lock.holderName} (expires in ${remaining}s)`,
        );
        process.exitCode = 1;
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

function parseDuration(input: string): number | undefined {
  const match = input.match(/^(\d+)(s|m)$/);
  if (!match) return undefined;
  const value = parseInt(match[1], 10);
  const unit = match[2];
  if (unit === "s") return value * 1_000;
  if (unit === "m") return value * 60_000;
  return undefined;
}
