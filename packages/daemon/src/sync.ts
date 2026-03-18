import { EventEmitter } from "node:events";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  DaemonState,
  ITransport,
  ManifestEntry,
  MflowConfig,
} from "@mflow/shared";
import { CRDTManager } from "./crdt.js";
import { FileWatcher } from "./watcher.js";
import { ManifestManager } from "./manifest.js";
import { CRDTPersistence } from "./persistence.js";
import { AwarenessManager } from "./awareness.js";
import { GitDetector } from "./git.js";

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

    // Watcher needs an IgnoreFilter — created during start()
    // For now, create with empty filter; start() will configure it
    const { createDefaultFilter } = require("@mflow/shared") as typeof import("@mflow/shared");
    const filter = createDefaultFilter();
    filter.addPatterns(options.config.sync.ignore.patterns);

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

  private handleRemoteUpdate(fileId: string, update: Uint8Array): void {
    // Handle manifest updates separately
    if (fileId === "__manifest__") {
      this.manifest.applyRemoteUpdate(update);
      return;
    }

    if (this._state === "paused") {
      // Buffer updates while paused
      this.bufferedUpdates.push({ path: fileId, update });
      return;
    }

    if (this._state !== "syncing" && this._state !== "git_paused") return;

    try {
      const content = this.crdt.applyRemoteUpdate(fileId, update);
      const hash = this.watcher.computeHash(content);

      // Register the write in the suppression registry
      this.watcher.writeRegistry.register(fileId, hash);

      // Write to filesystem
      const absPath = join(this.projectRoot, fileId);
      void writeFile(absPath, content, "utf-8").then(() => {
        this.totalOps++;
        this.opsInWindow++;
        this.emit("file-synced", fileId, "remote");
      });
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
      this.handleRemoteUpdate(path, update);
    }
    this.bufferedUpdates = [];
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
