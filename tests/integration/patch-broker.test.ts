import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyMflowPatch, getPatchPaths } from "../../packages/cli/src/patch-broker.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mflow-patch-broker-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("Patch broker", () => {
  test("applies update hunks", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "file.txt"), "a\nb\nc\n", "utf-8");

      await applyMflowPatch(dir, `*** Begin Patch
*** Update File: file.txt
@@
 a
-b
+B
 c
*** End Patch
`);

      expect(await readFile(join(dir, "file.txt"), "utf-8")).toBe("a\nB\nc\n");
    });
  });

  test("applies add and delete file changes", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "old.txt"), "old\n", "utf-8");

      await applyMflowPatch(dir, `*** Begin Patch
*** Add File: nested/new.txt
+hello
+world
*** Delete File: old.txt
*** End Patch
`);

      expect(await readFile(join(dir, "nested/new.txt"), "utf-8")).toBe("hello\nworld\n");
      expect(await Bun.file(join(dir, "old.txt")).exists()).toBe(false);
    });
  });

  test("applies move updates and reports both lock paths", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "old.txt"), "a\nb\n", "utf-8");
      const patch = `*** Begin Patch
*** Update File: old.txt
*** Move to: new.txt
@@
 a
-b
+B
*** End Patch
`;

      expect(getPatchPaths(patch)).toEqual(["old.txt", "new.txt"]);
      await applyMflowPatch(dir, patch);

      expect(await Bun.file(join(dir, "old.txt")).exists()).toBe(false);
      expect(await readFile(join(dir, "new.txt"), "utf-8")).toBe("a\nB\n");
    });
  });
});
