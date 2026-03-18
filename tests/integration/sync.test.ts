/**
 * T6.1: Integration test — 2 daemons syncing files P2P
 *
 * Tests CRDT layer + SyncOrchestrator using an in-memory MockTransport.
 * No real WebRTC or signaling server required.
 *
 * Properties covered:
 * - P2.1: File sync between 2 peers within 500ms on LAN
 * - P2.3: File creation propagation
 * - P2.4: File deletion propagation
 * - P2.8: Minimal diffs (single line change produces minimal ops)
 * - P5.1: Sync latency p95 < 500ms
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ITransport,
  AwarenessData,
  PeerInfo,
  ConnectionState,
  MflowConfig,
} from "@mflow/shared";
import { CRDTManager } from "@mflow/daemon";
import { ManifestManager } from "@mflow/daemon";
import { SyncOrchestrator } from "@mflow/daemon";

// ─── MockTransport ────────────────────────────────────────────

/**
 * In-memory transport that connects two peers directly.
 * Simulates zero-latency LAN delivery for deterministic testing.
 */
class MockTransport implements ITransport {
  private connected = false;
  private peer: MockTransport | null = null;

  private updateCallbacks: Array<
    (fileId: string, update: Uint8Array, peerId: string) => void
  > = [];
  private awarenessCallbacks: Array<
    (peerId: string, data: AwarenessData) => void
  > = [];

  readonly peerId: string;
  private readonly peerName: string;

  constructor(peerId: string, peerName: string = peerId) {
    this.peerId = peerId;
    this.peerName = peerName;
  }

  /**
   * Link two MockTransports together so updates flow between them.
   */
  linkTo(other: MockTransport): void {
    this.peer = other;
    other.peer = this;
  }

  async connect(_roomId: string, _secret: string): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  sendUpdate(fileId: string, update: Uint8Array): void {
    if (!this.peer) return;
    // Deliver to linked peer's callbacks synchronously (simulates in-process LAN)
    const peerId = this.peerId;
    for (const cb of this.peer.updateCallbacks) {
      cb(fileId, update, peerId);
    }
  }

  onUpdate(
    callback: (fileId: string, update: Uint8Array, peerId: string) => void
  ): void {
    this.updateCallbacks.push(callback);
  }

  sendAwareness(data: AwarenessData): void {
    if (!this.peer) return;
    const peerId = this.peerId;
    for (const cb of this.peer.awarenessCallbacks) {
      cb(peerId, data);
    }
  }

  onAwareness(
    callback: (peerId: string, data: AwarenessData) => void
  ): void {
    this.awarenessCallbacks.push(callback);
  }

  getPeers(): PeerInfo[] {
    if (!this.peer || !this.connected) return [];
    return [
      {
        peerId: this.peer.peerId,
        peerName: this.peer.peerName,
        peerType: "agent",
        joinedAt: Date.now(),
      },
    ];
  }

  getConnectionState(): ConnectionState {
    return this.connected ? "connected" : "disconnected";
  }
}

// ─── Helpers ─────────────────────────────────────────────────

function buildConfig(overrides: Partial<MflowConfig["sync"]> = {}): MflowConfig {
  return {
    daemon: { name: "test-daemon", type: "agent" },
    sync: {
      signaling: "ws://localhost:8787",
      room: "test-room",
      secret: "test-secret",
      debounce_ms: 50,
      max_file_size_bytes: 1_048_576,
      max_tracked_files: 5_000,
      unload_after_minutes: 5,
      ignore: { patterns: [] },
      ...overrides,
    },
    awareness: {
      broadcast_interval_ms: 5_000,
      share_current_file: true,
    },
    transport: {
      stun_servers: [],
      reconnect_max_delay_ms: 30_000,
    },
  };
}

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mflow-test-"));
  // Create .mflow/ and .git/ so daemon doesn't fail prerequisite checks
  await mkdir(join(dir, ".mflow"), { recursive: true });
  await mkdir(join(dir, ".mflow", "crdt"), { recursive: true });
  await mkdir(join(dir, ".git"), { recursive: true });
  // Create src/ so remote writes don't fail with ENOENT on parent dir
  await mkdir(join(dir, "src"), { recursive: true });
  return dir;
}

interface PeerSetup {
  dir: string;
  transport: MockTransport;
  orchestrator: SyncOrchestrator;
}

async function makePeer(
  peerId: string,
  transportA?: MockTransport
): Promise<PeerSetup> {
  const dir = await makeTempDir();
  const transport = new MockTransport(peerId, `peer-${peerId}`);

  const orchestrator = new SyncOrchestrator({
    projectRoot: dir,
    config: buildConfig(),
    transport,
    peerId,
  });

  return { dir, transport, orchestrator };
}

