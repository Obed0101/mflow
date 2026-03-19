import { EventEmitter } from "node:events";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type {
  DaemonState,
  FileLock,
  ITransport,
  ManifestEntry,
  MergeWarning,
  MergeWarningType,
  MflowConfig,
  PauseReason,
  PauseSource,
} from "@mflow/shared";
import {
  GATE_WINDOW_MS,
  GATE_DRAIN_INTERVAL_MS,
  MAX_FILE_SIZE_BYTES,
  MAX_TRACKED_FILES,
} from "@mflow/shared";
import { shouldSync, createDefaultFilter, type IgnoreFilter } from "@mflow/shared";
import { CRDTManager } from "./crdt.js";
import { FileWatcher } from "./watcher.js";
import { ManifestManager } from "./manifest.js";
import { CRDTPersistence } from "./persistence.js";
import { AwarenessManager } from "./awareness.js";
import { GitDetector } from "./git.js";
import { FileLockManager } from "./file-lock-manager.js";

// ─── Pause Buffer Limits ──────────────────────────────────
const MAX_BUFFERED_UPDATES = 1_000;
const MAX_BUFFERED_BYTES = 50 * 1024 * 1024; // 50MB

// ─── Internal Path Blocklist ──────────────────────────────
const BLOCKED_PATH_PREFIXES = [".git/", ".mflow/", ".agents/"];

// ─── Path Validation ────────────────────────────────────────

/**
 * Validate that a resolved file path stays within the project root.
 * Prevents path traversal attacks via malicious fileId (e.g. "../../.ssh/authorized_keys").
 */
function isWithinProject(projectRoot: string, filePath: string): boolean {
  const resolved = resolve(projectRoot, filePath);
  const normalizedRoot = resolve(projectRoot) + "/";
  return resolved.startsWith(normalizedRoot);
}

/**
 * Validate that the final filesystem target (after symlink resolution) stays
 * within the project root. Prevents symlink escape attacks where a symlinked
 * directory inside the repo points outside it.
 */
async function isWithinProjectReal(projectRoot: string, absPath: string): Promise<boolean> {
  try {
    const realRoot = await realpath(projectRoot);
    // Resolve as far as possible — for new files, resolve the parent directory
    let realTarget: string;
    try {
      realTarget = await realpath(absPath);
    } catch {
      // File doesn't exist yet — resolve the parent directory instead
      const parentDir = dirname(absPath);
      try {
        const realParent = await realpath(parentDir);
        realTarget = join(realParent, absPath.slice(parentDir.length + 1));
      } catch {
        // Parent doesn't exist either — will be created by mkdir, check textual path
        return absPath.startsWith(realRoot + "/");
      }
    }
    return realTarget.startsWith(realRoot + "/");
  } catch {
    return false;
  }
}

// ─── Types ──────────────────────────────────────────────────

export interface SyncOrchestratorEvents {
  "state-changed": (state: DaemonState) => void;
  "file-synced": (path: string, direction: "local" | "remote") => void;
  "sync-error": (path: string, error: Error) => void;
  "stats-update": (stats: SyncStats) => void;
  "merge-warning": (warning: MergeWarning) => void;
  "gate-overflow": (path: string) => void;
}

export interface SyncStats {
  opsPerSecond: number;
  totalOps: number;
  filesTracked: number;
  activeYDocs: number;
}

export interface SyncOrchestratorOptions {
  projectRoot: string;
  config: MflowConfig;
  transport: ITransport;
  peerId: string;
}

// ─── SyncOrchestrator ───────────────────────────────────────

/**
 * Central coordinator that wires together all daemon components.
 *
 * Flow:
 * - Local changes:  FileWatcher → CRDTManager → Transport → Remote peers
 * - Remote changes: Transport → CRDTManager → WriteRegistry → Filesystem
 *
 * Handles state transitions (syncing, paused via PauseReason set) and
 * manages the lifecycle of all sub-components.
 */
export class SyncOrchestrator extends EventEmitter {
  private _state: DaemonState = "starting";
  private readonly projectRoot: string;
  private readonly config: MflowConfig;
  private readonly peerId: string;

  // Components
  readonly crdt: CRDTManager;
  readonly watcher: FileWatcher;
  readonly manifest: ManifestManager;
  readonly persistence: CRDTPersistence;
  readonly awareness: AwarenessManager;
  readonly git: GitDetector;
  readonly locks: FileLockManager;
  private readonly transport: ITransport;

