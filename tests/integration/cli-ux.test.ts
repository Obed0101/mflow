import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { DEFAULT_SIGNALING_URL } from "@mflow/shared";
import {
  classifyRelay,
  displayStatus,
  displayStartSummary,
} from "../../packages/cli/src/display.js";

const CLI_ENTRY = join(import.meta.dir, "../../packages/cli/src/index.ts");

function runCli(args: string[] = []): string {
  const proc = Bun.spawnSync({
    cmd: ["bun", CLI_ENTRY, ...args],
    env: {
      ...process.env,
      NO_COLOR: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = new TextDecoder().decode(proc.stdout);
  const stderr = new TextDecoder().decode(proc.stderr);
  expect(proc.exitCode).toBe(0);
  expect(stderr).toBe("");
  return stdout;
}

function captureStdout(fn: () => void): string {
  const lines: string[] = [];
  const originalLog = console.log;
  try {
    console.log = (...args: unknown[]) => {
      lines.push(args.join(" "));
    };
    fn();
  } finally {
    console.log = originalLog;
  }
  return lines.join("\n");
}

describe("CLI UX", () => {
  test("no-args output has banner, value prop, and starter commands", () => {
    const output = runCli();

    expect(output).toContain(" _ __ ___");
    expect(output).toContain("Real-time code sync for AI agent teams.");
    expect(output).toContain("mflow start");
    expect(output).toContain("mflow status");
    expect(output).toContain("mflow lock src/file.ts");
    expect(output).toContain("https://github.com/Obed0101/mflow#readme");
  });

  test("--help output includes grouped commands and examples", () => {
    const output = runCli(["--help"]);

    expect(output).toContain("Command groups:");
    expect(output).toContain("Sync lifecycle:");
    expect(output).toContain("Safety controls:");
    expect(output).toContain("Setup:");
    expect(output).toContain("mflow install-hooks");
    expect(output).toContain("mflow apply-patch");
    expect(output).toContain("mflow claim");
    expect(output).toContain("Examples:");
    expect(output).toContain('mflow start --room project-x --secret "$MFLOW_SECRET"');
  });

  test("NO_COLOR removes ANSI escape sequences from status output", () => {
    const previousNoColor = process.env["NO_COLOR"];
    process.env["NO_COLOR"] = "1";
    const output = captureStdout(() => {
      displayStatus({
        state: "syncing",
        roomId: "project-x",
        peers: [],
        trackedFiles: 2,
        activeYDocs: 1,
        opsPerSecond: 0,
        uptime: 1_000,
        memoryUsageMB: 42,
        pauseReasons: [],
        locks: [],
        lockWaiters: [],
        mergeWarnings: [],
        recentActivity: [],
      });
    });
    if (previousNoColor === undefined) {
      delete process.env["NO_COLOR"];
    } else {
      process.env["NO_COLOR"] = previousNoColor;
    }

    expect(output).not.toMatch(/\x1b\[[0-9;]*m/);
  });

  test("start summary contains relay, project, room, mode, warnings, and next peer command", () => {
    const output = captureStdout(() => {
      displayStartSummary({
        pid: 12345,
        projectRoot: "/tmp/mflow-project",
        room: "project-x",
        signaling: DEFAULT_SIGNALING_URL,
        transport: "relay",
        generatedSecret: true,
      });
    });

    expect(output).toContain("Daemon started (PID: 12345)");
    expect(output).toContain("Project:   /tmp/mflow-project");
    expect(output).toContain("Room:      project-x");
    expect(output).toContain(`Relay:     ${DEFAULT_SIGNALING_URL} (public fair-use relay)`);
    expect(output).toContain("Mode:      relay");
    expect(output).toContain("Treat the room secret like a password");
    expect(output).toContain("A new secret was generated");
    expect(output).toContain(`mflow start --room project-x --secret <shared-secret> --signaling ${DEFAULT_SIGNALING_URL}`);
  });

  test("custom signaling URL is labeled custom/self-hosted", () => {
    expect(classifyRelay("ws://localhost:8787")).toBe("custom/self-hosted relay");
  });
});