// ─── Test Suite ───────────────────────────────────────────────

describe("T6.1: P2P File Sync", () => {
  let peerA: PeerSetup;
  let peerB: PeerSetup;

  beforeEach(async () => {
    peerA = await makePeer("peer-a");
    peerB = await makePeer("peer-b");

    // Connect transports before starting orchestrators
    peerA.transport.linkTo(peerB.transport);
    await peerA.transport.connect("test-room", "test-secret");
    await peerB.transport.connect("test-room", "test-secret");

    await peerA.orchestrator.start();
    await peerB.orchestrator.start();
  });

  afterEach(async () => {
    await peerA.orchestrator.stop();
    await peerB.orchestrator.stop();

    await rm(peerA.dir, { recursive: true, force: true });
    await rm(peerB.dir, { recursive: true, force: true });
  });

  // ─── P2.1 + P5.1: File change propagates within 500ms ───────

  test("P2.1 — file change on peer A propagates to peer B within 500ms", async () => {
    const filePath = "src/hello.ts";
    const content = "export const hello = () => 'world';\n";

    const t0 = performance.now();

    // Initialize content on A and capture the update
    const update = peerA.orchestrator.crdt.initializeContent(
      filePath,
      content,
      "hash-hello"
    );

    expect(update.byteLength).toBeGreaterThan(0);

    // Directly deliver to B via transport (bypasses chokidar — tests CRDT layer)
    peerA.transport.sendUpdate(filePath, update);

    // B should now have the content applied
    const receivedContent = peerB.orchestrator.crdt.getContent(filePath);
    const latencyMs = performance.now() - t0;

    expect(receivedContent).toBe(content);
    expect(latencyMs).toBeLessThan(500);
  });

  // ─── P5.1: Latency p95 < 500ms ───────────────────────────────

  test("P5.1 — sync latency p95 < 500ms across 20 operations", async () => {
    const latencies: number[] = [];

    for (let i = 0; i < 20; i++) {
      const filePath = `src/file-${i}.ts`;
      const content = `export const value${i} = ${i};\n`;

      const t0 = performance.now();

      const update = peerA.orchestrator.crdt.initializeContent(
        filePath,
        content,
        `hash-${i}`
      );
      peerA.transport.sendUpdate(filePath, update);

      const receivedContent = peerB.orchestrator.crdt.getContent(filePath);
      const latencyMs = performance.now() - t0;

      expect(receivedContent).toBe(content);
      latencies.push(latencyMs);
    }

    // p95 = 95th percentile
    const sorted = [...latencies].sort((a, b) => a - b);
    const p95Index = Math.ceil(sorted.length * 0.95) - 1;
    const p95 = sorted[p95Index];

    expect(p95).toBeLessThan(500);
  });

  // ─── P2.3: New file creation propagates ──────────────────────

  test("P2.3 — new file creation propagates from A to B", async () => {
    const newFilePath = "src/newfile.ts";
    const newContent = "export const newValue = 42;\n";

    // A creates a new file: initialize CRDT content
    const update = peerA.orchestrator.crdt.initializeContent(
      newFilePath,
      newContent,
      "hash-new"
    );

    expect(update.byteLength).toBeGreaterThan(0);

    // A sends to B
    peerA.transport.sendUpdate(newFilePath, update);

    // B should have the content
    const contentOnB = peerB.orchestrator.crdt.getContent(newFilePath);
    expect(contentOnB).toBe(newContent);

    // B's CRDT should have an active doc for this file
    expect(peerB.orchestrator.crdt.getActiveDocCount()).toBeGreaterThanOrEqual(1);
  });

  // ─── P2.4: File deletion propagates via manifest ─────────────

  test("P2.4 — file deletion propagates: manifest marks file as deleted on B", async () => {
    const filePath = "src/to-delete.ts";
    const content = "export const temp = true;\n";
    const contentHash = "hash-temp";

    // Both peers know about the file (set manifest entry on both)
    peerA.orchestrator.manifest.setFile(filePath, {
      exists: true,
      contentHash,
      mtime: Date.now(),
      size: Buffer.byteLength(content, "utf-8"),
    });
    peerB.orchestrator.manifest.setFile(filePath, {
      exists: true,
      contentHash,
      mtime: Date.now(),
      size: Buffer.byteLength(content, "utf-8"),
    });

    // Verify file exists on B before deletion
    const entryBefore = peerB.orchestrator.manifest.getEntry(filePath);
    expect(entryBefore?.exists).toBe(true);

    // A deletes the file locally — this schedules a delete on the manifest
    peerA.orchestrator.manifest.deleteFile(filePath);

    // A captures and sends the manifest update to B
    const manifestState = peerA.orchestrator.manifest.encodeState();
    peerB.orchestrator.manifest.applyRemoteUpdate(manifestState);

    // Allow the rename-detection timeout (500ms) to fire before checking
    await new Promise<void>((resolve) => setTimeout(resolve, 600));

    const entryAfter = peerB.orchestrator.manifest.getEntry(filePath);
    expect(entryAfter?.exists).toBe(false);
  });

  // ─── P2.8: Single line change produces minimal CRDT ops ──────

  test("P2.8 — single line change in 500-line file produces minimal CRDT update", async () => {
    const filePath = "src/large-file.ts";

    // Build a 500-line file
    const lines: string[] = [];
    for (let i = 0; i < 500; i++) {
      lines.push(`export const line${i} = ${i}; // line ${i}`);
    }
    const originalContent = lines.join("\n") + "\n";

    // Peer A initializes the full file
    const initUpdate = peerA.orchestrator.crdt.initializeContent(
      filePath,
      originalContent,
      "hash-large-v1"
    );

    // Deliver initial state to B so both peers are in sync
    peerA.transport.sendUpdate(filePath, initUpdate);
    const syncedContent = peerB.orchestrator.crdt.getContent(filePath);
    expect(syncedContent).toBe(originalContent);

    // Now A changes only line 250
    const modifiedLines = [...lines];
    modifiedLines[250] = `export const line250 = 9999; // changed`;
    const modifiedContent = modifiedLines.join("\n") + "\n";

    const diffUpdate = peerA.orchestrator.crdt.applyLocalChange(
      filePath,
      originalContent,
      modifiedContent,
      "hash-large-v2"
    );

    expect(diffUpdate).not.toBeNull();
    expect(diffUpdate!.byteLength).toBeGreaterThan(0);

    // The diff update should be substantially smaller than the full file state
    const fullStateSize = initUpdate.byteLength;
    const diffSize = diffUpdate!.byteLength;

    // A minimal diff for one line change should be < 20% of the full file state
    expect(diffSize).toBeLessThan(fullStateSize * 0.2);

    // Deliver the diff to B and verify B gets the correct merged content
    peerA.transport.sendUpdate(filePath, diffUpdate!);
    const mergedOnB = peerB.orchestrator.crdt.getContent(filePath);
    expect(mergedOnB).toBe(modifiedContent);
  });

  // ─── Concurrent edit convergence ─────────────────────────────

  test("concurrent edits on both peers converge to the same content", async () => {
    const filePath = "src/concurrent.ts";
    const baseContent = "const a = 1;\nconst b = 2;\n";

    // Both peers initialize from the same base
    const initA = peerA.orchestrator.crdt.initializeContent(
      filePath,
      baseContent,
      "hash-base"
    );
    peerA.transport.sendUpdate(filePath, initA);

    // Peer A makes a change: append a line
    const contentA = baseContent + "const c = 3;\n";
    const updateA = peerA.orchestrator.crdt.applyLocalChange(
      filePath,
      baseContent,
      contentA,
      "hash-a"
    );

    // Peer B makes a different change: append a different line
    const contentB = baseContent + "const d = 4;\n";
    const updateB = peerB.orchestrator.crdt.applyLocalChange(
      filePath,
      baseContent,
      contentB,
      "hash-b"
    );

    // Exchange updates cross-peer
    if (updateA) peerB.orchestrator.crdt.applyRemoteUpdate(filePath, updateA);
    if (updateB) peerA.orchestrator.crdt.applyRemoteUpdate(filePath, updateB);

    const finalA = peerA.orchestrator.crdt.getContent(filePath);
    const finalB = peerB.orchestrator.crdt.getContent(filePath);

    // Both peers must converge to identical content (CRDT guarantee)
    expect(finalA).toBe(finalB);

    // Both changes must be present in the merged result
    expect(finalA).toContain("const c = 3;");
    expect(finalA).toContain("const d = 4;");
  });

  // ─── Bidirectional sync ───────────────────────────────────────

  test("changes flow in both directions A->B and B->A", async () => {
    const fileFromA = "src/from-a.ts";
    const fileFromB = "src/from-b.ts";

    // A creates a file, send to B
    const updateA = peerA.orchestrator.crdt.initializeContent(
      fileFromA,
      "export const fromA = true;\n",
      "hash-a"
    );
    peerA.transport.sendUpdate(fileFromA, updateA);

    // B creates a different file, send to A
    const updateB = peerB.orchestrator.crdt.initializeContent(
      fileFromB,
      "export const fromB = true;\n",
      "hash-b"
    );
    peerB.transport.sendUpdate(fileFromB, updateB);

    // Both peers should have received each other's file
    expect(peerB.orchestrator.crdt.getContent(fileFromA)).toBe(
      "export const fromA = true;\n"
    );
    expect(peerA.orchestrator.crdt.getContent(fileFromB)).toBe(
      "export const fromB = true;\n"
    );
  });

  // ─── Pause / resume buffers remote updates ───────────────────

  test("paused orchestrator buffers remote updates and applies them on resume", async () => {
    const filePath = "src/buffered.ts";
    const content = "export const buffered = 'yes';\n";

    // Pause B before A sends
    peerB.orchestrator.pause();
    expect(peerB.orchestrator.state).toBe("paused");

    // A sends an update — B is paused and should buffer it
    const update = peerA.orchestrator.crdt.initializeContent(
      filePath,
      content,
      "hash-buf"
    );
    peerA.transport.sendUpdate(filePath, update);

    // B should NOT have the content yet (it was buffered)
    const beforeResume = peerB.orchestrator.crdt.getContent(filePath);
    expect(beforeResume).toBeNull();

    // Resume B — buffered updates are applied
    peerB.orchestrator.resume();
    expect(peerB.orchestrator.state).toBe("syncing");

    // Now B should have the content
    const afterResume = peerB.orchestrator.crdt.getContent(filePath);
    expect(afterResume).toBe(content);
  });

  // ─── Stats tracking ───────────────────────────────────────────

  test("getStats returns correct tracked file and doc counts", async () => {
    const files = ["src/a.ts", "src/b.ts", "src/c.ts"];

    for (const [i, file] of files.entries()) {
      const update = peerA.orchestrator.crdt.initializeContent(
        file,
        `export const v = ${i};\n`,
        `hash-${i}`
      );
      peerA.orchestrator.manifest.setFile(file, {
        exists: true,
        contentHash: `hash-${i}`,
        mtime: Date.now(),
        size: 20,
      });
      peerA.transport.sendUpdate(file, update);
    }

    const stats = peerA.orchestrator.getStats();

    // A has 3 tracked manifest files
    expect(stats.filesTracked).toBe(3);

    // A has 3 active Y.Docs (one per file initialized)
    expect(stats.activeYDocs).toBe(3);
  });
});