  // Stats
  private totalOps = 0;
  private opsInWindow = 0;
  private opsPerSecond = 0;
  private statsTimer: ReturnType<typeof setInterval> | null = null;

  // Pause state — set-based model for concurrent pause sources
  readonly pauseReasons: Map<string, PauseReason> = new Map();
  private bufferedUpdates: Array<{ path: string; update: Uint8Array }> = [];
  private bufferedBytes = 0;

  // Propagation gate (Layer 1) — tracks remote edit recency per file
  private readonly recentRemoteEdits = new Map<string, { peerId: string; timestamp: number }>();
  private readonly gateQueue = new Map<string, Array<{ update: Uint8Array; timestamp: number }>>();
  private gateQueueBytes = 0;
  private gateDrainTimer: ReturnType<typeof setInterval> | null = null;

  // Syntax guard (Layer 3) — active merge warnings
  private readonly mergeWarnings = new Map<string, MergeWarning>();

  // Remote write validation
  private readonly ignoreFilter: IgnoreFilter;

  constructor(options: SyncOrchestratorOptions) {
    super();
    this.projectRoot = options.projectRoot;
    this.config = options.config;
    this.transport = options.transport;
    this.peerId = options.peerId;

    // Initialize components
    this.crdt = new CRDTManager(options.config.sync.unload_after_minutes);
    this.persistence = new CRDTPersistence(options.projectRoot);
    this.manifest = new ManifestManager();
    this.git = new GitDetector(options.projectRoot);
    this.locks = new FileLockManager();

    // Watcher needs an IgnoreFilter — also used for remote write validation
    const filter = createDefaultFilter();
    filter.addPatterns(options.config.sync.ignore.patterns);
    this.ignoreFilter = filter;

    this.watcher = new FileWatcher({
      projectRoot: options.projectRoot,
      filter,
      debounceMs: options.config.sync.debounce_ms,
    });

    this.awareness = new AwarenessManager({
      peerId: options.peerId,
      peerName: options.config.daemon.name || `${process.env.HOSTNAME ?? "peer"}-${process.pid}`,
      peerType: options.config.daemon.type === "auto" ? "agent" : options.config.daemon.type,
      broadcastIntervalMs: options.config.awareness.broadcast_interval_ms,
      shareCurrentFile: options.config.awareness.share_current_file,
    });

    this.wireComponents();
  }

  // ─── State ──────────────────────────────────────────────

  /**
   * Whether any pause reasons are active. Derived from pauseReasons map.
   */
  get isPaused(): boolean {
    return this.pauseReasons.size > 0;
  }

  /**
   * Effective daemon state. "paused" is derived from pauseReasons;
   * all other states come from _state.
   */
  get state(): DaemonState {
    if (this._state === "stopping") return "stopping";
    if (this.isPaused) return "paused";
    return this._state;
  }

  private setState(state: DaemonState): void {
    if (this._state === state) return;
    this._state = state;
    this.emit("state-changed", this.state);
  }

  // ─── Wiring ─────────────────────────────────────────────

  /**
   * Wire all component events together.
   */
  private wireComponents(): void {
    // ── Local change flow: Watcher → CRDT → Transport ──

    this.watcher.on("file-changed", (path: string, content: string) => {
      this.handleLocalChange(path, content);
    });

    this.watcher.on("file-created", (path: string, content: string) => {
      this.handleLocalCreate(path, content);
    });

    this.watcher.on("file-deleted", (path: string) => {
      this.handleLocalDelete(path);
    });

    this.watcher.on("ready", () => {
      if (this._state === "scanning") {
        this.setState("connecting");
      }
    });

    // ── Remote change flow: Transport → CRDT → Filesystem ──

    this.transport.onUpdate((fileId, update, peerId) => {
      // Track remote edit recency for propagation gate (Layer 1)
      if (fileId !== "__manifest__") {
        this.recentRemoteEdits.set(fileId, { peerId, timestamp: Date.now() });
      }
      this.handleRemoteUpdate(fileId, update);
    });

    // ── CRDT → Transport (with propagation gate + lock check) ──

    this.crdt.on("local-update", (path: string, update: Uint8Array) => {
      if (this._state !== "syncing") return;

      // Layer 2: Check if file is locked by another peer
      if (this.locks.isLockedByOther(path, this.peerId)) {
        this.enqueueGatedUpdate(path, update);
        return;
      }

      // Layer 1: Check propagation gate (remote edit recency + awareness)
      if (this.shouldGate(path)) {
        this.enqueueGatedUpdate(path, update);
        return;
      }

      // No gate — propagate immediately
      this.transport.sendUpdate(path, update);
      this.totalOps++;
      this.opsInWindow++;
    });

    // ── Lock events → drain gate queue on release/expiry ──

    this.locks.on("lock-released", (path: string) => {
      this.drainFileQueue(path);
    });

    this.locks.on("lock-expired", (lock: FileLock) => {
      this.drainFileQueue(lock.path);
    });

    // ── Manifest → Transport ──

    this.manifest.on("manifest-update", (update: Uint8Array) => {
      if (this._state === "syncing") {
        this.transport.sendUpdate("__manifest__", update);
      }
    });

    // ── Git detection ──

    this.git.on("git-operation-start", () => {
      if (this._state === "syncing") {
        this.addPause({ source: "git", id: "index-lock", timestamp: Date.now() });
      }
    });

    this.git.on("git-operation-end", () => {
      this.removePause("git", "index-lock");
    });

    // ── Awareness ──

    this.awareness.bind(this.transport);
  }

