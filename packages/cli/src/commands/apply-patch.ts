import { readFile } from "node:fs/promises";
import { sendIPC } from "../ipc-client.js";
import { displayError, displayInfo, displaySuccess } from "../display.js";
import { applyMflowPatch, getPatchPaths } from "../patch-broker.js";

export async function applyPatchCommand(
  projectRoot: string,
  patchFile: string,
  options: { timeout?: string; priority?: string; duration?: string },
): Promise<void> {
  try {
    const patchText = patchFile === "-" ? await readStdin() : await readFile(patchFile, "utf-8");
    const paths = getPatchPaths(patchText);
    if (paths.length === 0) {
      displayError("Patch contains no file changes");
      process.exitCode = 1;
      return;
    }

    const timeoutMs = parseDuration(options.timeout ?? "60s");
    const leaseDurationMs = parseDuration(options.duration ?? "30s");
    const priority = Number.parseInt(options.priority ?? "0", 10);
    if (!timeoutMs || !leaseDurationMs || !Number.isInteger(priority) || priority < 0 || priority > 9) {
      displayError("Invalid lock options");
      process.exitCode = 1;
      return;
    }

    for (const path of paths) {
      displayInfo(`Waiting for lock: ${path}`);
      const response = await sendIPC(projectRoot, {
        type: "lock",
        path,
        leaseDurationMs,
        wait: true,
        timeoutMs,
        priority,
        source: "user",
      });
      if (response.type === "error") throw new Error(response.message);
      if (response.type !== "lock-result" || !response.data.granted) {
        throw new Error(`Could not acquire lock for ${path}`);
      }
    }

    const changed = await applyMflowPatch(projectRoot, patchText);
    for (const path of paths) {
      await sendIPC(projectRoot, { type: "unlock", path, source: "user" }).catch(() => undefined);
    }
    displaySuccess(`Applied patch to ${changed.length} file${changed.length === 1 ? "" : "s"}`);
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

async function readStdin(): Promise<string> {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}
