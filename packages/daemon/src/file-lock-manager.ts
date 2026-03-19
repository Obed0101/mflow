import { EventEmitter } from "node:events";
import type { FileLock, LockResponse } from "@mflow/shared";
import {
  DEFAULT_LEASE_MS,
  MAX_LEASE_MS,
  MAX_LOCKS,
  LOCK_EXPIRY_CHECK_MS,
} from "@mflow/shared";

// ─── Types ──────────────────────────────────────────────────

export interface FileLockManagerEvents {
  "lock-acquired": (lock: FileLock) => void;
  "lock-released": (path: string, holderId: string) => void;
  "lock-expired": (lock: FileLock) => void;
}

// ─── FileLockManager ────────────────────────────────────────

/**
 * Manages file-level locks for Layer 2 collision prevention.
 *
 * Locks are opt-in (acquired via MCP tools or CLI) and enforce
 * propagation gating: while a file is locked by peer A, peer B's
 * local updates for that file are queued instead of propagated.
 *
 * Locks have a lease duration and auto-expire if not renewed.
 */
export class FileLockManager extends EventEmitter {
  private readonly locks = new Map<string, FileLock>();
  private tokenCounter = 0;
  private expiryTimer: ReturnType<typeof setInterval> | null = null;

  // ─── Acquire ────────────────────────────────────────────

  /**
   * Attempt to acquire a lock on a file path.
   *
   * - If unlocked: grants the lock with a new fencing token.
   * - If locked by same peer: renews the lease (new token + expiry).
   * - If locked by different peer: returns denied with current lock info.
   */
  acquire(
    path: string,
    holderId: string,
    holderName: string,
    leaseDurationMs?: number,
  ): LockResponse {
    const existing = this.locks.get(path);

    // Check max locks (only for new locks, not renewals)
    if (!existing && this.locks.size >= MAX_LOCKS) {
      // Return a synthetic denied response — no lock to return
      // Use a placeholder to signal max locks reached
      throw new Error("Max locks reached");
    }

    // Cap lease duration
    const lease = Math.min(leaseDurationMs ?? DEFAULT_LEASE_MS, MAX_LEASE_MS);
    const now = Date.now();

    if (existing && existing.holderId !== holderId) {
      // Locked by another peer — check if expired
      if (now >= existing.expiresAt) {
        // Expired — clean up and allow acquisition
        this.releaseLock(path, existing);
      } else {
        return { granted: false, lock: existing };
      }
    }

    // Grant or renew
    const lock: FileLock = {
      path,
      holderId,
      holderName,
      token: ++this.tokenCounter,
      acquiredAt: existing?.holderId === holderId ? existing.acquiredAt : now,
      expiresAt: now + lease,
      leaseDurationMs: lease,
    };

    this.locks.set(path, lock);
    this.emit("lock-acquired", lock);

    return { granted: true, lock };
  }

  // ─── Release ────────────────────────────────────────────

  /**
   * Release a lock. Only the lock holder can release unless force=true.
   *
   * @param path File path to unlock
   * @param callerId peerId of the caller
   * @param force If true, releases regardless of holder (admin override)
   * @returns true if released, false if not the holder
   */
  release(path: string, callerId: string, force = false): boolean {
    const lock = this.locks.get(path);
    if (!lock) return true; // Already unlocked

    if (!force && lock.holderId !== callerId) {
      return false;
    }

    this.releaseLock(path, lock);
    return true;
  }

  private releaseLock(path: string, lock: FileLock): void {
    this.locks.delete(path);
    this.emit("lock-released", path, lock.holderId);
  }

  // ─── Query ──────────────────────────────────────────────

  /**
   * Check if a file is locked by a peer other than the given one.
   */
  isLockedByOther(path: string, peerId: string): boolean {
    const lock = this.locks.get(path);
    if (!lock) return false;
    if (Date.now() >= lock.expiresAt) {
      this.releaseLock(path, lock);
      return false;
    }
    return lock.holderId !== peerId;
  }

  /**
   * Get the lock for a specific file, or undefined if unlocked.
   */
  getLock(path: string): FileLock | undefined {
    const lock = this.locks.get(path);
    if (lock && Date.now() >= lock.expiresAt) {
      this.releaseLock(path, lock);
      return undefined;
    }
    return lock;
  }

  /**
   * Get all active (non-expired) locks.
   */
  getAll(): FileLock[] {
    const now = Date.now();
    const result: FileLock[] = [];
    for (const [path, lock] of this.locks) {
      if (now >= lock.expiresAt) {
        this.releaseLock(path, lock);
      } else {
        result.push(lock);
      }
    }
    return result;
  }

  // ─── Expiry ─────────────────────────────────────────────

  /**
   * Start periodic expired lock cleanup.
   */
  startExpiryCheck(): void {
    if (this.expiryTimer) return;
    this.expiryTimer = setInterval(() => {
      this.cleanExpired();
    }, LOCK_EXPIRY_CHECK_MS);
  }

  /**
   * Stop periodic expiry checking.
   */
  stopExpiryCheck(): void {
    if (this.expiryTimer) {
      clearInterval(this.expiryTimer);
      this.expiryTimer = null;
    }
  }

  private cleanExpired(): void {
    const now = Date.now();
    for (const [path, lock] of this.locks) {
      if (now >= lock.expiresAt) {
        this.emit("lock-expired", lock);
        this.releaseLock(path, lock);
      }
    }
  }

  // ─── Lifecycle ──────────────────────────────────────────

  dispose(): void {
    this.stopExpiryCheck();
    this.locks.clear();
    this.removeAllListeners();
  }
}
