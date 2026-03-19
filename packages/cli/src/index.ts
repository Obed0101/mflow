#!/usr/bin/env bun

import { Command } from "commander";
import { resolve } from "node:path";
import { startCommand } from "./commands/start.js";
import { stopCommand } from "./commands/stop.js";
import { statusCommand } from "./commands/status.js";
import { pauseCommand } from "./commands/pause.js";
import { resumeCommand } from "./commands/resume.js";
import { ignoreCommand } from "./commands/ignore.js";
import { initCommand } from "./commands/init.js";
import { lockCommand } from "./commands/lock.js";
import { unlockCommand } from "./commands/unlock.js";
import { locksCommand } from "./commands/locks.js";
import { displayError } from "./display.js";

// ─── CLI Entry Point ────────────────────────────────────────

const program = new Command();

program
  .name("mflow")
  .description("Real-time P2P code sync for AI agents and developers")
  .version("0.1.0");

// Resolve project root: walk up to find .git or use cwd
function getProjectRoot(): string {
  return resolve(process.cwd());
}

// ── mflow start ──

program
  .command("start")
  .description("Start sync daemon and join a room")
  .option("-r, --room <name>", "Room name (default: derived from git remote + branch)")
  .option("-s, --secret <key>", "Shared secret for encryption")
  .option("--signaling <url>", "Signaling server URL")
  .option("-t, --transport <type>", "Transport type: relay (default) or p2p", "relay")
  .action(async (opts: { room?: string; secret?: string; signaling?: string; transport?: "relay" | "p2p" }) => {
    try {
      await startCommand(getProjectRoot(), opts);
    } catch (err) {
      displayError(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

// ── mflow stop ──

program
  .command("stop")
  .description("Stop sync daemon and persist state")
  .action(async () => {
    try {
      await stopCommand(getProjectRoot());
    } catch (err) {
      displayError(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

// ── mflow status ──

program
  .command("status")
  .description("Show daemon status, peers, and sync stats")
  .action(async () => {
    try {
      await statusCommand(getProjectRoot());
    } catch (err) {
      displayError(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

// ── mflow pause ──

program
  .command("pause")
  .description("Pause outgoing sync (continue receiving)")
  .action(async () => {
    try {
      await pauseCommand(getProjectRoot());
    } catch (err) {
      displayError(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

// ── mflow resume ──

program
  .command("resume")
  .description("Resume sync and apply buffered changes")
  .option("-f, --force", "Force-clear all pause reasons (admin override)")
  .action(async (options: { force?: boolean }) => {
    try {
      await resumeCommand(getProjectRoot(), { force: options.force });
    } catch (err) {
      displayError(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

// ── mflow ignore ──

program
  .command("ignore <pattern>")
  .description("Add an ignore pattern to .mflowignore")
  .action(async (pattern: string) => {
    try {
      await ignoreCommand(getProjectRoot(), pattern);
    } catch (err) {
      displayError(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

// ── mflow lock ──

program
  .command("lock <path>")
  .description("Acquire a file lock to prevent sync collisions")
  .option("-d, --duration <duration>", "Lock lease duration (e.g., 30s, 2m)", "30s")
  .action(async (path: string, opts: { duration?: string }) => {
    try {
      await lockCommand(getProjectRoot(), path, opts);
    } catch (err) {
      displayError(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

// ── mflow unlock ──

program
  .command("unlock <path>")
  .description("Release a file lock")
  .option("-f, --force", "Force-release any lock on this file (admin override)")
  .action(async (path: string, opts: { force?: boolean }) => {
    try {
      await unlockCommand(getProjectRoot(), path, opts);
    } catch (err) {
      displayError(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

// ── mflow locks ──

program
  .command("locks")
  .description("List all active file locks")
  .action(async () => {
    try {
      await locksCommand(getProjectRoot());
    } catch (err) {
      displayError(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

// ── mflow init ──

program
  .command("init")
  .description("Initialize .mflow/ directory with default config")
  .action(async () => {
    try {
      await initCommand(getProjectRoot());
    } catch (err) {
      displayError(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

// ── Parse ──

program.parse();
