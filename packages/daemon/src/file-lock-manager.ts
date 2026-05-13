import { EventEmitter } from "node:events";
import type { FileLock, FileLockWaiter, LockRequestOptions, LockResponse } from "../../shared/src/index.js";
import {
  DEFAULT_LOCK_WAIT_TIMEOUT_MS,
  DEFAULT_LEASE_MS,
  MAX_LOCK_PRIORITY,
  MAX_LEASE_MS,
  MAX_LOCKS,
  MAX_LOCK_WAIT_TIMEOUT_MS,
  MAX_LOCK_WAITERS,
  MIN_LOCK_PRIORITY,
  LOCK_EXPIRY_CHECK_MS,
} from "../../shared/src/index.js";

// ─── Types ──────────────────────────────────────────────────

export interface FileLockManagerEvents {
  "lock-acquired": (lock: FileLock) => void;
  "lock-released": (path: string, holderId: string) => void;
  "lock-expired": (lock: FileLock) => void;
  "lock-waiter-queued": (waiter: FileLockWaiter) => void;
  "lock-waiter-timeout": (waiter: FileLockWaiter) => void;
  "lock-waiter-cancelled": (waiter: FileLockWaiter) => void;
}

interface WaiterRecord {
  waiter: FileLockWaiter;
  leaseDurationMs?: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (response: LockResponse) => void;
  reject: (error: Error) => void;
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
  private readonly waitQueues = new Map<string, WaiterRecord[]>();
  private tokenCounter = 0;
  private waiterCounter = 0;
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
        const next = this.locks.get(path);
        if (next && next.holderId !== holderId) {
          return { granted: false, lock: next };
        }
      } else {
        return { granted: false, lock: existing };
      }
    }

    const conflicting = this.getConflictingLock(path, holderId);
    if (conflicting) {
      return { granted: false, lock: conflicting };
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

  /**
   * Acquire a lock, optionally waiting in a priority/FIFO queue.
   */
  acquireQueued(
    path: string,
    holderId: string,
    holderName: string,
    options: LockRequestOptions = {},
  ): Promise<LockResponse> {
    const immediate = this.acquire(path, holderId, holderName, options.leaseDurationMs);
    if (immediate.granted || !options.wait) {
      return Promise.resolve(immediate);
    }

    const totalWaiters = Array.from(this.waitQueues.values()).reduce((sum, queue) => sum + queue.length, 0);
    if (totalWaiters >= MAX_LOCK_WAITERS) {
      return Promise.reject(new Error("Max lock waiters reached"));
    }

    const timeoutMs = Math.min(
      options.timeoutMs ?? DEFAULT_LOCK_WAIT_TIMEOUT_MS,
      MAX_LOCK_WAIT_TIMEOUT_MS,
    );
    const priority = clampPriority(options.priority);
    const waiter: FileLockWaiter = {
      path,
      waiterId: `waiter-${String(++this.waiterCounter).padStart(10, "0")}`,
      holderId,
      holderName,
      priority,
      requestedAt: Date.now(),
      expiresAt: Date.now() + timeoutMs,
    };

    return new Promise<LockResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeWaiter(path, waiter.waiterId, "timeout");
        reject(new Error(`Timed out waiting for lock on ${path}`));
      }, timeoutMs);

      const record: WaiterRecord = {
        waiter,
        leaseDurationMs: options.leaseDurationMs,
        timer,
        resolve,
        reject,
      };

      const queue = this.waitQueues.get(path) ?? [];
      queue.push(record);
      queue.sort(compareWaiters);
      this.waitQueues.set(path, queue);
      this.emit("lock-waiter-queued", waiter);
    });
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
    this.grantEligibleWaiters();
  }

  // ─── Query ──────────────────────────────────────────────

  /**
   * Check if a file is locked by a peer other than the given one.
   */
  isLockedByOther(path: string, peerId: string): boolean {
    const lock = this.getConflictingLock(path, peerId);
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
    const lock = this.locks.get(path) ?? this.getConflictingLock(path);
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

  /**
   * Get active waiters, optionally for a specific file.
   */
  getWaiters(path?: string): FileLockWaiter[] {
    if (path) {
      return (this.waitQueues.get(path) ?? []).map((record) => record.waiter);
    }

    return Array.from(this.waitQueues.values())
      .flat()
      .map((record) => record.waiter)
      .sort(compareWaiterSnapshots);
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

  private grantEligibleWaiters(): void {
    let progressed = true;
    while (progressed) {
      progressed = false;
      const candidates = Array.from(this.waitQueues.values())
        .map((queue) => queue[0])
        .filter((record): record is WaiterRecord => Boolean(record))
        .sort(compareWaiters);

      for (const record of candidates) {
        if (this.getConflictingLock(record.waiter.path, record.waiter.holderId)) continue;
        this.shiftWaiter(record.waiter.path, record.waiter.waiterId);
        clearTimeout(record.timer);
        const response = this.acquire(
          record.waiter.path,
          record.waiter.holderId,
          record.waiter.holderName,
          record.leaseDurationMs,
        );
        record.resolve(response);
        progressed = true;
      }
    }
  }

  private removeWaiter(path: string, waiterId: string, reason: "timeout" | "cancelled"): void {
    const queue = this.waitQueues.get(path);
    if (!queue) return;

    const index = queue.findIndex((record) => record.waiter.waiterId === waiterId);
    if (index === -1) return;

    const [record] = queue.splice(index, 1);
    clearTimeout(record.timer);
    if (queue.length === 0) {
      this.waitQueues.delete(path);
    }

    this.emit(reason === "timeout" ? "lock-waiter-timeout" : "lock-waiter-cancelled", record.waiter);
  }

  private shiftWaiter(path: string, waiterId: string): WaiterRecord | undefined {
    const queue = this.waitQueues.get(path);
    if (!queue) return undefined;
    const index = queue.findIndex((record) => record.waiter.waiterId === waiterId);
    if (index === -1) return undefined;
    const [record] = queue.splice(index, 1);
    if (queue.length === 0) this.waitQueues.delete(path);
    return record;
  }

  private getConflictingLock(path: string, holderId?: string): FileLock | undefined {
    const now = Date.now();
    for (const [lockPath, lock] of this.locks) {
      if (holderId && lock.holderId === holderId) continue;
      if (now >= lock.expiresAt) {
        this.releaseLock(lockPath, lock);
        continue;
      }
      if (pathsConflict(path, lock.path)) {
        return lock;
      }
    }
    return undefined;
  }

  // ─── Lifecycle ──────────────────────────────────────────

  dispose(): void {
    this.stopExpiryCheck();
    for (const queue of this.waitQueues.values()) {
      for (const record of queue) {
        clearTimeout(record.timer);
        record.reject(new Error("Lock manager disposed"));
      }
    }
    this.waitQueues.clear();
    this.locks.clear();
    this.removeAllListeners();
  }
}

function clampPriority(priority: number | undefined): number {
  if (priority === undefined) return MIN_LOCK_PRIORITY;
  return Math.min(MAX_LOCK_PRIORITY, Math.max(MIN_LOCK_PRIORITY, priority));
}

function compareWaiters(a: WaiterRecord, b: WaiterRecord): number {
  return compareWaiterSnapshots(a.waiter, b.waiter);
}

function compareWaiterSnapshots(a: FileLockWaiter, b: FileLockWaiter): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.requestedAt !== b.requestedAt) return a.requestedAt - b.requestedAt;
  return a.waiterId.localeCompare(b.waiterId);
}

