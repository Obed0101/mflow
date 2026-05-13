import type { DaemonStatus, PeerInfo, DaemonState, FileLock, FileLockWaiter, MergeWarning } from "../../shared/src/index.js";

// ─── ANSI Colors ────────────────────────────────────────────

const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;
const green = (s: string): string => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string): string => `\x1b[33m${s}\x1b[0m`;
const red = (s: string): string => `\x1b[31m${s}\x1b[0m`;
const cyan = (s: string): string => `\x1b[36m${s}\x1b[0m`;

const colorize = (fn: (s: string) => string, s: string): string => {
  if (process.env["NO_COLOR"] || process.stdout.isTTY === false) return s;
  return fn(s);
};

const BANNER = [
  "             __ _",
  " _ __ ___   / _| | _____      __",
  "| '_ ` _ \\ | |_| |/ _ \\ \\ /\\ / /",
  "| | | | | ||  _| | (_) \\ V  V /",
  "|_| |_| |_||_| |_|\\___/ \\_/\\_/",
].join("\n");

// ─── State Colors ───────────────────────────────────────────

const STATE_COLORS: Record<DaemonState, (s: string) => string> = {
  starting: yellow,
  scanning: yellow,
  connecting: yellow,
  syncing: green,
  paused: yellow,
  reconnecting: red,
  stopping: dim,
};

// ─── Formatters ─────────────────────────────────────────────

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes < 60) return `${minutes}m${secs}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h${mins}m`;
}

function formatMemory(mb: number): string {
  return `${mb.toFixed(1)}MB`;
}

// ─── Display Functions ──────────────────────────────────────

export function displayStatus(status: DaemonStatus): void {
  const stateColor = STATE_COLORS[status.state] ?? dim;

  console.log(colorize(bold, "mflow") + colorize(dim, " — real-time code sync"));
  console.log("");
  console.log(`  State:    ${colorize(stateColor, status.state)}`);
  console.log(`  Room:     ${status.roomId ?? colorize(dim, "none")}`);
  console.log(`  Peers:    ${status.peers.length}`);
  console.log(`  Files:    ${status.trackedFiles} tracked, ${status.activeYDocs} active`);
  console.log(`  Ops/s:    ${status.opsPerSecond}`);
  console.log(`  Uptime:   ${formatUptime(status.uptime)}`);
  console.log(`  Memory:   ${formatMemory(status.memoryUsageMB)}`);

  if (status.peers.length > 0) {
    console.log("");
    displayPeers(status.peers);
  }

  if ((status.locks && status.locks.length > 0) || (status.lockWaiters && status.lockWaiters.length > 0)) {
    console.log("");
    displayLocks(status.locks, status.lockWaiters);
  }

  if (status.mergeWarnings && status.mergeWarnings.length > 0) {
    console.log("");
    displayMergeWarnings(status.mergeWarnings);
  }

  if (status.recentActivity && status.recentActivity.length > 0) {
    console.log("");
    console.log(colorize(bold, "  Recent activity:"));
    for (const entry of status.recentActivity.slice(0, 8)) {
      if (entry.kind === "warning") {
        console.log(`    ${colorize(red, "⚠")} ${entry.path} ${colorize(dim, "—")} ${entry.detail ?? "warning"}`);
        continue;
      }
      const direction = entry.direction === "remote" ? colorize(cyan, "remote") : colorize(green, "local");
      console.log(`    ${colorize(dim, "●")} ${entry.path} ${colorize(dim, "(")}${direction}${colorize(dim, ")")}`);
    }
  }
}

export function displayPeers(peers: PeerInfo[]): void {
  console.log(colorize(bold, "  Peers:"));
  for (const peer of peers) {
    const typeLabel = peer.peerType === "agent" ? colorize(cyan, "agent") : colorize(green, "human");
    console.log(`    ${colorize(dim, "●")} ${peer.peerName} ${colorize(dim, "(")}${typeLabel}${colorize(dim, ")")}`);
  }
}

export function displaySuccess(message: string): void {
  console.log(`${colorize(green, "✓")} ${message}`);
}

export function displayError(message: string): void {
  const marker = process.env["NO_COLOR"] || process.stderr.isTTY === false ? "✗" : red("✗");
  console.error(`${marker} ${message}`);
}

export function displayWarning(message: string): void {
  console.log(`${colorize(yellow, "!")} ${message}`);
}

export function displayInfo(message: string): void {
  console.log(`${colorize(dim, "›")} ${message}`);
}

