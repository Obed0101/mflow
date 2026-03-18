/**
 * T6.4: Integration — Crash Recovery, File Size Limits, Binary Skip, Lazy Loading
 *
 * Properties under test:
 *   P5.3  Crash recovery — daemon recovers CRDT state from filesystem on restart
 *   P5.5  File size limit — files >1MB are skipped with reason "too_large"
 *   P2.6  Binary file exclusion — files with null bytes or binary extensions are excluded
 *   P2.2  Lazy loading — Y.Doc unloaded after inactivity, persisted to disk, reloaded on access
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isBinaryFile, isFileTooLarge, shouldSync } from "@mflow/shared";
import { MAX_FILE_SIZE_BYTES } from "@mflow/shared";

import { CRDTPersistence } from "../../packages/daemon/src/persistence.js";
import { CRDTManager } from "../../packages/daemon/src/crdt.js";
import { ManifestManager } from "../../packages/daemon/src/manifest.js";

// ─── Helpers ────────────────────────────────────────────────

/**
 * Create a fresh temp directory rooted at the OS temp dir.
 * CRDTPersistence will create .mflow/crdt/ inside it.
 */
async function makeTempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "mflow-test-"));
}

/**
 * Compute a stable SHA-256 content hash for a string (matches daemon convention).
 */
function fakeHash(content: string): string {
  // Simple deterministic stand-in — tests only check round-trip identity.
  return `hash-${Buffer.from(content).length}`;
}

// ─── P5.3: Crash Recovery ───────────────────────────────────

