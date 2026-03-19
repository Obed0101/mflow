import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sendIPC } from "../ipc-client.js";

export function registerSyncControlTools(server: McpServer, projectRoot: string): void {
  // Track MCP pause IDs so resume can clear the correct reason
  let activePauseId: string | null = null;

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
