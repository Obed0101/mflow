import type { DaemonStatus, DaemonState } from "../../shared/src/index.js";
import { sendIPC } from "./ipc-client.js";

// ─── ANSI Escape Sequences ─────────────────────────────────

const ESC = "\x1b";
const ENTER_ALT_SCREEN = `${ESC}[?1049h`;
const EXIT_ALT_SCREEN = `${ESC}[?1049l`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const CLEAR_SCREEN = `${ESC}[2J${ESC}[H`;

// ─── ANSI Colors ────────────────────────────────────────────

const bold = (s: string): string => `${ESC}[1m${s}${ESC}[0m`;
const dim = (s: string): string => `${ESC}[2m${s}${ESC}[0m`;
const green = (s: string): string => `${ESC}[32m${s}${ESC}[0m`;
const yellow = (s: string): string => `${ESC}[33m${s}${ESC}[0m`;
const red = (s: string): string => `${ESC}[31m${s}${ESC}[0m`;
const cyan = (s: string): string => `${ESC}[36m${s}${ESC}[0m`;
const white = (s: string): string => `${ESC}[37m${s}${ESC}[0m`;

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

const STATE_DOTS: Record<DaemonState, string> = {
  starting: yellow("●"),
  scanning: yellow("●"),
  connecting: yellow("●"),
  syncing: green("●"),
  paused: yellow("●"),
  reconnecting: red("●"),
  stopping: dim("●"),
};

// ─── Formatting Helpers ─────────────────────────────────────

function stripAnsi(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function padRight(s: string, width: number): string {
  const visible = stripAnsi(s);
  if (visible >= width) return s;
  return s + " ".repeat(width - visible);
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes < 60) return `${minutes}m${secs.toString().padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h${mins.toString().padStart(2, "0")}m`;
}

function formatMemory(mb: number): string {
  return `${mb.toFixed(1)}MB`;
}

function formatTimeAgo(timestamp: number): string {
  const delta = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000));
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3_600) return `${Math.floor(delta / 60)}m ago`;
  return `${Math.floor(delta / 3_600)}h ago`;
}

// ─── Box Drawing ────────────────────────────────────────────

function topBorder(title: string, width: number): string {
  const label = title ? ` ${title} ` : "";
  const labelLen = stripAnsi(label);
  const remaining = Math.max(0, width - 2 - labelLen);
  return dim("┌─") + bold(label) + dim("─".repeat(remaining) + "┐");
}

function midBorder(title: string, width: number): string {
  const label = title ? ` ${title} ` : "";
  const labelLen = stripAnsi(label);
  const remaining = Math.max(0, width - 2 - labelLen);
  return dim("├─") + bold(label) + dim("─".repeat(remaining) + "┤");
}

function bottomBorder(rightText: string, width: number): string {
  const rightLen = stripAnsi(rightText);
  const remaining = Math.max(0, width - 2 - rightLen);
  return dim("└" + "─".repeat(remaining) + rightText + "┘");
}

function boxLine(content: string, width: number): string {
  const innerWidth = width - 4; // "│ " + content + " │"
  return dim("│") + " " + padRight(content, innerWidth) + " " + dim("│");
}

function emptyBoxLine(width: number): string {
  return dim("│") + " ".repeat(width - 2) + dim("│");
}

// ─── Dashboard Class ────────────────────────────────────────

const REFRESH_MS = 1_500;

