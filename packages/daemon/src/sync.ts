import { EventEmitter } from "node:events";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type {
  DaemonState,
  ITransport,
  ManifestEntry,
  MflowConfig,
} from "@mflow/shared";
import {
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
 * Handles state transitions (syncing, paused, git_paused) and
 * manages the lifecycle of all sub-components.
 */
export class SyncOrchestrator extends EventEmitter {
  private _state: DaemonState = "starting";
  private readonly projectRoot: string;
  private readonly config: MflowConfig;

  // Components
  readonly crdt: CRDTManager;
  readonly watcher: FileWatcher;
  readonly manifest: ManifestManager;
  readonly persistence: CRDTPersistence;
  readonly awareness: AwarenessManager;
  readonly git: GitDetector;
  private readonly transport: ITransport;

  // Stats
  private totalOps = 0;
  private opsInWindow = 0;
  private opsPerSecond = 0;
  private statsTimer: ReturnType<typeof setInterval> | null = null;

  // Pause state
  private bufferedUpdates: Array<{ path: string; update: Uint8Array }> = [];
  private bufferedBytes = 0;

  // Remote write validation
  private readonly ignoreFilter: IgnoreFilter;

  constructor(options: SyncOrchestratorOptions) {
    super();
    this.projectRoot = options.projectRoot;
    this.config = options.config;
    this.transport = options.transport;

    // Initialize components
    this.crdt = new CRDTManager(options.config.sync.unload_after_minutes);
    this.persistence = new CRDTPersistence(options.projectRoot);
    this.manifest = new ManifestManager();
    this.git = new GitDetector(options.projectRoot);

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

  get state(): DaemonState {
    return this._state;
  }

  private setState(state: DaemonState): void {
    if (this._state === state) return;
    this._state = state;
    this.emit("state-changed", state);
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
      this.handleRemoteUpdate(fileId, update);
    });

    // ── CRDT → Transport ──

    this.crdt.on("local-update", (path: string, update: Uint8Array) => {
      if (this._state === "syncing") {
        this.transport.sendUpdate(path, update);
        this.totalOps++;
        this.opsInWindow++;
      }
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
        this.setState("git_paused");
      }
    });

    this.git.on("git-operation-end", () => {
      if (this._state === "git_paused") {
        // Re-scan files after git operation
        this.setState("scanning");
        // The watcher is still running and will pick up changes
        this.setState("syncing");
      }
    });

    // ── Awareness ──

    this.awareness.bind(this.transport);
  }

  // ─── Local Change Handlers ──────────────────────────────

  private handleLocalChange(path: string, content: string): void {
    if (this._state !== "syncing") return;
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
    if (this._state !== "syncing") return;
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
    if (this._state !== "syncing") return;
    this.manifest.deleteFile(path);
  }

  // ─── Remote Change Handlers ─────────────────────────────

  private async handleRemoteUpdate(fileId: string, update: Uint8Array): Promise<void> {
    // Handle manifest updates separately
    if (fileId === "__manifest__") {
      this.manifest.applyRemoteUpdate(update);
      return;
    }

    if (this._state === "paused") {
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

    if (this._state !== "syncing" && this._state !== "git_paused") return;

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
   * Pause sync (stop broadcasting local changes, buffer incoming).
   */
  pause(): void {
    if (this._state !== "syncing") return;
    this.setState("paused");
  }

  /**
   * Resume sync (apply buffered changes, resume broadcasting).
   */
  resume(): void {
    if (this._state !== "paused") return;
    this.setState("syncing");

    // Apply buffered updates
    for (const { path, update } of this.bufferedUpdates) {
      void this.handleRemoteUpdate(path, update);
    }
    this.bufferedUpdates = [];
    this.bufferedBytes = 0;
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
   * Graceful shutdown: persist state, stop all components.
   */
  async stop(): Promise<void> {
    this.setState("stopping");

    // Stop stats
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }

    // Stop awareness
    this.awareness.dispose();

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
