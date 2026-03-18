import { EventEmitter } from "node:events";
import { readFile, stat } from "node:fs/promises";
import { relative, join } from "node:path";
import chokidar from "chokidar";
import type { WriteToken } from "@mflow/shared";
import {
  WRITE_TOKEN_TTL_MS,
  DEFAULT_DEBOUNCE_MS,
} from "@mflow/shared";
import { shouldSync, type IgnoreFilter } from "@mflow/shared";

// ─── Write Registry ─────────────────────────────────────────

/**
 * In-memory registry for write-loop suppression.
 *
 * Before writing a file from a remote CRDT update, register the expected
 * content hash. When chokidar fires, check if the hash matches — if so,
 * consume the token and suppress the event.
 */
export class WriteRegistry {
  private readonly tokens = new Map<string, WriteToken[]>();
  private seq = 0;

  /**
   * Register an expected write. Call this BEFORE writing the file to disk.
   */
  register(path: string, hash: string): number {
    const token: WriteToken = {
      hash,
      seq: ++this.seq,
      timestamp: Date.now(),
    };

    const existing = this.tokens.get(path);
    if (existing) {
      existing.push(token);
    } else {
      this.tokens.set(path, [token]);
    }

    return token.seq;
  }

  /**
   * Check if a file change event should be suppressed.
   *
   * If the file's current hash matches a registered token, consume
   * the token and return `true` (suppress). Otherwise return `false`.
   */
  checkAndConsume(path: string, hash: string): boolean {
    const tokens = this.tokens.get(path);
    if (!tokens || tokens.length === 0) return false;

    const idx = tokens.findIndex((t) => t.hash === hash);
    if (idx === -1) return false;

    // Consume the matched token
    tokens.splice(idx, 1);
    if (tokens.length === 0) {
      this.tokens.delete(path);
    }

    return true;
  }

  /**
   * Remove stale tokens older than WRITE_TOKEN_TTL_MS.
   */
  cleanup(): void {
    const now = Date.now();

    for (const [path, tokens] of this.tokens) {
      const fresh = tokens.filter((t) => now - t.timestamp < WRITE_TOKEN_TTL_MS);
      if (fresh.length === 0) {
        this.tokens.delete(path);
      } else {
        this.tokens.set(path, fresh);
      }
    }
  }

  /**
   * Get the number of pending tokens (for diagnostics).
   */
  get pendingCount(): number {
    let count = 0;
    for (const tokens of this.tokens.values()) {
      count += tokens.length;
    }
    return count;
  }
}

// ─── FileWatcher ────────────────────────────────────────────

export interface FileWatcherEvents {
  "file-changed": (path: string, content: string) => void;
  "file-created": (path: string, content: string) => void;
  "file-deleted": (path: string) => void;
  ready: () => void;
  error: (err: Error) => void;
}

export interface FileWatcherOptions {
  projectRoot: string;
  filter: IgnoreFilter;
  debounceMs?: number;
}

/**
 * Watches the project directory for file changes using chokidar.
 *
 * Integrates with WriteRegistry for write-loop suppression.
 * Emits typed events for file changes, creations, and deletions.
 */
export class FileWatcher extends EventEmitter {
  private watcher: chokidar.FSWatcher | null = null;
  readonly writeRegistry = new WriteRegistry();
  private readonly projectRoot: string;
  private readonly filter: IgnoreFilter;
  private readonly debounceMs: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  /** Hash function injected at construction — avoids async import of xxhash. */
  private hashFn: ((content: string) => string) | null = null;

  constructor(options: FileWatcherOptions) {
    super();
    this.projectRoot = options.projectRoot;
    this.filter = options.filter;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  /**
   * Set the hash function used for write-loop suppression.
   * Must be set before calling `start()`.
   */
  setHashFunction(fn: (content: string) => string): void {
    this.hashFn = fn;
  }

  /**
   * Compute content hash. Falls back to simple length-based hash if no
   * hash function is set (not recommended for production).
   */
  computeHash(content: string): string {
    if (this.hashFn) return this.hashFn(content);
    // Fallback: use a simple hash (for development/testing only)
    let h = 0;
    for (let i = 0; i < content.length; i++) {
      h = (Math.imul(31, h) + content.charCodeAt(i)) | 0;
    }
    return h.toString(16);
  }

  /**
   * Start watching the project directory.
   */
  start(): void {
    if (this.watcher) return;

    // Build ignored patterns for chokidar
    const ignored = this.filter.getPatterns().map((p) => {
      // Chokidar accepts strings and regexps
      // Strip trailing / for directory patterns
      return p.endsWith("/") ? p.slice(0, -1) : p;
    });

    this.watcher = chokidar.watch(this.projectRoot, {
      ignored: [
        ...ignored,
        /(^|[/\\])\../, // Ignore dotfiles except what's explicitly tracked
      ],
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: false,
      usePolling: false,
      // Debounce via stabilityThreshold
    });

    this.watcher.on("ready", () => {
      this.emit("ready");
    });

    this.watcher.on("add", (absPath: string) => {
      void this.handleFileEvent("created", absPath);
    });

    this.watcher.on("change", (absPath: string) => {
      void this.handleFileEvent("changed", absPath);
    });

    this.watcher.on("unlink", (absPath: string) => {
      const relPath = relative(this.projectRoot, absPath);
      this.emit("file-deleted", relPath);
    });

    this.watcher.on("error", (err: Error) => {
      this.emit("error", err);
    });

    // Start periodic token cleanup
    this.cleanupTimer = setInterval(() => {
      this.writeRegistry.cleanup();
    }, WRITE_TOKEN_TTL_MS);
  }

  /**
   * Handle a file add/change event.
   */
  private async handleFileEvent(
    type: "created" | "changed",
    absPath: string,
  ): Promise<void> {
    const relPath = relative(this.projectRoot, absPath);

    try {
      // Check file stats first
      const fileStat = await stat(absPath);

      // Check if file should be synced
      const syncResult = shouldSync(relPath, fileStat.size, undefined, this.filter);
      if (!syncResult.sync) return;

      // Read file content
      const content = await readFile(absPath, "utf-8");

      // Write-loop suppression check
      const hash = this.computeHash(content);
      if (this.writeRegistry.checkAndConsume(relPath, hash)) {
        return; // Suppressed — this was our own write
      }

      // Emit the appropriate event
      if (type === "created") {
        this.emit("file-created", relPath, content);
      } else {
        this.emit("file-changed", relPath, content);
      }
    } catch (err) {
      // File may have been deleted between event and read
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Stop watching and clean up.
   */
  async stop(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }

    this.removeAllListeners();
  }
}