export class Dashboard {
  private timer: ReturnType<typeof setInterval> | null = null;
  private projectRoot: string;
  private width: number;
  private height: number;
  private running = false;
  private lastError: string | null = null;
  private stdinHandler: ((key: Buffer) => void) | null = null;
  private resizeHandler: (() => void) | null = null;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.width = Math.max(60, process.stdout.columns || 80);
    this.height = process.stdout.rows || 24;
  }

  async start(): Promise<void> {
    this.running = true;

    // Enter alternate screen buffer, hide cursor
    process.stdout.write(ENTER_ALT_SCREEN + HIDE_CURSOR);

    // Handle resize
    this.resizeHandler = () => {
      this.width = Math.max(60, process.stdout.columns || 80);
      this.height = process.stdout.rows || 24;
    };
    process.stdout.on("resize", this.resizeHandler);

    // Raw mode for key handling
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      this.stdinHandler = (key: Buffer) => {
        // q / Q
        if (key[0] === 0x71 || key[0] === 0x51) {
          this.stop();
        }
        // Ctrl+C
        if (key[0] === 0x03) {
          this.stop();
        }
      };
      process.stdin.on("data", this.stdinHandler);
    }

    // Initial render
    await this.refresh();

    // Start refresh loop
    this.timer = setInterval(() => {
      void this.refresh();
    }, REFRESH_MS);

    // Keep alive until stopped
    return new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (!this.running) {
          clearInterval(check);
          resolve();
        }
      }, 100);
    });
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    // Restore terminal state
    if (process.stdin.isTTY) {
      if (this.stdinHandler) {
        process.stdin.removeListener("data", this.stdinHandler);
        this.stdinHandler = null;
      }
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }

    if (this.resizeHandler) {
      process.stdout.removeListener("resize", this.resizeHandler);
      this.resizeHandler = null;
    }

    // Exit alternate screen, show cursor
    process.stdout.write(SHOW_CURSOR + EXIT_ALT_SCREEN);
  }

  private async refresh(): Promise<void> {
    if (!this.running) return;

    try {
      const response = await sendIPC(this.projectRoot, { type: "status" });
      if (response.type === "status") {
        this.lastError = null;
        this.render(response.data);
      } else if (response.type === "error") {
        this.lastError = response.message;
        this.renderError();
      }
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.renderError();
    }
  }

  private render(status: DaemonStatus): void {
    const w = this.width;
    const lines: string[] = [];

    // ── Header ──
    lines.push(topBorder("mflow", w));
    lines.push(emptyBoxLine(w));

    // State + Room row
    const stateStr = `State: ${STATE_DOTS[status.state]} ${STATE_COLORS[status.state](status.state.toUpperCase())}`;
    const roomStr = `Room: ${status.roomId ? white(status.roomId.slice(0, 8)) : dim("none")}`;
    lines.push(boxLine(`  ${stateStr}          ${roomStr}`, w));

    // Uptime + Transport
    const uptimeStr = `Uptime: ${cyan(formatUptime(status.uptime))}`;
    lines.push(boxLine(`  ${uptimeStr}`, w));

    // Files + Ops/s
    const filesStr = `Files: ${white(String(status.trackedFiles))} tracked ${dim("(")}${white(String(status.activeYDocs))} active${dim(")")}`;
    const opsStr = `Ops/s: ${white(String(status.opsPerSecond))}`;
    lines.push(boxLine(`  ${filesStr}   ${opsStr}`, w));

    // Memory
    const memStr = `Memory: ${white(formatMemory(status.memoryUsageMB))}`;
    lines.push(boxLine(`  ${memStr}`, w));
    lines.push(emptyBoxLine(w));

    // ── Peers ──
    lines.push(midBorder(`Peers (${status.peers.length})`, w));
    lines.push(emptyBoxLine(w));

    if (status.peers.length === 0) {
      lines.push(boxLine(`  ${dim("No peers connected")}`, w));
    } else {
      for (const peer of status.peers) {
        const dot = peer.peerType === "agent" ? cyan("●") : green("●");
        const typeLabel = peer.peerType === "agent" ? cyan("agent") : green("human");
        const name = white(peer.peerName);
        lines.push(boxLine(`  ${dot} ${padRight(name, 24)} ${typeLabel}`, w));
      }
    }
    lines.push(emptyBoxLine(w));

    // ── Locks ──
    const lockCount = status.locks?.length ?? 0;
    lines.push(midBorder(`Locks (${lockCount})`, w));
    lines.push(emptyBoxLine(w));

    if (lockCount === 0) {
      lines.push(boxLine(`  ${dim("No active locks")}`, w));
    } else {
      const now = Date.now();
      for (const lock of status.locks) {
        const remaining = Math.max(0, Math.ceil((lock.expiresAt - now) / 1_000));
        const lockIcon = yellow("\u2298");
        lines.push(
          boxLine(
            `  ${lockIcon} ${white(lock.path)} ${dim("\u2014")} ${lock.holderName} ${dim(`(${remaining}s remaining)`)}`,
            w,
          ),
        );
      }
    }
    lines.push(emptyBoxLine(w));

    // ── Pauses ──
    const pauseCount = status.pauseReasons?.length ?? 0;
    lines.push(midBorder(`Pauses (${pauseCount})`, w));
    lines.push(emptyBoxLine(w));

    if (pauseCount === 0) {
      lines.push(boxLine(`  ${dim("No active pauses")}`, w));
    } else {
      for (const pause of status.pauseReasons) {
        const sourceColor = pause.source === "user" ? yellow : pause.source === "git" ? cyan : dim;
        lines.push(
          boxLine(
            `  ${yellow("⏸")} ${sourceColor(pause.source)} ${dim("\u2014")} ${pause.id} ${dim(formatTimeAgo(pause.timestamp))}`,
            w,
          ),
        );
      }
    }
    lines.push(emptyBoxLine(w));

    // ── Activity ──
    lines.push(midBorder("Activity", w));
    lines.push(emptyBoxLine(w));

    // Show merge warnings as activity, or "waiting" if none
    if (status.mergeWarnings && status.mergeWarnings.length > 0) {
      const recent = status.mergeWarnings.slice(-5);
      for (const warning of recent) {
        lines.push(
          boxLine(
            `  ${red("\u26A0")} ${white(warning.path)} ${dim("\u2014")} ${warning.type}: ${warning.detail}`,
            w,
          ),
        );
      }
    } else if (status.peers.length > 0) {
      lines.push(boxLine(`  ${dim("Syncing with")} ${white(String(status.peers.length))} ${dim("peers \u2014 waiting for activity...")}`, w));
    } else {
      lines.push(boxLine(`  ${dim("Waiting for activity...")}`, w));
    }
    lines.push(emptyBoxLine(w));

    // ── Footer ──
    const footerRight = ` q to quit ${dim("\u2014")} \u21BB ${REFRESH_MS / 1_000}s refresh `;
    lines.push(bottomBorder(footerRight, w));

    // Write to screen
    const output = CLEAR_SCREEN + lines.join("\n") + "\n";
    process.stdout.write(output);
  }

  private renderError(): void {
    const w = this.width;
    const lines: string[] = [];

    lines.push(topBorder("mflow", w));
    lines.push(emptyBoxLine(w));
    lines.push(boxLine(`  ${red("●")} ${red("DISCONNECTED")}`, w));
    lines.push(emptyBoxLine(w));
    lines.push(boxLine(`  ${dim("Error:")} ${this.lastError ?? "Unknown error"}`, w));
    lines.push(emptyBoxLine(w));
    lines.push(boxLine(`  ${dim("Retrying every")} ${REFRESH_MS / 1_000}s${dim("...")}`, w));
    lines.push(emptyBoxLine(w));

    const footerRight = ` q to quit ${dim("\u2014")} \u21BB ${REFRESH_MS / 1_000}s refresh `;
    lines.push(bottomBorder(footerRight, w));

    const output = CLEAR_SCREEN + lines.join("\n") + "\n";
    process.stdout.write(output);
  }
}