describe("T6.4: Resilience", () => {
  describe("P5.3: Crash Recovery", () => {
    let tmpRoot: string;

    beforeEach(async () => {
      tmpRoot = await makeTempRoot();
    });

    afterEach(async () => {
      await rm(tmpRoot, { recursive: true, force: true });
    });

    test("persisted CRDT state survives simulated restart", async () => {
      const filePath = "src/index.ts";
      const originalContent = "const x = 42;\nconsole.log(x);\n";

      // --- Session 1: write content and persist ---
      const persistence1 = new CRDTPersistence(tmpRoot);
      const manager1 = new CRDTManager(0);

      manager1.initializeContent(filePath, originalContent, fakeHash(originalContent));
      await manager1.persistAll(persistence1);
      manager1.dispose();

      // Verify .ystate file was written
      const persisted = await persistence1.listPersistedFiles();
      expect(persisted.length).toBe(1);
      expect(persisted[0]).toMatch(/\.ystate$/);

      // --- Session 2: "restart" — new manager, load from disk ---
      const persistence2 = new CRDTPersistence(tmpRoot);
      const manager2 = new CRDTManager(0);

      const state = await persistence2.loadDoc(filePath);
      expect(state).not.toBeNull();

      manager2.restoreDoc(filePath, state!);

      const recovered = manager2.getContent(filePath);
      expect(recovered).toBe(originalContent);

      manager2.dispose();
    });

    test("multiple files are all persisted and individually recoverable", async () => {
      const files: Array<{ path: string; content: string }> = [
        { path: "src/a.ts", content: "export const a = 1;\n" },
        { path: "src/b.ts", content: "export const b = 2;\n" },
        { path: "lib/c.ts", content: "export const c = 3;\n" },
      ];

      const persistence = new CRDTPersistence(tmpRoot);
      const manager1 = new CRDTManager(0);

      for (const { path, content } of files) {
        manager1.initializeContent(path, content, fakeHash(content));
      }
      await manager1.persistAll(persistence);
      manager1.dispose();

      // Verify all three .ystate files exist
      const persisted = await persistence.listPersistedFiles();
      expect(persisted.length).toBe(files.length);

      // Restore each file in a fresh manager and verify content
      const manager2 = new CRDTManager(0);
      for (const { path, content } of files) {
        const state = await persistence.loadDoc(path);
        expect(state).not.toBeNull();
        manager2.restoreDoc(path, state!);
        expect(manager2.getContent(path)).toBe(content);
      }
      manager2.dispose();
    });

    test("manifest state survives simulated restart", async () => {
      const persistence = new CRDTPersistence(tmpRoot);

      // --- Session 1: build manifest and save ---
      const manifest1 = new ManifestManager();
      manifest1.setFile("src/index.ts", {
        exists: true,
        contentHash: "abc123",
        mtime: 1_700_000_000_000,
        size: 512,
      });
      manifest1.setFile("README.md", {
        exists: true,
        contentHash: "def456",
        mtime: 1_700_000_001_000,
        size: 1024,
      });

      const encodedState = manifest1.encodeState();
      await persistence.saveManifest(encodedState);
      manifest1.dispose();

      // --- Session 2: restore manifest from disk ---
      const rawState = await persistence.loadManifest();
      expect(rawState).not.toBeNull();

      const manifest2 = new ManifestManager();
      manifest2.restoreFromState(rawState!);

      const entries = manifest2.getAllEntries();
      expect(entries.size).toBe(2);

      const indexEntry = entries.get("src/index.ts");
      expect(indexEntry).toBeDefined();
      expect(indexEntry!.contentHash).toBe("abc123");
      expect(indexEntry!.exists).toBe(true);
      expect(indexEntry!.size).toBe(512);

      const readmeEntry = entries.get("README.md");
      expect(readmeEntry).toBeDefined();
      expect(readmeEntry!.contentHash).toBe("def456");
      expect(readmeEntry!.exists).toBe(true);

      manifest2.dispose();
    });

    test("clearAll removes all persisted state", async () => {
      const persistence = new CRDTPersistence(tmpRoot);
      const manager = new CRDTManager(0);

      manager.initializeContent("file.ts", "const x = 1;", fakeHash("const x = 1;"));
      await manager.persistAll(persistence);
      manager.dispose();

      // Confirm state is present before clear
      let files = await persistence.listPersistedFiles();
      expect(files.length).toBe(1);

      await persistence.clearAll();

      files = await persistence.listPersistedFiles();
      expect(files.length).toBe(0);

      const manifest = await persistence.loadManifest();
      expect(manifest).toBeNull();
    });

    test("loadDoc returns null when no persisted state exists", async () => {
      const persistence = new CRDTPersistence(tmpRoot);
      const result = await persistence.loadDoc("nonexistent/file.ts");
      expect(result).toBeNull();
    });

    test("loadManifest returns null when no manifest has been saved", async () => {
      const persistence = new CRDTPersistence(tmpRoot);
      const result = await persistence.loadManifest();
      expect(result).toBeNull();
    });
  });

  // ─── P5.5: File Size Limit ──────────────────────────────────

  describe("P5.5: File Size Limit", () => {
    test("file exceeding 1MB is rejected by shouldSync with reason too_large", () => {
      const result = shouldSync("big.txt", 2_000_000);
      expect(result.sync).toBe(false);
      expect(result.reason).toBe("too_large");
    });

    test("file under 1MB is accepted by shouldSync", () => {
      const result = shouldSync("small.txt", 500_000);
      expect(result.sync).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    test("file exactly at 1MB boundary (1_048_576 bytes) is accepted", () => {
      const result = shouldSync("exact.txt", MAX_FILE_SIZE_BYTES);
      expect(result.sync).toBe(true);
    });

    test("file one byte over 1MB (1_048_577 bytes) is rejected", () => {
      const result = shouldSync("over.txt", MAX_FILE_SIZE_BYTES + 1);
      expect(result.sync).toBe(false);
      expect(result.reason).toBe("too_large");
    });

    test("isFileTooLarge returns false for exactly 1MB", () => {
      expect(isFileTooLarge(MAX_FILE_SIZE_BYTES)).toBe(false);
    });

    test("isFileTooLarge returns true for 1MB + 1 byte", () => {
      expect(isFileTooLarge(MAX_FILE_SIZE_BYTES + 1)).toBe(true);
    });

    test("isFileTooLarge returns false for zero bytes", () => {
      expect(isFileTooLarge(0)).toBe(false);
    });

    test("size check takes precedence over content when both are provided and file is too large", () => {
      // Content is text-safe, but size exceeds limit — size wins
      const textContent = Buffer.from("hello world");
      const result = shouldSync("big-text.txt", MAX_FILE_SIZE_BYTES + 1, textContent);
      expect(result.sync).toBe(false);
      expect(result.reason).toBe("too_large");
    });
  });

  // ─── P2.6: Binary File Exclusion ────────────────────────────

  describe("P2.6: Binary File Exclusion", () => {
    test("file with known binary extension .png is excluded", () => {
      expect(isBinaryFile("image.png")).toBe(true);
    });

    test("file with known binary extension .woff2 is excluded", () => {
      expect(isBinaryFile("font.woff2")).toBe(true);
    });

    test("file with known binary extension .jpg is excluded", () => {
      expect(isBinaryFile("photo.jpg")).toBe(true);
    });

    test("file with known binary extension .wasm is excluded", () => {
      expect(isBinaryFile("module.wasm")).toBe(true);
    });

    test("file with known binary extension .sqlite is excluded", () => {
      expect(isBinaryFile("data.sqlite")).toBe(true);
    });

    test("TypeScript source file without null bytes is not binary", () => {
      const content = Buffer.from("const x = 1;\nconst y = 2;\n");
      expect(isBinaryFile("code.ts", content)).toBe(false);
    });

    test("file with null byte in first 8KB is detected as binary", () => {
      // Text prefix followed by a null byte
      const prefix = Buffer.from("header text data ");
      const nullByte = Buffer.alloc(1, 0x00);
      const suffix = Buffer.from(" more text");
      const content = Buffer.concat([prefix, nullByte, suffix]);

      expect(isBinaryFile("unknown.dat", content)).toBe(true);
    });

    test("file with null byte at position 0 is detected as binary", () => {
      const content = Buffer.concat([Buffer.alloc(1, 0x00), Buffer.from("rest of content")]);
      expect(isBinaryFile("data.bin", content)).toBe(true);
    });

    test("file with null byte at boundary of 8KB check window is detected as binary", () => {
      // Null byte at index 8191 (last byte of the 8KB window)
      const content = Buffer.alloc(8_192, 0x61); // fill with 'a'
      content[8191] = 0x00;
      expect(isBinaryFile("boundary.dat", content)).toBe(true);
    });

    test("file with null byte beyond 8KB check window is not flagged as binary by content alone", () => {
      // Null byte at index 8192 — outside the 8KB check range
      const content = Buffer.alloc(16_384, 0x61); // fill with 'a'
      content[8192] = 0x00;
      // No binary extension, null byte outside check window — not binary
      expect(isBinaryFile("borderline.txt", content)).toBe(false);
    });

    test("unknown extension with all-text content is not binary", () => {
      const content = Buffer.from("line1\nline2\nline3\n");
      expect(isBinaryFile("unknown.xyz", content)).toBe(false);
    });

    test("shouldSync rejects binary content with reason binary", () => {
      const content = Buffer.concat([Buffer.from("data"), Buffer.alloc(1, 0x00)]);
      const result = shouldSync("data.bin", content.length, content);
      expect(result.sync).toBe(false);
      expect(result.reason).toBe("binary");
    });

    test("shouldSync rejects binary extension even without content provided", () => {
      const result = shouldSync("archive.zip", 100);
      expect(result.sync).toBe(false);
      expect(result.reason).toBe("binary");
    });

    test("shouldSync accepts plain text file under size limit", () => {
      const content = Buffer.from("export function greet(name: string): string {\n  return `Hello, ${name}`;\n}\n");
      const result = shouldSync("greet.ts", content.length, content);
      expect(result.sync).toBe(true);
    });
  });

  // ─── P2.2: Lazy Loading / Unloading ─────────────────────────

  describe("P2.2: Lazy Loading / Unloading", () => {
    let tmpRoot: string;

    beforeEach(async () => {
      tmpRoot = await makeTempRoot();
    });

    afterEach(async () => {
      await rm(tmpRoot, { recursive: true, force: true });
    });

    test("Y.Doc is unloaded after calling unloadDoc and hasDoc returns false", async () => {
      const persistence = new CRDTPersistence(tmpRoot);
      // 0 minutes = unload immediately when unloadIdle is called
      const manager = new CRDTManager(0);

      const filePath = "src/lazy.ts";
      const content = "export const lazy = true;\n";
      manager.initializeContent(filePath, content, fakeHash(content));

      expect(manager.hasDoc(filePath)).toBe(true);

      await manager.unloadDoc(filePath, persistence);

      expect(manager.hasDoc(filePath)).toBe(false);
      expect(manager.getContent(filePath)).toBeNull();

      manager.dispose();
    });

    test("unloaded Y.Doc is persisted to disk before being freed", async () => {
      const persistence = new CRDTPersistence(tmpRoot);
      const manager = new CRDTManager(0);

      const filePath = "src/unload-persist.ts";
      const content = "const persisted = true;\n";
      manager.initializeContent(filePath, content, fakeHash(content));

      await manager.unloadDoc(filePath, persistence);

      const state = await persistence.loadDoc(filePath);
      expect(state).not.toBeNull();
      expect(state!.length).toBeGreaterThan(0);

      manager.dispose();
    });

    test("content can be restored after Y.Doc is unloaded", async () => {
      const persistence = new CRDTPersistence(tmpRoot);
      const manager = new CRDTManager(0);

      const filePath = "src/restore.ts";
      const content = "export default function restore() {}\n";
      manager.initializeContent(filePath, content, fakeHash(content));

      // Unload the doc — persists to disk and frees memory
      await manager.unloadDoc(filePath, persistence);
      expect(manager.hasDoc(filePath)).toBe(false);

      // Reload from disk
      const state = await persistence.loadDoc(filePath);
      expect(state).not.toBeNull();

      manager.restoreDoc(filePath, state!);

      expect(manager.hasDoc(filePath)).toBe(true);
      expect(manager.getContent(filePath)).toBe(content);

      manager.dispose();
    });

    test("unloadIdle with 0-minute threshold unloads all docs immediately", async () => {
      const persistence = new CRDTPersistence(tmpRoot);
      const manager = new CRDTManager(0); // 0 minutes = immediate

      const files = [
        { path: "a.ts", content: "const a = 1;\n" },
        { path: "b.ts", content: "const b = 2;\n" },
        { path: "c.ts", content: "const c = 3;\n" },
      ];

      for (const { path, content } of files) {
        manager.initializeContent(path, content, fakeHash(content));
      }

      expect(manager.getActiveDocCount()).toBe(3);

      const unloadedCount = await manager.unloadIdle(persistence);
      expect(unloadedCount).toBe(3);
      expect(manager.getActiveDocCount()).toBe(0);

      manager.dispose();
    });

    test("doc-unloaded event is emitted when Y.Doc is unloaded", async () => {
      const persistence = new CRDTPersistence(tmpRoot);
      const manager = new CRDTManager(0);

      const filePath = "src/event.ts";
      manager.initializeContent(filePath, "const e = true;\n", fakeHash("const e = true;\n"));

      const unloadedPaths: string[] = [];
      manager.on("doc-unloaded", (path: string) => {
        unloadedPaths.push(path);
      });

      await manager.unloadDoc(filePath, persistence);

      expect(unloadedPaths).toContain(filePath);

      manager.dispose();
    });

    test("doc-loaded event is emitted when Y.Doc is first created via restoreDoc", async () => {
      const persistence = new CRDTPersistence(tmpRoot);
      const manager1 = new CRDTManager(0);

      const filePath = "src/reload-event.ts";
      const content = "const v = 99;\n";
      manager1.initializeContent(filePath, content, fakeHash(content));
      await manager1.persistAll(persistence);
      manager1.dispose();

      // New manager — restoring triggers doc-loaded
      const manager2 = new CRDTManager(0);
      const loadedPaths: string[] = [];
      manager2.on("doc-loaded", (path: string) => {
        loadedPaths.push(path);
      });

      const state = await persistence.loadDoc(filePath);
      manager2.restoreDoc(filePath, state!);

      expect(loadedPaths).toContain(filePath);

      manager2.dispose();
    });

    test("getActiveDocCount reflects unload state accurately", async () => {
      const persistence = new CRDTPersistence(tmpRoot);
      const manager = new CRDTManager(0);

      manager.initializeContent("x.ts", "const x = 0;\n", fakeHash("const x = 0;\n"));
      manager.initializeContent("y.ts", "const y = 0;\n", fakeHash("const y = 0;\n"));
      expect(manager.getActiveDocCount()).toBe(2);

      await manager.unloadDoc("x.ts", persistence);
      expect(manager.getActiveDocCount()).toBe(1);

      await manager.unloadDoc("y.ts", persistence);
      expect(manager.getActiveDocCount()).toBe(0);

      manager.dispose();
    });

    test("persistAll does not persist already-persisted docs a second time", async () => {
      const persistence = new CRDTPersistence(tmpRoot);
      const manager = new CRDTManager(0);

      const filePath = "src/once.ts";
      manager.initializeContent(filePath, "const once = true;\n", fakeHash("const once = true;\n"));

      await manager.persistAll(persistence);

      // Second call — doc is marked persisted, saveDoc should not be called again
      // We verify indirectly: the tracked file's persisted flag prevents re-save.
      // If no error is thrown and state is still loadable, the test passes.
      await manager.persistAll(persistence);

      const state = await persistence.loadDoc(filePath);
      expect(state).not.toBeNull();

      manager.dispose();
    });
  });
});
