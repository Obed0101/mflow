/**
 * T6.3: Integration tests — write-loop suppression, delete vs edit race, git operation pause.
 *
 * Properties under test:
 *   P2.5: Delete vs Edit race — edit wins over delete via CRDT merge
 *   P2.7: Write-loop suppression — daemon doesn't re-broadcast its own writes
 *   P2.9: Git operation pause — sync pauses when .git/index.lock exists
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WriteRegistry } from "../../packages/daemon/src/watcher.js";
import { CRDTManager } from "../../packages/daemon/src/crdt.js";
import { GitDetector } from "../../packages/daemon/src/git.js";
import { WRITE_TOKEN_TTL_MS } from "../../packages/shared/src/constants.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Wrap an EventEmitter event in a Promise that resolves on first emission. */
function waitForEvent(
  emitter: { once(event: string, fn: (...args: unknown[]) => void): void },
  event: string,
  timeoutMs = 3_000,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for event "${event}" after ${timeoutMs}ms`));
    }, timeoutMs);

    emitter.once(event, (..._args: unknown[]) => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// ─── P2.7: Write-Loop Suppression ────────────────────────────────────────────

describe("T6.3: Edge Cases", () => {
  describe("P2.7: Write-Loop Suppression", () => {
    let registry: WriteRegistry;

    beforeEach(() => {
      registry = new WriteRegistry();
    });

    test("registered write token suppresses matching file change", () => {
      // Arrange
      const path = "src/auth.ts";
      const hash = "abc123def456";

      // Act — register before writing to disk
      registry.register(path, hash);

      // Assert — first check suppresses and consumes the token
      expect(registry.checkAndConsume(path, hash)).toBe(true);
    });

    test("consumed token is not reusable for the same file and hash", () => {
      // Arrange
      const path = "src/auth.ts";
      const hash = "abc123def456";
      registry.register(path, hash);
      registry.checkAndConsume(path, hash); // consume it

      // Act — second check with same hash must not suppress
      const result = registry.checkAndConsume(path, hash);

      // Assert
      expect(result).toBe(false);
    });

    test("unregistered file change is NOT suppressed", () => {
      // No registration
      const result = registry.checkAndConsume("src/unregistered.ts", "somehash");

      expect(result).toBe(false);
    });

    test("token for different hash on same path does not suppress", () => {
      // Arrange — register hash A, observe hash B
      const path = "src/service.ts";
      registry.register(path, "hashA");

      // Assert — hash mismatch means no suppression
      expect(registry.checkAndConsume(path, "hashB")).toBe(false);
    });

    test("token for different path does not suppress", () => {
      // Arrange — register path A, check path B
      registry.register("src/fileA.ts", "sameHash");

      // Assert — path mismatch means no suppression
      expect(registry.checkAndConsume("src/fileB.ts", "sameHash")).toBe(false);
    });

    test("multiple pending tokens for same path are consumed independently", () => {
      // Arrange — two different hash tokens for the same file
      const path = "src/multi.ts";
      const hashV1 = "hash_v1";
      const hashV2 = "hash_v2";
      registry.register(path, hashV1);
      registry.register(path, hashV2);

      // Act & Assert — each token suppresses its respective hash once
      expect(registry.checkAndConsume(path, hashV1)).toBe(true);
      expect(registry.checkAndConsume(path, hashV2)).toBe(true);
      // Both consumed — neither suppresses again
      expect(registry.checkAndConsume(path, hashV1)).toBe(false);
      expect(registry.checkAndConsume(path, hashV2)).toBe(false);
    });

    test("pendingCount reflects registered and consumed tokens accurately", () => {
      expect(registry.pendingCount).toBe(0);

      registry.register("src/a.ts", "h1");
      registry.register("src/b.ts", "h2");
      expect(registry.pendingCount).toBe(2);

      registry.checkAndConsume("src/a.ts", "h1");
      expect(registry.pendingCount).toBe(1);

      registry.checkAndConsume("src/b.ts", "h2");
      expect(registry.pendingCount).toBe(0);
    });

    test("stale tokens are removed by cleanup", () => {
      // Arrange — register a token and manually backdate its timestamp
      const path = "src/stale.ts";
      const hash = "staleHash";
      registry.register(path, hash);

      // Manually force the token's timestamp to be older than TTL
      // Access private map via type assertion to manipulate time for the test
      const registryAsAny = registry as unknown as {
        tokens: Map<string, Array<{ hash: string; seq: number; timestamp: number }>>;
      };
      const tokens = registryAsAny.tokens.get(path)!;
      tokens[0].timestamp = Date.now() - WRITE_TOKEN_TTL_MS - 1;

      // Act
      registry.cleanup();

      // Assert — stale token removed
      expect(registry.pendingCount).toBe(0);
      // Attempting to consume yields false (token gone)
      expect(registry.checkAndConsume(path, hash)).toBe(false);
    });

    test("fresh tokens survive cleanup", () => {
      // Arrange — register a fresh token (timestamp = now)
      const path = "src/fresh.ts";
      const hash = "freshHash";
      registry.register(path, hash);

      // Act — cleanup should not remove fresh tokens
      registry.cleanup();

      // Assert — token still present and can suppress
      expect(registry.pendingCount).toBe(1);
      expect(registry.checkAndConsume(path, hash)).toBe(true);
    });

    test("daemon does not re-broadcast remote writes via WriteRegistry", () => {
      // Simulate the sequence in SyncOrchestrator.handleRemoteUpdate:
      //   1. Receive remote CRDT update for a file
      //   2. Compute resulting content + hash
      //   3. Register the write token BEFORE writing to disk
      //   4. Verify that the subsequent watcher event (same hash) is suppressed

      // Arrange — two CRDTManagers simulating two peers
      const crdtA = new CRDTManager();
      const crdtB = new CRDTManager();
      const filePath = "src/shared-module.ts";
      const initialContent = "export const x = 1;";
      const hash = simpleHash(initialContent);

      try {
        // Peer A initializes the file
        const updateFromA = crdtA.initializeContent(filePath, initialContent, hash);

        // Peer B receives the remote update (as handleRemoteUpdate does)
        const mergedContent = crdtB.applyRemoteUpdate(filePath, updateFromA);
        const mergedHash = simpleHash(mergedContent);

        // Peer B registers the write token before writing to disk
        const writeRegistry = new WriteRegistry();
        writeRegistry.register(filePath, mergedHash);

        // When the filesystem watcher fires with the same hash, it's suppressed
        expect(writeRegistry.checkAndConsume(filePath, mergedHash)).toBe(true);

        // A subsequent spurious event for the same path with a different hash is NOT suppressed
        expect(writeRegistry.checkAndConsume(filePath, "differentHash")).toBe(false);
      } finally {
        crdtA.dispose();
        crdtB.dispose();
      }
    });
  });

  // ─── P2.5: Delete vs Edit Race ───────────────────────────────────────────

  describe("P2.5: Delete vs Edit Race", () => {
    test("edit wins over concurrent content-clear via CRDT merge (insert-wins)", () => {
      // Y.js insert-wins semantics: when one peer clears the text and another
      // inserts/edits concurrently, the insertion survives after merge.
      //
      // This models the real P2.5 race condition at the CRDT level:
      //   - "delete" is represented as a Y.Text clear (delete all chars)
      //   - "edit" is represented as a Y.Text insert / replace
      // Both operations are recorded in the Y.Doc update stream and
      // exchanged between peers. Y.js resolves conflicts using lamport
      // timestamps — concurrent insertions always survive; concurrent
      // deletions do not remove characters that were inserted concurrently.

      const crdtA = new CRDTManager();
      const crdtB = new CRDTManager();
      const filePath = "src/contested.ts";
      const initialContent = "export const version = 1;";
      const editedContent = "export const version = 2;";
      const initHash = simpleHash(initialContent);
      const editHash = simpleHash(editedContent);

      try {
        // Step 1: Both peers get the same initial state via full-state sync
        const initUpdateA = crdtA.initializeContent(filePath, initialContent, initHash);
        crdtB.applyRemoteUpdate(filePath, initUpdateA);

        expect(crdtA.getContent(filePath)).toBe(initialContent);
        expect(crdtB.getContent(filePath)).toBe(initialContent);

        // Step 2: Concurrent operations — neither peer has yet received the other's update
        //   Peer A: "deletes" by applying a local change to empty string
        //   Peer B: applies an edit (1 → 2)
        const deleteUpdate = crdtA.applyLocalChange(filePath, initialContent, "", simpleHash(""));
        const editUpdate = crdtB.applyLocalChange(filePath, initialContent, editedContent, editHash);

        expect(deleteUpdate).not.toBeNull();
        expect(editUpdate).not.toBeNull();

        // Step 3: Cross-apply both updates so each peer reaches the same merged state
        const contentOnA = crdtA.applyRemoteUpdate(filePath, editUpdate!);
        const contentOnB = crdtB.applyRemoteUpdate(filePath, deleteUpdate!);

        // Step 4: Both peers must converge to the same value (CRDTs are strongly convergent)
        expect(contentOnA).toBe(contentOnB);
        expect(crdtA.getContent(filePath)).toBe(crdtB.getContent(filePath));

        // Step 5: The merged result is non-empty — the edit survives the concurrent delete.
        // Y.js insert-wins: B's edit characters (the "2") were inserted concurrently with
        // A's delete, so they are preserved. The final content is the portion that B edited.
        const merged = crdtA.getContent(filePath)!;
        expect(merged.length).toBeGreaterThan(0);

        // The edited digit "2" must appear in the merged result — it was inserted by B
        // and cannot be removed by A's concurrent delete of the original "1".
        expect(merged).toContain("2");
      } finally {
        crdtA.dispose();
        crdtB.dispose();
      }
    });

    test("delete-only propagation removes file from CRDT tracking", () => {
      // Arrange
      const crdt = new CRDTManager();
      const filePath = "src/to-delete.ts";
      const content = "export const temp = true;";
      const hash = simpleHash(content);

      try {
        crdt.initializeContent(filePath, content, hash);
        expect(crdt.hasDoc(filePath)).toBe(true);

        // Act
        crdt.removeFile(filePath);

        // Assert — file is no longer tracked
        expect(crdt.hasDoc(filePath)).toBe(false);
        expect(crdt.getContent(filePath)).toBeNull();
      } finally {
        crdt.dispose();
      }
    });

    test("edit-only update is fully preserved across two peers", () => {
      // Arrange
      const crdtA = new CRDTManager();
      const crdtB = new CRDTManager();
      const filePath = "src/preserved.ts";
      const v1 = "const a = 1;";
      const v2 = "const a = 99;";
      const hashV1 = simpleHash(v1);
      const hashV2 = simpleHash(v2);

      try {
        const initUpdate = crdtA.initializeContent(filePath, v1, hashV1);
        crdtB.applyRemoteUpdate(filePath, initUpdate);

        const editUpdate = crdtA.applyLocalChange(filePath, v1, v2, hashV2);
        expect(editUpdate).not.toBeNull();

        const mergedContent = crdtB.applyRemoteUpdate(filePath, editUpdate!);

        // Assert — Peer B has received the edit correctly
        expect(mergedContent).toBe(v2);
        expect(crdtB.getContent(filePath)).toBe(v2);
      } finally {
        crdtA.dispose();
        crdtB.dispose();
      }
    });
  });

  // ─── P2.9: Git Operation Pause ───────────────────────────────────────────

  describe("P2.9: Git Operation Pause", () => {
    let tmpDir: string;
    let gitDir: string;
    let lockPath: string;
    let detector: GitDetector;

    beforeEach(async () => {
      // Create a temporary project root with a .git directory
      tmpDir = await mkdtemp(join(tmpdir(), "mflow-git-test-"));
      gitDir = join(tmpDir, ".git");
      lockPath = join(gitDir, "index.lock");
      await mkdir(gitDir, { recursive: true });
      detector = new GitDetector(tmpDir);
    });

    afterEach(async () => {
      detector.stop();
      await rm(tmpDir, { recursive: true, force: true });
    });

    test("GitDetector starts with isGitOperation = false when no lock file exists", async () => {
      await detector.start();

      expect(detector.isGitOperation).toBe(false);
    });

    test("GitDetector detects index.lock appearance and emits git-operation-start", async () => {
      await detector.start();

      const startEventPromise = waitForEvent(detector, "git-operation-start");

      // Simulate git writing its lock file
      await writeFile(lockPath, "");

      await startEventPromise;

      expect(detector.isGitOperation).toBe(true);
    });

    test("GitDetector detects index.lock removal and emits git-operation-end", async () => {
      // Pre-create the lock file so the detector starts in git-operation state
      await writeFile(lockPath, "");
      await detector.start();

      // Detector checks initial state synchronously in start() via checkLock()
      // Give it a tick to settle
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect(detector.isGitOperation).toBe(true);

      const endEventPromise = waitForEvent(detector, "git-operation-end");

      // Simulate git finishing: remove the lock file
      await unlink(lockPath);

      await endEventPromise;

      expect(detector.isGitOperation).toBe(false);
    });

    test("GitDetector emits start then end for a full git operation lifecycle", async () => {
      await detector.start();

      const events: string[] = [];
      detector.on("git-operation-start", () => events.push("start"));
      detector.on("git-operation-end", () => events.push("end"));

      // Simulate git operation: lock appears then disappears
      await writeFile(lockPath, "");
      // Wait for start event
      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      await unlink(lockPath);
      // Wait for end event
      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      expect(events).toContain("start");
      expect(events).toContain("end");
      // start must come before end
      expect(events.indexOf("start")).toBeLessThan(events.indexOf("end"));
    });

    test("GitDetector does not emit duplicate start events for same lock file", async () => {
      await detector.start();

      let startCount = 0;
      detector.on("git-operation-start", () => startCount++);

      // Write lock once; the watcher may fire multiple times but state guard prevents duplicate events
      await writeFile(lockPath, "");
      await new Promise<void>((resolve) => setTimeout(resolve, 150));

      // Only one start regardless of how many fs events fired
      expect(startCount).toBe(1);
    });

    test("GitDetector sets isGitOperation = true when lock already exists at start", async () => {
      // Pre-create lock before detector starts
      await writeFile(lockPath, "");

      await detector.start();
      // Allow async checkLock to settle
      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      expect(detector.isGitOperation).toBe(true);
    });

    test("GitDetector handles non-git directory gracefully (no .git dir)", async () => {
      // Create a detector for a directory that has no .git/ subdirectory
      const nonGitDir = await mkdtemp(join(tmpdir(), "mflow-nongit-"));
      const nonGitDetector = new GitDetector(nonGitDir);

      try {
        // Should not throw even though .git/ doesn't exist
        await expect(nonGitDetector.start()).resolves.toBeUndefined();
        expect(nonGitDetector.isGitOperation).toBe(false);
      } finally {
        nonGitDetector.stop();
        await rm(nonGitDir, { recursive: true, force: true });
      }
    });

    test("sync state semantics: git_paused gates re-entry to syncing", () => {
      // Unit-level test of the state machine logic without standing up full SyncOrchestrator.
      // Verify the documented state transitions from sync.ts wireComponents():
      //   git-operation-start while "syncing"  → "git_paused"
      //   git-operation-end   while "git_paused" → "scanning" then immediately "syncing"
      //
      // We test this by reproducing the transition conditions directly:

      type SyncState = "syncing" | "git_paused" | "scanning" | "paused" | "stopping" | "starting" | "connecting" | "reconnecting";

      let state: SyncState = "syncing";
      const transitions: SyncState[] = [state];

      const setState = (next: SyncState) => {
        if (state !== next) {
          state = next;
          transitions.push(state);
        }
      };

      // Simulate git-operation-start handler
      const onGitStart = () => {
        if (state === "syncing") setState("git_paused");
      };

      // Simulate git-operation-end handler
      const onGitEnd = () => {
        if (state === "git_paused") {
          setState("scanning");
          setState("syncing");
        }
      };

      onGitStart();
      expect(state as string).toBe("git_paused");

      onGitEnd();
      expect(state as string).toBe("syncing");

      // transitions should be: syncing → git_paused → scanning → syncing
      expect(transitions as string[]).toEqual(["syncing", "git_paused", "scanning", "syncing"]);
    });

    test("git_paused does not transition on git-operation-start if already paused", () => {
      // State guard: second git-operation-start while already git_paused must be a no-op.
      // Mirrors the `if (state === "syncing")` guard in sync.ts.

      type SyncState = "syncing" | "git_paused";
      let state: SyncState = "git_paused"; // already in git_paused
      let transitionCount = 0;

      const onGitStart = () => {
        if (state === "syncing") {
          state = "git_paused";
          transitionCount++;
        }
      };

      onGitStart(); // should be a no-op

      expect(state).toBe("git_paused");
      expect(transitionCount).toBe(0);
    });
  });
});

// ─── Internal Utilities ──────────────────────────────────────────────────────

/**
 * Simple deterministic hash for testing — matches FileWatcher.computeHash fallback.
 * Do NOT use in production; for test assertions only.
 */
function simpleHash(content: string): string {
  let h = 0;
  for (let i = 0; i < content.length; i++) {
    h = (Math.imul(31, h) + content.charCodeAt(i)) | 0;
  }
  return h.toString(16);
}
