import { mkdir, readFile, writeFile, readdir, unlink } from "node:fs/promises";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { MFLOW_CRDT_DIR, MFLOW_MANIFEST_FILE } from "../../shared/src/index.js";
import type { ICRDTPersistence } from "./crdt.js";

// ─── CRDTPersistence ────────────────────────────────────────

/**
 * Persists Y.Doc state to `.mflow/crdt/` as binary files.
 *
 * File naming: `<sha256-of-path>.ystate`
 * Manifest stored separately as JSON.
 */
export class CRDTPersistence implements ICRDTPersistence {
  private readonly crdtDir: string;
  private readonly manifestPath: string;
  private initialized = false;

  constructor(projectRoot: string) {
    this.crdtDir = join(projectRoot, MFLOW_CRDT_DIR);
    this.manifestPath = join(projectRoot, MFLOW_MANIFEST_FILE);
  }

  /**
   * Ensure the CRDT storage directory exists.
   */
  private async ensureDir(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.crdtDir, { recursive: true });
    this.initialized = true;
  }

  /**
   * Derive a stable filename from a file path.
   */
  private stateFileName(path: string): string {
    const hash = createHash("sha256").update(path).digest("hex").slice(0, 16);
    return `${hash}.ystate`;
  }

  // ─── Y.Doc Persistence ────────────────────────────────────

  /**
   * Save a Y.Doc's encoded state to disk.
   */
  async saveDoc(path: string, state: Uint8Array): Promise<void> {
    await this.ensureDir();
    const filePath = join(this.crdtDir, this.stateFileName(path));
    await writeFile(filePath, state);
  }

  /**
   * Load a Y.Doc's persisted state from disk.
   * Returns null if no persisted state exists.
   */
  async loadDoc(path: string): Promise<Uint8Array | null> {
    await this.ensureDir();
    const filePath = join(this.crdtDir, this.stateFileName(path));

    try {
      const data = await readFile(filePath);
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  /**
   * Remove persisted state for a file.
   */
  async removeDoc(path: string): Promise<void> {
    const filePath = join(this.crdtDir, this.stateFileName(path));
    try {
      await unlink(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  // ─── Manifest Persistence ─────────────────────────────────

  /**
   * Save the manifest state (Y.Doc encoded) to disk.
   */
  async saveManifest(state: Uint8Array): Promise<void> {
    await this.ensureDir();
    await writeFile(this.manifestPath, state);
  }

  /**
   * Load the manifest state from disk.
   * Returns null if no persisted manifest exists.
   */
  async loadManifest(): Promise<Uint8Array | null> {
    try {
      const data = await readFile(this.manifestPath);
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  // ─── Cleanup ──────────────────────────────────────────────

  /**
   * List all persisted .ystate files.
   */
  async listPersistedFiles(): Promise<string[]> {
    await this.ensureDir();
    try {
      const entries = await readdir(this.crdtDir);
      return entries.filter((e) => e.endsWith(".ystate"));
    } catch {
      return [];
    }
  }

  /**
   * Remove all persisted CRDT state (for reset).
   */
  async clearAll(): Promise<void> {
    const files = await this.listPersistedFiles();
    await Promise.all(
      files.map((f) => unlink(join(this.crdtDir, f)).catch(() => {})),
    );
    try {
      await unlink(this.manifestPath);
    } catch {
      // Ignore if not exists
    }
  }
}
