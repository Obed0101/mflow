import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sendIPC } from "../ipc-client.js";
import type { PeerInfo } from "../../../shared/src/index.js";

export function registerPeerTools(server: McpServer, projectRoot: string): void {
  server.tool(
    "mflow_peers",
    "List all peers connected to the current mflow sync room, including their names, types (agent/human), and join times",
    async () => {
      try {
        const response = await sendIPC(projectRoot, { type: "peers" });
        if (response.type === "peers") {
          const peers: PeerInfo[] = response.data;
          if (peers.length === 0) {
            return { content: [{ type: "text", text: "No peers connected." }] };
          }
          const lines = peers.map((p) => {
            const joined = new Date(p.joinedAt).toISOString();
            return `- ${p.peerName} | type: ${p.peerType} | id: ${p.peerId.slice(0, 8)}… | joined: ${joined}`;
          });
          return { content: [{ type: "text", text: `Connected peers (${peers.length}):\n${lines.join("\n")}` }] };
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
}
