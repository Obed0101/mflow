import { EventEmitter } from "node:events";
import * as Y from "yjs";
import type { ManifestEntry } from "../../shared/src/index.js";
import { RENAME_DETECTION_WINDOW_MS } from "../../shared/src/index.js";

// ─── Types ──────────────────────────────────────────────────

export interface ManifestEvents {
  "file-added": (path: string, entry: ManifestEntry) => void;
  "file-removed": (path: string) => void;
  "file-renamed": (oldPath: string, newPath: string) => void;
  "manifest-update": (update: Uint8Array) => void;
}

interface PendingDelete {
  path: string;
  hash: string;
  timer: ReturnType<typeof setTimeout>;
}

// ─── ManifestManager ────────────────────────────────────────

/**
 * Manages the shared file manifest using a Y.Doc with a Y.Map.
 *
 * The manifest tracks all files in the project: existence, content hash,
 * mtime, and size. It's synced across all peers as a separate Y.Doc.
 *
 * Rename detection: watches for delete + create with matching content
 * hash within a 500ms window.
 */
export class ManifestManager extends EventEmitter {
  readonly doc: Y.Doc;
  private readonly map: Y.Map<ManifestEntry>;
  private readonly pendingDeletes = new Map<string, PendingDelete>();

  constructor() {
    super();
    this.doc = new Y.Doc();
    this.map = this.doc.getMap<ManifestEntry>("manifest");

    // Forward Y.Doc updates for sync
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === "local") {
        this.emit("manifest-update", update);
      }
    });
  }

  // ─── Read Operations ────────────────────────────────────

  /**
   * Get a manifest entry for a file path.
   */
  getEntry(path: string): ManifestEntry | undefined {
    return this.map.get(path);
  }

  /**
   * Get all manifest entries.
   */
  getAllEntries(): Map<string, ManifestEntry> {
    const result = new Map<string, ManifestEntry>();
    this.map.forEach((value, key) => {
      result.set(key, value);
    });
    return result;
  }

  /**
   * Get paths of all files that currently exist.
   */
  getExistingPaths(): string[] {
    const paths: string[] = [];
    this.map.forEach((entry, key) => {
      if (entry.exists) paths.push(key);
    });
    return paths;
  }

  /**
   * Get total count of existing files.
   */
  get fileCount(): number {
    let count = 0;
    this.map.forEach((entry) => {
      if (entry.exists) count++;
    });
    return count;
  }

  /**
   * Check if a file is already tracked in the manifest.
   */
  hasFile(path: string): boolean {
    const entry = this.map.get(path);
    return entry !== undefined && entry.exists;
  }

  // ─── Write Operations ───────────────────────────────────

  /**
   * Add or update a file in the manifest.
   */
  setFile(
    path: string,
    entry: ManifestEntry,
  ): void {
    // Check for rename: if this is a new file whose hash matches a recent delete
    if (entry.exists) {
      const rename = this.checkRename(path, entry.contentHash);
      if (rename) {
        // It's a rename — emit rename event and clean up
        this.doc.transact(() => {
          this.map.set(path, entry);
        }, "local");
        this.emit("file-renamed", rename, path);
        return;
      }
    }

    this.doc.transact(() => {
      this.map.set(path, entry);
    }, "local");

    if (entry.exists) {
      this.emit("file-added", path, entry);
    }
  }

  /**
   * Mark a file as deleted in the manifest.
   *
   * Uses a delayed window for rename detection: if a file with the same
   * content hash is created within 500ms, it's treated as a rename.
   */
  deleteFile(path: string): void {
    const existing = this.map.get(path);
    if (!existing) return;

    const hash = existing.contentHash;

    // Register pending delete for rename detection
    const pending: PendingDelete = {
      path,
      hash,
      timer: setTimeout(() => {
        // No rename detected within window — commit the delete
        this.pendingDeletes.delete(hash);
        this.doc.transact(() => {
          this.map.set(path, { ...existing, exists: false });
        }, "local");
        this.emit("file-removed", path);
      }, RENAME_DETECTION_WINDOW_MS),
    };

    this.pendingDeletes.set(hash, pending);
  }

  // ─── Remote Updates ─────────────────────────────────────

  /**
   * Apply a remote Y.js update to the manifest doc.
   */
  applyRemoteUpdate(update: Uint8Array): void {
    Y.applyUpdate(this.doc, update, "remote");
  }

  /**
   * Get the full manifest doc state for sync.
   */
  encodeState(): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc);
  }

  /**
   * Get the state vector for incremental sync.
   */
  encodeStateVector(): Uint8Array {
    return Y.encodeStateVector(this.doc);
  }

  /**
   * Restore manifest from persisted state.
   */
  restoreFromState(state: Uint8Array): void {
    Y.applyUpdate(this.doc, state);
  }

  // ─── Rename Detection ───────────────────────────────────

  /**
   * Check if a newly created file matches a recently deleted file
   * (same content hash within the rename detection window).
   *
   * @returns The old path if it's a rename, null otherwise.
   */
  private checkRename(newPath: string, hash: string): string | null {
    const pending = this.pendingDeletes.get(hash);
    if (!pending) return null;

    // Clear the pending delete timer
    clearTimeout(pending.timer);
    this.pendingDeletes.delete(hash);

    // Mark the old path as deleted
    const oldEntry = this.map.get(pending.path);
    if (oldEntry) {
      this.doc.transact(() => {
        this.map.set(pending.path, { ...oldEntry, exists: false });
      }, "local");
    }

    return pending.path;
  }

  // ─── Lifecycle ──────────────────────────────────────────

  /**
   * Clean up all pending timers and destroy the doc.
   */
  dispose(): void {
    for (const pending of this.pendingDeletes.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingDeletes.clear();
    this.doc.destroy();
    this.removeAllListeners();
  }
}
