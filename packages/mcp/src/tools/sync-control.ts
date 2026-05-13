import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sendIPC } from "../ipc-client.js";
import { applyMflowPatch, getPatchPaths } from "../../../cli/src/patch-broker.js";

export function registerSyncControlTools(server: McpServer, projectRoot: string): void {
  // Track MCP pause IDs so resume can clear the correct reason
  let activePauseId: string | null = null;

  // ── File Locking Tools ──

  server.tool(
    "mflow_lock",
    "Acquire an exclusive lock on a file to prevent other agents from propagating changes to it. Use before editing a shared file. Lock auto-expires after the lease duration (default 30s, max 120s). Re-calling on the same file renews the lease.",
    {
      path: z.string().min(1).describe("Relative file path to lock (e.g., 'src/server.ts')"),
      lease_duration_ms: z.number().int().positive().max(120_000).optional().describe("Lock lease duration in ms (default 30000, max 120000)"),
      wait: z.boolean().optional().describe("Wait until the lock is available instead of returning immediately when denied"),
      timeout_ms: z.number().int().positive().max(300_000).optional().describe("Maximum wait time in ms (default 60000, max 300000)"),
      priority: z.number().int().min(0).max(9).optional().describe("Wait priority from 0 to 9; higher wins, FIFO within same priority"),
    },
    async ({ path, lease_duration_ms, wait, timeout_ms, priority }) => {
      try {
        const response = await sendIPC(projectRoot, {
          type: "lock",
          path,
          leaseDurationMs: lease_duration_ms,
          wait,
          timeoutMs: timeout_ms,
          priority,
          source: "mcp",
        });
        if (response.type === "lock-result") {
          const { granted, lock } = response.data;
          if (granted) {
            return {
              content: [{
                type: "text",
                text: `Lock acquired on ${path} (token: ${lock.token}, expires in ${lock.leaseDurationMs / 1000}s). Call mflow_unlock when done editing.`,
              }],
            };
          }
          const remaining = Math.max(0, Math.ceil((lock.expiresAt - Date.now()) / 1000));
          return {
            content: [{
              type: "text",
              text: `Lock denied — ${path} is locked by ${lock.holderName} (expires in ${remaining}s). Wait or ask them to release.`,
            }],
            isError: true,
          };
        }
        if (response.type === "error") {
          return { content: [{ type: "text", text: `Error: ${response.message}` }], isError: true };
        }
        return { content: [{ type: "text", text: JSON.stringify(response) }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "mflow_unlock",
    "Release your lock on a file so other agents can propagate changes to it. Only the lock holder can release.",
    { path: z.string().min(1).describe("Relative file path to unlock") },
    async ({ path }) => {
      try {
        const response = await sendIPC(projectRoot, { type: "unlock", path, source: "mcp" });
        if (response.type === "ok") {
          return { content: [{ type: "text", text: `Lock released on ${path}` }] };
        }
        if (response.type === "error") {
          return { content: [{ type: "text", text: `Error: ${response.message}` }], isError: true };
        }
        return { content: [{ type: "text", text: JSON.stringify(response) }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "mflow_locks",
    "List all active file locks — shows who holds each lock and when it expires",
    async () => {
      try {
        const response = await sendIPC(projectRoot, { type: "lock-query" });
        if (response.type === "locks") {
          const locks = response.data;
          const waiters = response.waiters ?? [];
          if (locks.length === 0 && waiters.length === 0) {
            return { content: [{ type: "text", text: "No active locks" }] };
          }
          const lines = locks.map((l) => {
            const remaining = Math.max(0, Math.ceil((l.expiresAt - Date.now()) / 1000));
            return `  ${l.path} — locked by ${l.holderName} (token: ${l.token}, expires in ${remaining}s)`;
          });
          const waiterLines = waiters.map((w) => {
            const remaining = Math.max(0, Math.ceil((w.expiresAt - Date.now()) / 1000));
            return `  ${w.path} — waiting: ${w.holderName} (priority ${w.priority}, timeout in ${remaining}s)`;
          });
          return { content: [{ type: "text", text: `Active locks:\n${[...lines, ...waiterLines].join("\n")}` }] };
        }
        if (response.type === "error") {
          return { content: [{ type: "text", text: `Error: ${response.message}` }], isError: true };
        }
        return { content: [{ type: "text", text: JSON.stringify(response) }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "mflow_pause",
    "Pause outgoing sync — local changes are buffered, incoming changes are queued. Use before large refactors to avoid flooding peers with intermediate states",
    async () => {
      try {
        const id = `mcp-${crypto.randomUUID()}`;
        const response = await sendIPC(projectRoot, { type: "pause", source: "mcp", id });
        if (response.type === "ok") {
          activePauseId = id;
          return { content: [{ type: "text", text: `Sync paused (reason: ${id}). Local changes are being buffered. Use mflow_resume when ready.` }] };
        }
        if (response.type === "error") {
          return { content: [{ type: "text", text: `Error: ${response.message}` }], isError: true };
        }
        return { content: [{ type: "text", text: JSON.stringify(response) }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "mflow_resume",
    "Resume sync after a pause — applies all buffered updates and resumes real-time sync. Clears MCP and auto pause reasons.",
    async () => {
      try {
        const response = await sendIPC(projectRoot, {
          type: "resume",
          source: "mcp",
          id: activePauseId ?? undefined,
        });
        if (response.type === "ok") {
          activePauseId = null;
          return { content: [{ type: "text", text: "Sync resumed. Buffered changes are being applied." }] };
        }
        if (response.type === "error") {
          return { content: [{ type: "text", text: `Error: ${response.message}` }], isError: true };
        }
        return { content: [{ type: "text", text: JSON.stringify(response) }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "mflow_stop",
    "Gracefully stop the mflow daemon — persists CRDT state, disconnects transport, and cleans up",
    async () => {
      try {
        const response = await sendIPC(projectRoot, { type: "stop" });
        if (response.type === "ok") {
          return { content: [{ type: "text", text: "Daemon stopping gracefully. CRDT state persisted." }] };
        }
        if (response.type === "error") {
          return { content: [{ type: "text", text: `Error: ${response.message}` }], isError: true };
        }
        return { content: [{ type: "text", text: JSON.stringify(response) }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "mflow_apply_patch",
    "Apply an apply_patch-format patch after acquiring queued mflow locks for every changed file",
    {
      patch_text: z.string().min(1).describe("Patch text in apply_patch format"),
      timeout_ms: z.number().int().positive().max(300_000).optional().describe("Maximum wait time per lock in ms (default 60000)"),
      priority: z.number().int().min(0).max(9).optional().describe("Wait priority from 0 to 9"),
    },
    async ({ patch_text, timeout_ms, priority }) => {
      try {
        const paths = getPatchPaths(patch_text);
        if (paths.length === 0) {
          return { content: [{ type: "text", text: "Patch contains no file changes" }], isError: true };
        }

        for (const path of paths) {
          const response = await sendIPC(projectRoot, {
            type: "lock",
            path,
            leaseDurationMs: 30_000,
            wait: true,
            timeoutMs: timeout_ms ?? 60_000,
            priority: priority ?? 0,
            source: "mcp",
          });
          if (response.type === "error") {
            return { content: [{ type: "text", text: response.message }], isError: true };
          }
          if (response.type !== "lock-result" || !response.data.granted) {
            return { content: [{ type: "text", text: `Could not acquire lock for ${path}` }], isError: true };
          }
        }

        const changed = await applyMflowPatch(projectRoot, patch_text);
        for (const path of paths) {
          await sendIPC(projectRoot, { type: "unlock", path, source: "mcp" }).catch(() => undefined);
        }
        return { content: [{ type: "text", text: `Applied patch to ${changed.length} file${changed.length === 1 ? "" : "s"}: ${changed.join(", ")}` }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "mflow_ignore",
    "Add a gitignore-style pattern to exclude files from sync at runtime",
    { pattern: z.string().min(1).describe("Gitignore-style pattern (e.g., '*.log', 'temp/', 'src/**/*.test.ts')") },
    async ({ pattern }) => {
      try {
        const response = await sendIPC(projectRoot, { type: "ignore", pattern });
        if (response.type === "ok") {
          return { content: [{ type: "text", text: `Ignore pattern added: ${pattern}` }] };
        }
        if (response.type === "error") {
          return { content: [{ type: "text", text: `Error: ${response.message}` }], isError: true };
        }
        return { content: [{ type: "text", text: JSON.stringify(response) }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );
}