function pathsConflict(a: string, b: string): boolean {
  if (a === b) return true;
  const aScope = parseScope(a);
  const bScope = parseScope(b);
  if (aScope && bScope) return scopePrefixesOverlap(aScope, bScope);
  if (aScope) return globMatches(aScope, b);
  if (bScope) return globMatches(bScope, a);
  return false;
}

function parseScope(path: string): string | null {
  return path.startsWith("scope:") ? path.slice("scope:".length) : null;
}

function scopePrefixesOverlap(a: string, b: string): boolean {
  const aPrefix = staticGlobPrefix(a);
  const bPrefix = staticGlobPrefix(b);
  return aPrefix.startsWith(bPrefix) || bPrefix.startsWith(aPrefix);
}

function staticGlobPrefix(pattern: string): string {
  const wildcard = pattern.search(/[*?[]/);
  const prefix = wildcard === -1 ? pattern : pattern.slice(0, wildcard);
  const slash = prefix.lastIndexOf("/");
  return slash === -1 ? "" : prefix.slice(0, slash + 1);
}

function globMatches(pattern: string, path: string): boolean {
  let regex = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*" && pattern[i + 1] === "*") {
      regex += ".*";
      i++;
      continue;
    }
    if (char === "*") {
      regex += "[^/]*";
      continue;
    }
    if (char === "?") {
      regex += "[^/]";
      continue;
    }
    regex += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${regex}$`).test(path);
}