  // ─── Local Change Handlers ──────────────────────────────

  private handleLocalChange(path: string, content: string): void {
    if (this._state !== "syncing" || this.isPaused) return;
    if (!isWithinProject(this.projectRoot, path)) {
      this.emit("sync-error", path, new Error(`Path traversal blocked: ${path}`));
      return;
    }

    try {
      const hash = this.watcher.computeHash(content);
      const currentContent = this.crdt.getContent(path);

      let update: Uint8Array | null;
      if (currentContent === null) {
        // First time seeing this file — initialize
        update = this.crdt.initializeContent(path, content, hash);
      } else {
        update = this.crdt.applyLocalChange(path, currentContent, content, hash);
      }

      if (update && update.byteLength > 0) {
        // Update manifest
        this.manifest.setFile(path, {
          exists: true,
          contentHash: hash,
          mtime: Date.now(),
          size: Buffer.byteLength(content, "utf-8"),
        });

        this.awareness.setCurrentFile(path);
        this.emit("file-synced", path, "local");
      }
    } catch (err) {
      this.emit(
        "sync-error",
        path,
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }

  private handleLocalCreate(path: string, content: string): void {
    if (this._state !== "syncing" || this.isPaused) return;
    if (!isWithinProject(this.projectRoot, path)) {
      this.emit("sync-error", path, new Error(`Path traversal blocked: ${path}`));
      return;
    }

    try {
      const hash = this.watcher.computeHash(content);
      const update = this.crdt.initializeContent(path, content, hash);

      this.manifest.setFile(path, {
        exists: true,
        contentHash: hash,
        mtime: Date.now(),
        size: Buffer.byteLength(content, "utf-8"),
      });

      this.emit("file-synced", path, "local");
    } catch (err) {
      this.emit(
        "sync-error",
        path,
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }

  private handleLocalDelete(path: string): void {
    if (this._state !== "syncing" || this.isPaused) return;
    this.manifest.deleteFile(path);
  }

  // ─── Remote Change Handlers ─────────────────────────────

  private async handleRemoteUpdate(fileId: string, update: Uint8Array): Promise<void> {
    // Handle manifest updates separately
    if (fileId === "__manifest__") {
      this.manifest.applyRemoteUpdate(update);
      return;
    }

    if (this.isPaused) {
      // FIX 5: Bounded pause buffer — drop oldest when limits exceeded
      if (
        this.bufferedUpdates.length >= MAX_BUFFERED_UPDATES ||
        this.bufferedBytes + update.byteLength > MAX_BUFFERED_BYTES
      ) {
        const dropped = this.bufferedUpdates.shift();
        if (dropped) {
          this.bufferedBytes -= dropped.update.byteLength;
        }
      }
      this.bufferedUpdates.push({ path: fileId, update });
      this.bufferedBytes += update.byteLength;
      return;
    }

    if (this._state !== "syncing") return;

    // Validate path stays within project root (prevents path traversal from remote peers)
    if (!isWithinProject(this.projectRoot, fileId)) {
      this.emit("sync-error", fileId, new Error(`Path traversal blocked: ${fileId}`));
      return;
    }

    // FIX 4: Reject writes to internal/blocked paths
    for (const prefix of BLOCKED_PATH_PREFIXES) {
      if (fileId.startsWith(prefix) || fileId === prefix.slice(0, -1)) {
        this.emit("sync-error", fileId, new Error(`Blocked internal path: ${fileId}`));
        return;
      }
    }

    try {
      const content = this.crdt.applyRemoteUpdate(fileId, update);

      // FIX 4: Enforce ignore rules and size limits on remote writes
      const contentSize = Buffer.byteLength(content, "utf-8");
      const syncResult = shouldSync(fileId, contentSize, undefined, this.ignoreFilter);
      if (!syncResult.sync) {
        this.emit("sync-error", fileId, new Error(`Remote write rejected (${syncResult.reason}): ${fileId}`));
        return;
      }

      // FIX 4: Enforce max tracked files
      if (this.manifest.fileCount >= MAX_TRACKED_FILES && !this.manifest.hasFile(fileId)) {
        this.emit("sync-error", fileId, new Error(`Max tracked files (${MAX_TRACKED_FILES}) exceeded`));
        return;
      }

      const hash = this.watcher.computeHash(content);

      // Register the write in the suppression registry
      this.watcher.writeRegistry.register(fileId, hash);

      // Write to filesystem — ensure parent directory exists
      const absPath = join(this.projectRoot, fileId);

      // FIX 1: Symlink escape prevention — verify real path after mkdir
      await mkdir(dirname(absPath), { recursive: true });

      if (!(await isWithinProjectReal(this.projectRoot, absPath))) {
        this.emit("sync-error", fileId, new Error(`Symlink escape blocked: ${fileId}`));
        return;
      }

      await writeFile(absPath, content, "utf-8");

      // Layer 3: Syntax guard — check for merge corruption on code files
      this.checkMergeCorruption(fileId, content);

      // Update manifest
      this.manifest.setFile(fileId, {
        exists: true,
        contentHash: hash,
        mtime: Date.now(),
        size: contentSize,
      });

      this.totalOps++;
      this.opsInWindow++;
      this.emit("file-synced", fileId, "remote");
    } catch (err) {
      this.emit(
        "sync-error",
        fileId,
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }

  // ─── Lifecycle ──────────────────────────────────────────

  /**
   * Start the sync engine.
   */
  async start(): Promise<void> {
    this.setState("scanning");

    // Restore persisted manifest
    const manifestState = await this.persistence.loadManifest();
    if (manifestState) {
      this.manifest.restoreFromState(manifestState);
    }

    // Start components
    await this.git.start();
    this.watcher.start();
    this.crdt.startUnloadTimer(this.persistence);
    this.awareness.startBroadcasting();
    this.locks.startExpiryCheck();

    // Start gate drain timer (Layer 1)
    this.gateDrainTimer = setInterval(() => {
      this.drainGateQueue();
    }, GATE_DRAIN_INTERVAL_MS);

    // Start stats tracking
    this.statsTimer = setInterval(() => {
      this.opsPerSecond = this.opsInWindow;
      this.opsInWindow = 0;
      this.emit("stats-update", this.getStats());
    }, 1_000);

    // Transition to syncing when transport is connected
    if (this.transport.getConnectionState() === "connected") {
      this.setState("syncing");
    }

    // Also watch for transport connection state changes
    // Poll every 500ms until connected (transport doesn't emit events)
    const connectionPoll = setInterval(() => {
      if (this._state === "stopping") {
        clearInterval(connectionPoll);
        return;
      }
      const connState = this.transport.getConnectionState();
      if (connState === "connected" && (this._state === "scanning" || this._state === "connecting")) {
        this.setState("syncing");
        clearInterval(connectionPoll);
      }
    }, 500);
  }

  /**
   * Add a pause reason. Multiple sources can pause concurrently;
   * the daemon is paused as long as any reason remains.
   */
  addPause(reason: PauseReason): void {
    const key = `${reason.source}:${reason.id}`;
    this.pauseReasons.set(key, reason);
    console.log(`[sync] pause added: ${key} (total: ${this.pauseReasons.size})`);
    this.emit("state-changed", this.state);
  }

  /**
   * Remove pause reasons. Priority enforcement:
   * - "user" with force=true clears everything (admin override)
   * - "user" without force clears only "user" reasons
   * - "mcp" clears "mcp" and "auto" reasons
   * - "git" clears only "git" reasons
   * - "auto" clears only "auto" reasons
   *
   * If id is provided, removes only that specific reason.
   */
  removePause(source: PauseSource, id?: string, force?: boolean): void {
    if (force && source === "user") {
      // Admin override — clear everything
      this.pauseReasons.clear();
      console.log("[sync] all pause reasons force-cleared by user");
    } else if (id) {
      // Remove specific reason
      const key = `${source}:${id}`;
      this.pauseReasons.delete(key);
      console.log(`[sync] pause removed: ${key} (remaining: ${this.pauseReasons.size})`);
    } else {
      // Remove all reasons this source is allowed to clear
      const allowedSources = this.getAllowedClearSources(source);
      for (const key of [...this.pauseReasons.keys()]) {
        const keySource = key.split(":")[0] as PauseSource;
        if (allowedSources.includes(keySource)) {
          this.pauseReasons.delete(key);
        }
      }
      console.log(`[sync] pause reasons cleared for sources: ${allowedSources.join(",")} (remaining: ${this.pauseReasons.size})`);
    }

    // If no more reasons, flush buffered updates
    if (!this.isPaused) {
      this.flushBufferedUpdates();
    }
    this.emit("state-changed", this.state);
  }

  /**
   * Get the list of pause sources a given source is allowed to clear.
   */
  private getAllowedClearSources(source: PauseSource): PauseSource[] {
    switch (source) {
      case "user": return ["user"];
      case "mcp":  return ["mcp", "auto"];
      case "git":  return ["git"];
      case "auto": return ["auto"];
      default: {
        const _exhaustive: never = source;
        return [_exhaustive];
      }
    }
  }

  /**
   * Apply all buffered remote updates. Called when all pause reasons are removed.
   */
  private flushBufferedUpdates(): void {
    const updates = this.bufferedUpdates;
    this.bufferedUpdates = [];
    this.bufferedBytes = 0;
    console.log(`[sync] flushing ${updates.length} buffered updates`);
    for (const { path, update } of updates) {
      void this.handleRemoteUpdate(path, update);
    }
  }

  /**
   * Get a snapshot of active pause reasons.
   */
  getActivePauseReasons(): PauseReason[] {
    return [...this.pauseReasons.values()];
  }

  /**
   * Get current sync statistics.
   */
  getStats(): SyncStats {
    return {
      opsPerSecond: this.opsPerSecond,
      totalOps: this.totalOps,
      filesTracked: this.manifest.fileCount,
      activeYDocs: this.crdt.getActiveDocCount(),
    };
  }

  /**
   * Get active merge warnings.
   */
  getMergeWarnings(): MergeWarning[] {
    return [...this.mergeWarnings.values()];
  }

  // ─── Propagation Gate (Layer 1) ────────────────────────

  /**
   * Check if a file should be gated (local updates queued instead of propagated).
   * Gate is active when:
   * 1. A remote update for this file was received within GATE_WINDOW_MS, OR
   * 2. Another peer is listed as editing this file in awareness data.
   */
  private shouldGate(path: string): boolean {
    // Check remote edit recency
    const recentEdit = this.recentRemoteEdits.get(path);
    if (recentEdit && Date.now() - recentEdit.timestamp < GATE_WINDOW_MS) {
      return true;
    }

    // Check awareness — is another peer editing this file?
    const editors = this.awareness.getFileEditors(path);
    if (editors.length > 0) {
      return true;
    }

    return false;
  }

  /**
   * Enqueue a local update in the gate queue for later propagation.
   * If queue overflows, force-drain to prevent data loss (NFR-2).
   */
  private enqueueGatedUpdate(path: string, update: Uint8Array): void {
    let queue = this.gateQueue.get(path);
    if (!queue) {
      queue = [];
      this.gateQueue.set(path, queue);
    }

    // Check overflow before enqueue
    const totalQueued = Array.from(this.gateQueue.values()).reduce((sum, q) => sum + q.length, 0);
    if (totalQueued >= MAX_BUFFERED_UPDATES || this.gateQueueBytes + update.byteLength > MAX_BUFFERED_BYTES) {
      // Force-drain everything to prevent data loss
      this.emit("gate-overflow", path);
      this.forceFlushGateQueue();
      // Send the current update directly
      this.transport.sendUpdate(path, update);
      this.totalOps++;
      this.opsInWindow++;
      return;
    }

    queue.push({ update, timestamp: Date.now() });
    this.gateQueueBytes += update.byteLength;
  }

  /**
   * Check all gated files and drain queues where the gate has cleared.
   * Called every GATE_DRAIN_INTERVAL_MS.
   */
  private drainGateQueue(): void {
    if (this._state !== "syncing") return;

    for (const [path, queue] of this.gateQueue) {
      // Skip if still gated or locked by another peer
      if (this.locks.isLockedByOther(path, this.peerId)) continue;
      if (this.shouldGate(path)) continue;

      // Gate cleared — drain all queued updates for this file
      this.drainFileQueue(path);
    }
  }

  /**
   * Drain all queued updates for a specific file.
   */
  private drainFileQueue(path: string): void {
    const queue = this.gateQueue.get(path);
    if (!queue || queue.length === 0) return;

    for (const { update } of queue) {
      this.transport.sendUpdate(path, update);
      this.gateQueueBytes -= update.byteLength;
      this.totalOps++;
      this.opsInWindow++;
    }
    this.gateQueue.delete(path);
  }

  /**
   * Force-flush all gate queues. Used on overflow to prevent data loss.
   */
  private forceFlushGateQueue(): void {
    for (const [path, queue] of this.gateQueue) {
      for (const { update } of queue) {
        this.transport.sendUpdate(path, update);
        this.totalOps++;
        this.opsInWindow++;
      }
    }
    this.gateQueue.clear();
    this.gateQueueBytes = 0;
  }

  // ─── Syntax Guard (Layer 3) ───────────────────────────

  /**
   * Check merged content for corruption indicators.
   * Only runs on code files (.ts, .tsx, .js, .jsx).
   * Emits merge-warning events but does NOT revert — CRDT remains source of truth.
   */
  private checkMergeCorruption(path: string, content: string): void {
    if (!/\.(ts|tsx|js|jsx)$/.test(path)) return;

    const warnings: Array<{ type: MergeWarningType; detail: string }> = [];

    // Check for duplicate consecutive import lines
    const lines = content.split("\n");
    const importLines: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^import\s/.test(trimmed)) {
        if (importLines.includes(trimmed)) {
          warnings.push({
            type: "duplicate-import",
            detail: `Duplicate import: ${trimmed.slice(0, 80)}`,
          });
          break; // One warning per type per file
        }
        importLines.push(trimmed);
      }
    }

    // Check for unbalanced braces
    let braceCount = 0;
    let bracketCount = 0;
    let inString = false;
    let stringChar = "";
    for (let i = 0; i < content.length; i++) {
      const ch = content[i];
      const prev = i > 0 ? content[i - 1] : "";

      if (inString) {
        if (ch === stringChar && prev !== "\\") {
          inString = false;
        }
        continue;
      }

      if (ch === '"' || ch === "'" || ch === "`") {
        inString = true;
        stringChar = ch;
        continue;
      }

      if (ch === "/" && content[i + 1] === "/") {
        // Skip to end of line
        while (i < content.length && content[i] !== "\n") i++;
        continue;
      }

      if (ch === "{") braceCount++;
      else if (ch === "}") braceCount--;
      else if (ch === "[") bracketCount++;
      else if (ch === "]") bracketCount--;
    }

    if (braceCount !== 0) {
      warnings.push({
        type: "unbalanced-braces",
        detail: `Unbalanced braces: ${braceCount > 0 ? `${braceCount} unclosed` : `${-braceCount} extra closing`}`,
      });
    }

    if (bracketCount !== 0) {
      warnings.push({
        type: "unbalanced-braces",
        detail: `Unbalanced brackets: ${bracketCount > 0 ? `${bracketCount} unclosed` : `${-bracketCount} extra closing`}`,
      });
    }

    // Emit warnings and update tracking
    if (warnings.length > 0) {
      for (const w of warnings) {
        const warning: MergeWarning = {
          path,
          type: w.type,
          detail: w.detail,
          timestamp: Date.now(),
        };
        this.mergeWarnings.set(`${path}:${w.type}`, warning);
        this.emit("merge-warning", warning);
      }
    } else {
      // Clear previous warnings for this file if content is now clean
      for (const key of this.mergeWarnings.keys()) {
        if (key.startsWith(`${path}:`)) {
          this.mergeWarnings.delete(key);
        }
      }
    }
  }

  /**
   * Graceful shutdown: persist state, stop all components.
   */
  async stop(): Promise<void> {
    this.setState("stopping");

    // Stop stats
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }

    // Stop gate drain timer
    if (this.gateDrainTimer) {
      clearInterval(this.gateDrainTimer);
      this.gateDrainTimer = null;
    }

    // Stop awareness
    this.awareness.dispose();

    // Stop lock manager
    this.locks.dispose();

    // Persist CRDT state
    await this.crdt.persistAll(this.persistence);

    // Persist manifest
    const manifestState = this.manifest.encodeState();
    await this.persistence.saveManifest(manifestState);

    // Stop components
    this.crdt.dispose();
    this.manifest.dispose();
    this.git.stop();
    await this.watcher.stop();

    this.removeAllListeners();
  }
}
