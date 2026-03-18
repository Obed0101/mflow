import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sendIPC, isDaemonRunning } from "../ipc-client.js";
import type { DaemonStatus, PeerInfo } from "@mflow/shared";

export function registerStatusTools(server: McpServer, projectRoot: string): void {
  server.tool(
    "mflow_status",
    "Get the current mflow daemon status including sync state, connected peers, tracked files, ops/second, uptime, and memory usage",
    async () => {
      try {
        const response = await sendIPC(projectRoot, { type: "status" });
        if (response.type === "status") {
          const d: DaemonStatus = response.data;
          const lines = [
            `State: ${d.state}`,
            `Room: ${d.roomId ?? "none"}`,
            `Peers: ${d.peers.length} connected`,
            ...d.peers.map((p: PeerInfo) => `  - ${p.peerName} (${p.peerType}, ${p.peerId.slice(0, 8)}…)`),
            `Tracked files: ${d.trackedFiles}`,
            `Active Y.Docs: ${d.activeYDocs}`,
            `Ops/sec: ${d.opsPerSecond}`,
            `Uptime: ${Math.floor(d.uptime / 1000)}s`,
            `Memory: ${d.memoryUsageMB.toFixed(1)} MB`,
          ];
          return { content: [{ type: "text", text: lines.join("\n") }] };
        }
        if (response.type === "error") {
          return { content: [{ type: "text", text: `Daemon error: ${response.message}` }], isError: true };
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
    "mflow_health",
    "Quick health check — returns whether the mflow daemon is running and responsive",
    async () => {
      const running = await isDaemonRunning(projectRoot);
      return {
        content: [{
          type: "text",
          text: running ? "mflow daemon is running and healthy." : "mflow daemon is NOT running. Start it with: mflow start",
        }],
      };
    },
  );
}
