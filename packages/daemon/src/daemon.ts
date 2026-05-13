import { EventEmitter } from "node:events";
import { execSync } from "node:child_process";
import { readFile, writeFile, unlink, mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { hostname } from "node:os";
import type {
  DaemonState,
  DaemonStatus,
  FileLock,
  FileLockWaiter,
  ITransport,
  LocalActivityEntry,
  LockRequestOptions,
  LockResponse,
  MflowConfig,
  PauseSource,
  PeerInfo,
  PeerType,
} from "../../shared/src/index.js";
import {
  MFLOW_DIR,
  MFLOW_PID_FILE,
  MFLOW_SOCK_FILE,
  MFLOW_CONFIG_FILE,
  MflowConfigSchema,
  sha256,
} from "../../shared/src/index.js";
import { SyncOrchestrator, type SyncStats } from "./sync.js";
import { FileLockManager } from "./file-lock-manager.js";

// ─── Types ──────────────────────────────────────────────────

export interface DaemonOptions {
  projectRoot: string;
  roomId?: string;
  secret?: string;
  peerName?: string;
  peerType?: PeerType | "auto";
  signalingUrl?: string;
  configOverrides?: Partial<MflowConfig>;
  /** Inject a transport instance. Required since WebRTC transport is built separately. */
  transport: ITransport;
}

export interface DaemonEvents {
  "state-changed": (state: DaemonState) => void;
  "file-synced": (path: string, direction: "local" | "remote") => void;
  "sync-error": (path: string, error: Error) => void;
  "stats-update": (stats: SyncStats) => void;
  started: () => void;
  stopped: () => void;
  error: (error: Error) => void;
}

// ─── MflowDaemon ────────────────────────────────────────────

/**
 * Top-level daemon that manages the full lifecycle of an Mflow sync session.
 *
 * Startup sequence:
 * 1. Generate peerId
 * 2. Load/merge config
 * 3. Auto-generate room ID from git remote + branch (if not provided)
 * 4. Auto-generate secret (if not provided)
 * 5. Write PID file
 * 6. Create SyncOrchestrator
 * 7. Connect transport to signaling
 * 8. Start sync engine
 * 9. Register shutdown handlers
 *
 * Shutdown sequence:
 * 1. Stop SyncOrchestrator (persists CRDT state)
 * 2. Disconnect transport
 * 3. Remove PID file
 * 4. Remove socket file
 */
export class MflowDaemon extends EventEmitter {
  private static readonly MAX_RECENT_ACTIVITY = 25;
  private sync: SyncOrchestrator | null = null;
  private readonly lockManager = new FileLockManager();
  private readonly transport: ITransport;
  private config: MflowConfig;
  private readonly peerId: string;
  private readonly projectRoot: string;
  private readonly pidFile: string;
  private readonly sockFile: string;
  private readonly roomId: string;
  private readonly secret: string;
  private readonly peerName: string;
  private startTime: number = 0;
  private readonly recentActivity: LocalActivityEntry[] = [];
  private shutdownInProgress = false;
  private signalHandlers: Array<{ signal: NodeJS.Signals; handler: () => void }> = [];

  constructor(options: DaemonOptions) {
    super();

    this.projectRoot = resolve(options.projectRoot);
    this.transport = options.transport;
    this.peerId = crypto.randomUUID();
    this.pidFile = join(this.projectRoot, MFLOW_PID_FILE);
    this.sockFile = join(this.projectRoot, MFLOW_SOCK_FILE);
    this.peerName = options.peerName ?? `${hostname()}-${process.pid}`;

    // Load and merge config
    this.config = MflowDaemon.buildConfig(options);

    // Determine room ID — will be finalized in start() if auto-detection needed
    this.roomId = options.roomId ?? this.config.sync.room ?? "";
    this.secret = options.secret ?? this.config.sync.secret ?? "";
  }

  // ─── Config Building ────────────────────────────────────────

  /**
   * Build config by merging defaults, config file values (if any), and option overrides.
   * Config file reading is synchronous at construction — TOML parsing is deferred to start().
   */
  private static buildConfig(options: DaemonOptions): MflowConfig {
    const overrides = options.configOverrides ?? {};

    // Build a partial config from options
    const optionConfig: Record<string, unknown> = {};

    if (options.signalingUrl) {
      optionConfig.sync = { signaling: options.signalingUrl };
    }
    if (options.peerType) {
      optionConfig.daemon = {
        ...(optionConfig.daemon as Record<string, unknown> | undefined),
        type: options.peerType,
      };
    }
    if (options.peerName) {
      optionConfig.daemon = {
        ...(optionConfig.daemon as Record<string, unknown> | undefined),
        name: options.peerName,
      };
    }

    // Deep merge: defaults ← optionConfig ← overrides
    const merged = deepMerge(optionConfig, overrides as Record<string, unknown>);

    return MflowConfigSchema.parse(merged);
  }

  // ─── Lifecycle ────────────────────────────────────────────

  /**
   * Full startup sequence.
   */
  async start(): Promise<void> {
    // Ensure .mflow directory exists
    await mkdir(join(this.projectRoot, MFLOW_DIR), { recursive: true });

    // Try to load config from file and re-merge
    await this.loadConfigFile();

    // Check for stale PID file
    await this.checkStalePid();

    // Resolve room ID from git if not provided
    const roomId = this.roomId || this.config.sync.room || (await this.autoDetectRoomId());
    const secret = this.secret || process.env["MFLOW_SECRET"] || this.config.sync.secret || crypto.randomUUID();

    // Write PID file
    await writeFile(this.pidFile, process.pid.toString(), "utf-8");

    // Create SyncOrchestrator
    this.sync = new SyncOrchestrator({
      projectRoot: this.projectRoot,
      config: this.config,
      transport: this.transport,
      peerId: this.peerId,
      lockManager: this.lockManager,
    });

    // Forward events
    this.sync.on("state-changed", (state: DaemonState) => {
      this.emit("state-changed", state);
    });
    this.sync.on("file-synced", (path: string, direction: "local" | "remote") => {
      this.pushRecentActivity({
        timestamp: Date.now(),
        path,
        direction,
        kind: "synced",
      });
      this.emit("file-synced", path, direction);
    });
    this.sync.on("sync-error", (path: string, error: Error) => {
      this.pushRecentActivity({
        timestamp: Date.now(),
        path,
        direction: "local",
        kind: "warning",
        detail: error.message,
      });
      this.emit("sync-error", path, error);
    });
    this.sync.on("stats-update", (stats: SyncStats) => {
      this.emit("stats-update", stats);
    });

    // Connect transport to signaling server
    await this.transport.connect(roomId, secret);

    // Start sync engine
    await this.sync.start();

    // Register shutdown handlers
    this.registerSignalHandlers();

    // Start lock expiry timer
    this.lockManager.startExpiryCheck();

    this.startTime = Date.now();
    this.emit("started");
  }

  /**
   * Graceful shutdown sequence.
   */
  async stop(): Promise<void> {
    if (this.shutdownInProgress) return;
    this.shutdownInProgress = true;

    try {
      // Unregister signal handlers to prevent double-shutdown
      this.unregisterSignalHandlers();

      // Stop sync orchestrator (persists CRDT state)
      if (this.sync) {
        await this.sync.stop();
        this.sync = null;
      }

      // Stop lock manager
      this.lockManager.dispose();

      // Disconnect transport
      await this.transport.disconnect();

      // Remove PID file
      await safeUnlink(this.pidFile);

      // Remove socket file
      await safeUnlink(this.sockFile);

      this.emit("stopped");
    } finally {
      this.shutdownInProgress = false;
    }
  }

  // ─── Pause / Resume ──────────────────────────────────────

  /**
   * Pause sync with a tracked reason. Multiple sources can pause concurrently.
   */
  pause(source: PauseSource = "user", id?: string): void {
    this.sync?.addPause({
      source,
      id: id ?? crypto.randomUUID(),
      timestamp: Date.now(),
    });
  }

  /**
   * Resume sync by removing pause reasons for the given source.
   * With force=true and source="user", clears all pause reasons (admin override).
   */
  resume(source: PauseSource = "user", id?: string, force?: boolean): void {
    this.sync?.removePause(source, id, force);
  }

  // ─── File Locking ──────────────────────────────────────────

  /**
   * Acquire a file lock. Returns grant/deny response.
   */
  async acquireLock(path: string, options: LockRequestOptions = {}): Promise<LockResponse> {
    await this.waitForRemoteLock(path, options);
    return this.lockManager.acquireQueued(path, this.peerId, this.peerName, options);
  }

  /**
   * Release a file lock. Only the holder can release unless force=true.
   */
  releaseLock(path: string, force = false): boolean {
    return this.lockManager.release(path, this.peerId, force);
  }

  /**
   * Query locks — all active locks or a specific file's lock.
   */
  queryLocks(path?: string): FileLock[] {
    const localLocks = path
      ? (() => {
          const lock = this.lockManager.getLock(path);
          return lock ? [lock] : [];
        })()
      : this.lockManager.getAll();
    const remoteLocks = this.sync?.getRemoteLocks(path) ?? [];
    return [...localLocks, ...remoteLocks];
  }

  /**
   * Query queued lock waiters.
   */
  queryLockWaiters(path?: string): FileLockWaiter[] {
    return this.lockManager.getWaiters(path);
  }

  private async waitForRemoteLock(path: string, options: LockRequestOptions): Promise<void> {
    const startedAt = Date.now();
    const timeoutMs = options.timeoutMs ?? 60_000;
    while (true) {
      const remoteLock = this.sync?.getRemoteLocks(path)[0];
      if (!remoteLock) return;
      if (!options.wait) {
        throw new Error(`Lock denied — ${path} is locked by ${remoteLock.holderName}`);
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for remote lock on ${path}`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
  }

  // ─── Status ──────────────────────────────────────────────

  /**
   * Get current daemon status.
   */
  getStatus(): DaemonStatus {
    const stats = this.sync?.getStats();
    return {
      state: this.sync?.state ?? "stopping",
      roomId: this.roomId || null,
      peers: this.transport.getPeers(),
      trackedFiles: stats?.filesTracked ?? 0,
      activeYDocs: stats?.activeYDocs ?? 0,
      opsPerSecond: stats?.opsPerSecond ?? 0,
      uptime: this.startTime > 0 ? Date.now() - this.startTime : 0,
      memoryUsageMB: Math.round(process.memoryUsage.rss() / 1_048_576),
      pauseReasons: this.sync?.getActivePauseReasons() ?? [],
      locks: this.queryLocks(),
      lockWaiters: this.queryLockWaiters(),
      mergeWarnings: this.sync?.getMergeWarnings() ?? [],
      recentActivity: [...this.recentActivity].reverse(),
    };
  }

  private pushRecentActivity(entry: LocalActivityEntry): void {
    this.recentActivity.push(entry);
    if (this.recentActivity.length > MflowDaemon.MAX_RECENT_ACTIVITY) {
      this.recentActivity.shift();
    }
  }

  /**
   * Get connected peer list.
   */
  getPeers(): PeerInfo[] {
    return this.transport.getPeers();
  }

  /**
   * Get the auto-generated or provided peer ID.
   */
  getPeerId(): string {
    return this.peerId;
  }

  // ─── Config File Loading ──────────────────────────────────

  /**
   * Load config from `.mflow/config.toml` if it exists.
   * Uses a minimal TOML parser for the flat key-value structure we use.
   */
  private async loadConfigFile(): Promise<void> {
    const configPath = join(this.projectRoot, MFLOW_CONFIG_FILE);
    try {
      const content = await readFile(configPath, "utf-8");
      const parsed = parseSimpleToml(content);
      // Re-merge: file config as base, then existing overrides on top
      this.config = MflowConfigSchema.parse(
        deepMerge(parsed, this.config as unknown as Record<string, unknown>),
      );
    } catch {
      // Config file doesn't exist or is malformed — use defaults
    }
  }

  // ─── PID Management ──────────────────────────────────────

  /**
   * Check for stale PID file and remove it if the process is no longer running.
   * Throws if another daemon instance is running.
   */
  private async checkStalePid(): Promise<void> {
    try {
      const pidContent = await readFile(this.pidFile, "utf-8");
      const pid = parseInt(pidContent.trim(), 10);
      if (isNaN(pid)) {
        await safeUnlink(this.pidFile);
        return;
      }

      if (isProcessRunning(pid)) {
        throw new Error(
          `Another mflow daemon is already running (PID ${pid}). ` +
            `Use "mflow stop" to stop it, or remove ${this.pidFile} if the process is stale.`,
        );
      }

      // Stale PID file — remove it
      await safeUnlink(this.pidFile);
    } catch (err) {
      // If the error is our "already running" error, re-throw
      if (err instanceof Error && err.message.includes("already running")) {
        throw err;
      }
      // Otherwise, PID file doesn't exist — continue
    }
  }

  // ─── Git Auto-Detection ──────────────────────────────────

  /**
   * Auto-detect room ID from git remote URL + branch.
   * Falls back to a random UUID if git info is unavailable.
   */
  private async autoDetectRoomId(): Promise<string> {
    try {
      const remoteUrl = execGitCommand("git config --get remote.origin.url", this.projectRoot);
      const branch = execGitCommand("git rev-parse --abbrev-ref HEAD", this.projectRoot);

      if (remoteUrl && branch) {
        const hash = await sha256(`${remoteUrl}:${branch}`);
        return hash.slice(0, 16);
      }
    } catch {
      // Git not available or not a git repo
    }

    return crypto.randomUUID();
  }

  // ─── Signal Handling ──────────────────────────────────────

  private registerSignalHandlers(): void {
    const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
    for (const signal of signals) {
      const handler = (): void => {
        void this.stop();
      };
      process.on(signal, handler);
      this.signalHandlers.push({ signal, handler });
    }
  }

  private unregisterSignalHandlers(): void {
    for (const { signal, handler } of this.signalHandlers) {
      process.removeListener(signal, handler);
    }
    this.signalHandlers = [];
  }
}

// ─── Helpers ──────────────────────────────────────────────────

/**
 * Execute a git command synchronously and return trimmed output.
 * Returns empty string on failure.
 */
function execGitCommand(command: string, cwd: string): string {
  try {
    return execSync(command, { cwd, encoding: "utf-8", timeout: 5_000 }).trim();
  } catch {
    return "";
  }
}

/**
 * Check if a process with the given PID is running.
 */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Unlink a file, ignoring ENOENT errors.
 */
async function safeUnlink(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

/**
 * Deep merge two plain objects. Source values overwrite target values.
 * Arrays from source replace target arrays entirely.
 */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };

  for (const key of Object.keys(source)) {
    const sourceVal = source[key];
    const targetVal = result[key];

    if (
      sourceVal !== null &&
      typeof sourceVal === "object" &&
      !Array.isArray(sourceVal) &&
      targetVal !== null &&
      typeof targetVal === "object" &&
      !Array.isArray(targetVal)
    ) {
      result[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>,
      );
    } else if (sourceVal !== undefined) {
      result[key] = sourceVal;
    }
  }

  return result;
}

/**
 * Minimal TOML parser for flat/shallow config structure.
 * Handles sections like [daemon], [sync], and simple key=value pairs.
 * Does not handle nested tables, arrays of tables, or multi-line strings.
 */
function parseSimpleToml(content: string): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};
  let currentSection = "";

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();

    // Skip empty lines and comments
    if (!line || line.startsWith("#")) continue;

    // Section header: [section] or [section.subsection]
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      // Ensure section object exists (handle dotted keys like [sync.ignore])
      const parts = currentSection.split(".");
      let cursor = result as Record<string, unknown>;
      for (const part of parts) {
        if (!(part in cursor) || typeof cursor[part] !== "object") {
          cursor[part] = {};
        }
        cursor = cursor[part] as Record<string, unknown>;
      }
      continue;
    }

    // Key = value
    const kvMatch = line.match(/^(\w+)\s*=\s*(.+)$/);
    if (!kvMatch) continue;

    const key = kvMatch[1];
    const rawValue = kvMatch[2].trim();
    const value = parseTomlValue(rawValue);

    if (currentSection) {
      const parts = currentSection.split(".");
      let cursor = result as Record<string, unknown>;
      for (const part of parts) {
        if (!(part in cursor)) {
          cursor[part] = {};
        }
        cursor = cursor[part] as Record<string, unknown>;
      }
      cursor[key] = value;
    } else {
      result[key] = value as Record<string, unknown>;
    }
  }

  return result;
}

/**
 * Parse a single TOML value (string, number, boolean, or simple array).
 */
function parseTomlValue(raw: string): unknown {
  // Quoted string
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }

  // Boolean
  if (raw === "true") return true;
  if (raw === "false") return false;

  // Simple array: [val1, val2, ...]
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((item) => parseTomlValue(item.trim()));
  }

  // Number
  const num = Number(raw);
  if (!isNaN(num) && raw !== "") return num;

  // Fallback: treat as string
  return raw;
}
