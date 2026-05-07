import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import {
  DEFAULT_SIGNALING_URL,
  MFLOW_PID_FILE,
} from "../../../shared/src/index.js";
import { isDaemonRunning, sendIPC } from "../ipc-client.js";
import { displayError, displayInfo, displayStartSummary, displayWarning } from "../display.js";
import { ensureMflowDir } from "./init.js";

// ─── Types ──────────────────────────────────────────────────

type TransportType = "relay" | "p2p";

interface StartOptions {
  room?: string;
  secret?: string;
  signaling?: string;
  transport?: TransportType;
}

// ─── Start Command ──────────────────────────────────────────

export async function startCommand(
  projectRoot: string,
  options: StartOptions,
): Promise<void> {
  // Check if daemon is already running
  if (await isDaemonRunning(projectRoot)) {
    displayWarning("Daemon already running");
    try {
      const response = await sendIPC(projectRoot, { type: "status" });
      if (response.type === "status") {
        const { displayStatus } = await import("../display.js");
        displayStatus(response.data);
      }
    } catch {
      displayInfo("Use 'mflow status' to check daemon state");
    }
    return;
  }

  // Auto-bootstrap .mflow/ if needed
  await ensureMflowDir(projectRoot);

  // Determine room and secret
  const room = options.room ?? await deriveRoomId(projectRoot);
  let secret = options.secret ?? "";
  const generatedSecret = !secret;

  if (generatedSecret) {
    secret = randomBytes(32).toString("hex");
    console.log("");
    displayInfo("Generated secret — share with peers:");
    console.log(`  ${secret}`);
    displayWarning("This secret grants room access. Do not commit it or paste it into public logs.");
    console.log("");
  }

  const signaling = options.signaling ?? DEFAULT_SIGNALING_URL;
  const transport = options.transport ?? "relay";

  // Spawn daemon as detached background process
  const daemonEntry = resolve(
    import.meta.dirname ?? new URL(".", import.meta.url).pathname,
    "../../daemon-entry.ts",
  );

  // Build args
  const args = ["run", daemonEntry, "--root", projectRoot, "--room", room, "--secret", secret];
  args.push("--signaling", signaling);
  if (transport !== "relay") args.push("--transport", transport);

  // Use Bun to run the daemon entry point
  // The daemon module is @mflow/daemon — we launch it via a minimal entry script
  const daemonProc = spawn(
    "bun",
    args,
    {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        MFLOW_PROJECT_ROOT: projectRoot,
        MFLOW_ROOM: room,
        MFLOW_SECRET: secret,
        MFLOW_TRANSPORT: transport,
        MFLOW_SIGNALING: signaling,
      },
    },
  );

  // Write PID file
  if (daemonProc.pid) {
    const pidPath = join(projectRoot, MFLOW_PID_FILE);
    await writeFile(pidPath, String(daemonProc.pid), "utf-8");
    daemonProc.unref();

    displayStartSummary({
      pid: daemonProc.pid,
      projectRoot,
      room,
      signaling,
      transport,
      generatedSecret,
    });
  } else {
    displayError("Failed to start daemon process");
    process.exitCode = 1;
  }
}

// ─── Helpers ────────────────────────────────────────────────

/**
 * Derive a room ID from the git remote URL + current branch.
 * Falls back to a random room ID if not in a git repo.
 */
async function deriveRoomId(projectRoot: string): Promise<string> {
  try {
    const headPath = join(projectRoot, ".git", "HEAD");
    const headContent = await readFile(headPath, "utf-8");

    let branch = "main";
    const refMatch = headContent.trim().match(/^ref: refs\/heads\/(.+)$/);
    if (refMatch) {
      branch = refMatch[1];
    }

    // Try to get the remote URL
    const configPath = join(projectRoot, ".git", "config");
    const gitConfig = await readFile(configPath, "utf-8");
    const remoteMatch = gitConfig.match(/url\s*=\s*(.+)/);
    const remote = remoteMatch ? remoteMatch[1].trim() : projectRoot;

    // Simple hash-like room ID from remote + branch
    const input = `${remote}:${branch}`;
    const encoder = new TextEncoder();
    const data = encoder.encode(input);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = new Uint8Array(hashBuffer);
    return Array.from(hashArray.slice(0, 8))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    // Not a git repo — use random room ID
    return randomBytes(8).toString("hex");
  }
}