// ─── CRDTManager unit-level tests (isolated, no orchestrator) ──

describe("CRDTManager: isolated CRDT operations", () => {
  let crdtA: CRDTManager;
  let crdtB: CRDTManager;

  beforeEach(() => {
    crdtA = new CRDTManager(5);
    crdtB = new CRDTManager(5);
  });

  afterEach(() => {
    crdtA.dispose();
    crdtB.dispose();
  });

  test("initializeContent + applyRemoteUpdate produces identical content on peer B", () => {
    const path = "test.ts";
    const content = "export default {};\n";

    const update = crdtA.initializeContent(path, content, "h1");
    crdtB.applyRemoteUpdate(path, update);

    expect(crdtB.getContent(path)).toBe(content);
  });

  test("applyLocalChange produces update smaller than full state for line edits", () => {
    const path = "big.ts";
    const lines = Array.from({ length: 200 }, (_, i) => `const x${i} = ${i};`);
    const original = lines.join("\n");
    const modified = lines
      .map((l, i) => (i === 100 ? "const x100 = 999;" : l))
      .join("\n");

    const init = crdtA.initializeContent(path, original, "h-orig");
    const diff = crdtA.applyLocalChange(path, original, modified, "h-mod");

    expect(diff).not.toBeNull();
    // Diff must be smaller than the full initialization update
    expect(diff!.byteLength).toBeLessThan(init.byteLength);
  });

  test("applyLocalChange returns null when content is unchanged", () => {
    const path = "unchanged.ts";
    const content = "export const x = 1;\n";

    crdtA.initializeContent(path, content, "h1");
    const update = crdtA.applyLocalChange(path, content, content, "h1");

    expect(update).toBeNull();
  });

  test("getContent returns null for untracked file", () => {
    expect(crdtA.getContent("nonexistent.ts")).toBeNull();
  });

  test("getActiveDocCount tracks loaded docs correctly", () => {
    expect(crdtA.getActiveDocCount()).toBe(0);

    crdtA.initializeContent("a.ts", "const a = 1;", "ha");
    expect(crdtA.getActiveDocCount()).toBe(1);

    crdtA.initializeContent("b.ts", "const b = 2;", "hb");
    expect(crdtA.getActiveDocCount()).toBe(2);

    crdtA.removeFile("a.ts");
    expect(crdtA.getActiveDocCount()).toBe(1);
  });

  test("removeFile cleans up tracked state", () => {
    crdtA.initializeContent("file.ts", "content", "h1");
    expect(crdtA.getContent("file.ts")).toBe("content");

    crdtA.removeFile("file.ts");
    expect(crdtA.getContent("file.ts")).toBeNull();
    expect(crdtA.getActiveDocCount()).toBe(0);
  });

  test("encodeState captures full doc state for initial sync", () => {
    const path = "state.ts";
    crdtA.initializeContent(path, "const x = 1;", "h1");

    const state = crdtA.encodeState(path);
    expect(state).not.toBeNull();
    expect(state!.byteLength).toBeGreaterThan(0);

    // Apply full state to B as a remote update — content must match
    crdtB.applyRemoteUpdate(path, state!);
    expect(crdtB.getContent(path)).toBe("const x = 1;");
  });

  test("multiple sequential updates converge correctly", () => {
    const path = "seq.ts";
    let content = "v0\n";

    const init = crdtA.initializeContent(path, content, "h0");
    crdtB.applyRemoteUpdate(path, init);

    // Apply 5 sequential diffs A -> B
    for (let i = 1; i <= 5; i++) {
      const next = `v${i}\n`;
      const update = crdtA.applyLocalChange(path, content, next, `h${i}`);
      content = next;

      if (update) {
        crdtB.applyRemoteUpdate(path, update);
      }
    }

    expect(crdtA.getContent(path)).toBe("v5\n");
    expect(crdtB.getContent(path)).toBe("v5\n");
  });
});

