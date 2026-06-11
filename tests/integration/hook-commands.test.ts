import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installHooksCommand } from "../../packages/cli/src/commands/install-hooks.js";
import { hookStatusCommand } from "../../packages/cli/src/commands/hook-status.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function makeTempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mflow-hook-test-"));
  tempDirs.push(dir);
  return dir;
}

function captureStdout(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };

  return fn()
    .then(() => lines.join("\n"))
    .finally(() => {
      console.log = originalLog;
    });
}

describe("hook commands", () => {
  test("installHooksCommand scaffolds Codex integration files", async () => {
    const dir = await makeTempRepo();

    await installHooksCommand(dir, { harness: "codex" });

    const script = await readFile(join(dir, ".codex", "hooks", "mflow-pre-edit.sh"), "utf-8");
    const prompt = await readFile(join(dir, ".codex", "mflow-agent-prompt.md"), "utf-8");
    const example = await readFile(join(dir, ".codex", "mflow-hook.example.toml"), "utf-8");

    expect(script).toContain("\"$MFLOW_BIN\" lock");
    expect(prompt).toContain("experimental Codex hook scaffold");
    expect(example).toContain("Experimental Codex hook scaffold");
  });

  test("hookStatusCommand reports Codex scaffold as experimental and installed", async () => {
    const dir = await makeTempRepo();

    await installHooksCommand(dir, { harness: "codex" });
    const output = await captureStdout(() => hookStatusCommand(dir, { harness: "codex" }));

    expect(output).toContain("codex: experimental scaffold installed");
    expect(output).toContain("experimental scaffold:");
    expect(output).toContain("Ask the human before wiring the scaffold into Codex.");
  });

  test("installHooksCommand scaffolds MendCode integration files", async () => {
    const dir = await makeTempRepo();

    await installHooksCommand(dir, { harness: "mendcode" });

    const plugin = await readFile(join(dir, ".mendcode", "plugins", "mflow-lock.js"), "utf-8");
    const control = await readFile(join(dir, ".mendcode", "mflow-control.md"), "utf-8");
    const mcpExample = await readFile(join(dir, ".mendcode", "mcp.mflow.example.json"), "utf-8");

    expect(plugin).toContain("tool.execute.before");
    expect(plugin).toContain("--priority");
    expect(control).toContain("Public mflow relay is a shared fair-use service");
    expect(control).toContain("mend mcp add mflow -- pnpm --package=mflow-cli dlx mflow-mcp");
    expect(mcpExample).toContain('"command": "pnpm"');
    expect(mcpExample).toContain('"mflow-mcp"');
  });

  test("hookStatusCommand reports MendCode scaffold as experimental and present", async () => {
    const dir = await makeTempRepo();

    await installHooksCommand(dir, { harness: "mendcode" });
    const output = await captureStdout(() => hookStatusCommand(dir, { harness: "mendcode" }));

    expect(output).toContain("mendcode: experimental scaffold present");
    expect(output).toContain("experimental plugin:");
    expect(output).toContain("Verify the active MendCode build exposes tool.execute.before");
  });
});
