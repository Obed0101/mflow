import { EventEmitter } from "node:events";
import { join } from "node:path";
import { watch, type FSWatcher } from "node:fs";
import { access } from "node:fs/promises";

// ─── Types ──────────────────────────────────────────────────

export interface GitDetectorEvents {
  "git-operation-start": () => void;
  "git-operation-end": () => void;
}

// ─── GitDetector ────────────────────────────────────────────

/**
 * Watches for `.git/index.lock` to detect active git operations.
 *
 * When a git operation starts (lock file appears), emits "git-operation-start".
 * When it ends (lock file removed), emits "git-operation-end".
 *
 * The sync engine should pause during git operations and re-scan after.
 */
export class GitDetector extends EventEmitter {
  private readonly gitDir: string;
  private readonly lockPath: string;
  private fsWatcher: FSWatcher | null = null;
  private _isGitOperation = false;

  constructor(projectRoot: string) {
    super();
    this.gitDir = join(projectRoot, ".git");
    this.lockPath = join(this.gitDir, "index.lock");
  }

  /**
   * Whether a git operation is currently in progress.
   */
  get isGitOperation(): boolean {
    return this._isGitOperation;
  }

  /**
   * Start watching for git lock file changes.
   */
  async start(): Promise<void> {
    if (this.fsWatcher) return;

    // Check initial state
    await this.checkLock();

    // Watch the .git directory for changes
    try {
      this.fsWatcher = watch(this.gitDir, (eventType, filename) => {
        if (filename === "index.lock") {
          void this.checkLock();
        }
      });

      this.fsWatcher.on("error", () => {
        // .git directory might not exist — that's fine
      });
    } catch {
      // .git directory doesn't exist — not a git repo, nothing to watch
    }
  }

  /**
   * Check if the lock file currently exists and update state.
   */
  private async checkLock(): Promise<void> {
    const exists = await fileExists(this.lockPath);

    if (exists && !this._isGitOperation) {
      this._isGitOperation = true;
      this.emit("git-operation-start");
    } else if (!exists && this._isGitOperation) {
      this._isGitOperation = false;
      this.emit("git-operation-end");
    }
  }

  /**
   * Stop watching.
   */
  stop(): void {
    if (this.fsWatcher) {
      this.fsWatcher.close();
      this.fsWatcher = null;
    }
    this.removeAllListeners();
  }
}

// ─── Helpers ────────────────────────────────────────────────

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