// ─── ManifestManager unit-level tests ────────────────────────

describe("ManifestManager: manifest sync operations", () => {
  let manifestA: ManifestManager;
  let manifestB: ManifestManager;

  beforeEach(() => {
    manifestA = new ManifestManager();
    manifestB = new ManifestManager();
  });

  afterEach(() => {
    manifestA.dispose();
    manifestB.dispose();
  });

  test("setFile on A propagates to B via encodeState + applyRemoteUpdate", () => {
    const path = "src/module.ts";
    manifestA.setFile(path, {
      exists: true,
      contentHash: "abc123",
      mtime: 1000,
      size: 42,
    });

    manifestB.applyRemoteUpdate(manifestA.encodeState());

    const entry = manifestB.getEntry(path);
    expect(entry).toBeDefined();
    expect(entry?.exists).toBe(true);
    expect(entry?.contentHash).toBe("abc123");
  });

  test("fileCount reflects only existing files", () => {
    manifestA.setFile("a.ts", { exists: true, contentHash: "h1", mtime: 1, size: 1 });
    manifestA.setFile("b.ts", { exists: true, contentHash: "h2", mtime: 2, size: 2 });
    expect(manifestA.fileCount).toBe(2);

    // Mark b.ts deleted (wait for timeout to fire)
    // fileCount should not count deleted entries
    // We use encodeState/setFile with exists:false directly to avoid timer
    manifestA.setFile("b.ts", { exists: false, contentHash: "h2", mtime: 2, size: 2 });
    expect(manifestA.fileCount).toBe(1);
  });

  test("getExistingPaths excludes deleted files", () => {
    manifestA.setFile("a.ts", { exists: true, contentHash: "h1", mtime: 1, size: 1 });
    manifestA.setFile("b.ts", { exists: false, contentHash: "h2", mtime: 2, size: 2 });

    const existing = manifestA.getExistingPaths();
    expect(existing).toContain("a.ts");
    expect(existing).not.toContain("b.ts");
  });

  test("encodeState + restoreFromState round-trips manifest", () => {
    manifestA.setFile("x.ts", { exists: true, contentHash: "hx", mtime: 999, size: 5 });

    const state = manifestA.encodeState();
    const manifestC = new ManifestManager();
    manifestC.restoreFromState(state);

    const entry = manifestC.getEntry("x.ts");
    expect(entry?.exists).toBe(true);
    expect(entry?.contentHash).toBe("hx");

    manifestC.dispose();
  });

  test("manifest-update event fires on setFile", () => {
    let updateFired = false;
    manifestA.on("manifest-update", () => {
      updateFired = true;
    });

    manifestA.setFile("trigger.ts", {
      exists: true,
      contentHash: "ht",
      mtime: 0,
      size: 0,
    });

    expect(updateFired).toBe(true);
  });
});