export interface RelayHintOptions {
  relayUrl: string;
  roomId?: string | null;
  includeMonitor?: boolean;
}

export function displayRelayHints(options: RelayHintOptions): void {
  const dashboardUrl = options.relayUrl.replace(/^wss?:\/\//, "https://").replace(/\/$/, "") + "/dashboard";

  console.log("");
  console.log("Hosted dashboard:");
  console.log(`  ${dashboardUrl}`);
  if (options.roomId) {
    console.log(`  Paste the same room secret to monitor room "${options.roomId}".`);
  } else {
    console.log("  Paste the same room secret to monitor this room.");
  }
  console.log("");
  if (options.includeMonitor) {
    console.log("Monitor:");
    console.log("  mflow status --watch");
    console.log("");
  }
  console.log("Stop:");
  console.log("  mflow stop");
  console.log("");
  console.log("Secret:");
  console.log("  mflow secret --copy");
}

export function displayLocks(locks: FileLock[], waiters: FileLockWaiter[] = []): void {
  console.log(colorize(bold, "  Locks:"));
  const now = Date.now();
  for (const lock of locks) {
    const remaining = Math.max(0, Math.ceil((lock.expiresAt - now) / 1000));
    console.log(
      `    ${colorize(yellow, "⊘")} ${lock.path} ${colorize(dim, "—")} ${lock.holderName} ${colorize(dim, `(${remaining}s remaining)`)}`,
    );
  }
  for (const waiter of waiters) {
    const remaining = Math.max(0, Math.ceil((waiter.expiresAt - now) / 1000));
    console.log(
      `    ${colorize(cyan, "…")} ${waiter.path} ${colorize(dim, "—")} ${waiter.holderName} waiting ${colorize(dim, `(priority ${waiter.priority}, timeout in ${remaining}s)`)}`,
    );
  }
}

export function displayMergeWarnings(warnings: MergeWarning[]): void {
  console.log(colorize(bold, "  Merge Warnings:"));
  for (const w of warnings) {
    console.log(`    ${colorize(red, "⚠")} ${w.path} ${colorize(dim, "—")} ${w.type}: ${w.detail}`);
  }
}

export function getBanner(): string {
  return BANNER;
}

export function displayNoArgsHelp(): void {
  console.log(getBanner());
  console.log("");
  console.log("Real-time code sync for AI agent teams.");
  console.log("");
  console.log("Start here:");
  console.log("  mflow start                    Start sync in this repo");
  console.log("  mflow status                   See peers, files, locks, and recent activity");
  console.log("  mflow stop                     Stop the local daemon cleanly");
  console.log("  mflow lock src/file.ts         Lock a hot file before editing");
  console.log("");
  console.log("Hosted dashboard:");
  console.log("  Open /dashboard and paste the same room secret to monitor this room.");
  console.log("");
  console.log("Docs: https://github.com/Obed0101/mflow#readme");
}

export interface StartSummary {
  pid: number;
  projectRoot: string;
  room: string;
  signaling: string;
  transport: string;
  generatedSecret: boolean;
}

export function classifyRelay(signaling: string): string {
  if (signaling.includes("mflow-signal.obed0101.deno.net")) {
    return "public fair-use relay";
  }
  return "custom/self-hosted relay";
}

export function displayStartSummary(summary: StartSummary): void {
  displaySuccess(`Daemon started (PID: ${summary.pid})`);
  console.log("");
  console.log("Sync session");
  console.log(`  Project:   ${summary.projectRoot}`);
  console.log(`  Room:      ${summary.room}`);
  console.log(`  Relay:     ${summary.signaling} (${classifyRelay(summary.signaling)})`);
  console.log(`  Mode:      ${summary.transport}`);
  console.log("");
  displayWarning("Treat the room secret like a password. Anyone with the room and secret can join.");
  if (summary.generatedSecret) {
    displayInfo("A new secret was generated for this room; share it only out-of-band with trusted peers.");
  }
  console.log("");
  console.log("Hosted dashboard:");
  console.log("  Open /dashboard on the relay host and paste the same room secret.");
  console.log("  The hosted monitor shows room-scoped peers and recent file activity.");
  console.log("");
  console.log("Next peer:");
  console.log(`  mflow start --room ${summary.room} --secret <shared-secret> --signaling ${summary.signaling}`);
  displayRelayHints({
    relayUrl: summary.signaling,
    roomId: summary.room,
    includeMonitor: true,
  });
}
