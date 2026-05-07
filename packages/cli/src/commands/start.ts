import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import {
  DEFAULT_SIGNALING_URL,
  MFLOW_CONFIG_FILE,
  MFLOW_DIR,
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
  copySecret?: boolean;
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
  const config = await readStartConfig(projectRoot);
  const room = firstNonEmpty(options.room, config.room) ?? await deriveRoomId(projectRoot);
  let secret = firstNonEmpty(options.secret, process.env["MFLOW_SECRET"], config.secret) ?? "";
  const generatedSecret = !secret;

  if (generatedSecret) {
    secret = randomBytes(32).toString("hex");
    console.log("");
    displayInfo("Generated secret — share with peers:");
    console.log(`  ${secret}`);
    displayWarning("This secret grants room access. Do not commit it or paste it into public logs.");
    if (options.copySecret) {
      const copied = await copyToClipboard(secret);
      if (copied) displayInfo("Secret copied to clipboard.");
      else displayWarning("Could not copy secret to clipboard automatically.");
    }
    console.log("");
  } else if (options.copySecret) {
    const copied = await copyToClipboard(secret);
    if (copied) displayInfo("Existing room secret copied to clipboard.");
    else displayWarning("Could not copy room secret to clipboard automatically.");
  }

  const signaling = firstNonEmpty(options.signaling, config.signaling) ?? DEFAULT_SIGNALING_URL;
  const transport = options.transport ?? "relay";

  // Spawn daemon as detached background process
  const daemonEntry = resolve(
    import.meta.dirname ?? new URL(".", import.meta.url).pathname,
    "../../daemon-entry.ts",
  );

  // Build args
  const args = [daemonEntry, "--root", projectRoot, "--room", room, "--secret", secret];
  args.push("--signaling", signaling);
  if (transport !== "relay") args.push("--transport", transport);

  const logPath = join(projectRoot, MFLOW_DIR, "daemon.log");
  const stdoutFd = openSync(logPath, "a");
  const stderrFd = openSync(logPath, "a");

  // Use Bun to run the daemon entry point.
  const daemonProc = spawn(
    "bun",
    args,
    {
      detached: true,
      stdio: ["ignore", stdoutFd, stderrFd],
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
    daemonProc.unref();

    const ready = await waitForDaemonReady(projectRoot, daemonProc.pid, logPath);
    if (!ready.ok) {
      displayError(ready.message);
      process.exitCode = 1;
      return;
    }

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

async function copyToClipboard(secret: string): Promise<boolean> {
  const platform = process.platform;
  const copyCmd = platform === "darwin"
    ? ["pbcopy"]
    : platform === "win32"
      ? ["clip"]
      : ["xclip", "-selection", "clipboard"];
  try {
    const proc = spawn(copyCmd[0], copyCmd.slice(1), { stdio: ["pipe", "ignore", "ignore"] });
    proc.stdin?.write(secret);
    proc.stdin?.end();
    const code: number = await new Promise((resolve) => proc.on("close", resolve));
    return code === 0;
  } catch {
    return false;
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

async function readStartConfig(projectRoot: string): Promise<{ room?: string; secret?: string; signaling?: string }> {
  try {
    const content = await readFile(join(projectRoot, MFLOW_CONFIG_FILE), "utf-8");
    return {
      room: readTomlString(content, "room"),
      secret: readTomlString(content, "secret"),
      signaling: readTomlString(content, "signaling"),
    };
  } catch {
    return {};
  }
}

function readTomlString(content: string, key: string): string | undefined {
  const match = content.match(new RegExp(`^${key}\\s*=\\s*"((?:\\\\.|[^"])*)"`, "m"));
  if (!match) return undefined;
  return match[1].replaceAll('\\"', '"').replaceAll("\\\\", "\\");
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

async function waitForDaemonReady(
  projectRoot: string,
  pid: number,
  logPath: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const deadline = Date.now() + 4_000;

  while (Date.now() < deadline) {
    if (await isDaemonRunning(projectRoot)) {
      return { ok: true };
    }

    if (!isProcessAlive(pid)) {
      const logTail = await readLogTail(logPath);
      return {
        ok: false,
        message: logTail
          ? `Daemon exited during startup.\n${logTail}`
          : "Daemon exited during startup. Check .mflow/daemon.log for details.",
      };
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  const logTail = await readLogTail(logPath);
  return {
    ok: false,
    message: logTail
      ? `Daemon did not become ready in time.\n${logTail}`
      : "Daemon did not become ready in time. Check .mflow/daemon.log for details.",
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readLogTail(logPath: string): Promise<string> {
  try {
    const content = await readFile(logPath, "utf-8");
    const tail = content
      .trim()
      .split("\n")
      .slice(-10)
      .join("\n")
      .trim();
    return tail ? `Recent daemon log:\n${tail}` : "";
  } catch {
    return "";
  }
}
