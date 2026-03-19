import type { DaemonStatus, PeerInfo, DaemonState, FileLock, MergeWarning } from "@mflow/shared";

// ─── ANSI Colors ────────────────────────────────────────────

const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;
const green = (s: string): string => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string): string => `\x1b[33m${s}\x1b[0m`;
const red = (s: string): string => `\x1b[31m${s}\x1b[0m`;
const cyan = (s: string): string => `\x1b[36m${s}\x1b[0m`;

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

  console.log(bold("mflow") + dim(" — real-time code sync"));
  console.log("");
  console.log(`  State:    ${stateColor(status.state)}`);
  console.log(`  Room:     ${status.roomId ?? dim("none")}`);
  console.log(`  Peers:    ${status.peers.length}`);
  console.log(`  Files:    ${status.trackedFiles} tracked, ${status.activeYDocs} active`);
  console.log(`  Ops/s:    ${status.opsPerSecond}`);
  console.log(`  Uptime:   ${formatUptime(status.uptime)}`);
  console.log(`  Memory:   ${formatMemory(status.memoryUsageMB)}`);

  if (status.peers.length > 0) {
    console.log("");
    displayPeers(status.peers);
  }

  if (status.locks && status.locks.length > 0) {
    console.log("");
    displayLocks(status.locks);
  }

  if (status.mergeWarnings && status.mergeWarnings.length > 0) {
    console.log("");
    displayMergeWarnings(status.mergeWarnings);
  }
}

export function displayPeers(peers: PeerInfo[]): void {
  console.log(bold("  Peers:"));
  for (const peer of peers) {
    const typeLabel = peer.peerType === "agent" ? cyan("agent") : green("human");
    console.log(`    ${dim("●")} ${peer.peerName} ${dim("(")}${typeLabel}${dim(")")}`);
  }
}

export function displaySuccess(message: string): void {
  console.log(`${green("✓")} ${message}`);
}

export function displayError(message: string): void {
  console.error(`${red("✗")} ${message}`);
}

export function displayWarning(message: string): void {
  console.log(`${yellow("!")} ${message}`);
}

export function displayInfo(message: string): void {
  console.log(`${dim("›")} ${message}`);
}

export function displayLocks(locks: FileLock[]): void {
  console.log(bold("  Locks:"));
  const now = Date.now();
  for (const lock of locks) {
    const remaining = Math.max(0, Math.ceil((lock.expiresAt - now) / 1000));
    console.log(
      `    ${yellow("⊘")} ${lock.path} ${dim("—")} ${lock.holderName} ${dim(`(${remaining}s remaining)`)}`,
    );
  }
}

export function displayMergeWarnings(warnings: MergeWarning[]): void {
  console.log(bold("  Merge Warnings:"));
  for (const w of warnings) {
    console.log(`    ${red("⚠")} ${w.path} ${dim("—")} ${w.type}: ${w.detail}`);
  }
}
