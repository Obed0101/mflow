import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sendIPC } from "../ipc-client.js";

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
    },
    async ({ path, lease_duration_ms }) => {
      try {
        const response = await sendIPC(projectRoot, {
          type: "lock",
          path,
          leaseDurationMs: lease_duration_ms,
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
          if (locks.length === 0) {
            return { content: [{ type: "text", text: "No active locks" }] };
          }
          const lines = locks.map((l) => {
            const remaining = Math.max(0, Math.ceil((l.expiresAt - Date.now()) / 1000));
            return `  ${l.path} — locked by ${l.holderName} (token: ${l.token}, expires in ${remaining}s)`;
          });
          return { content: [{ type: "text", text: `Active locks:\n${lines.join("\n")}` }] };
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
