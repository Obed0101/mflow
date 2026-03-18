import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerStatusTools } from "./tools/status.js";
import { registerPeerTools } from "./tools/peers.js";
import { registerSyncControlTools } from "./tools/sync-control.js";

/**
 * Create the mflow MCP server with all tools registered.
 * @param projectRoot — absolute path to the project root where .mflow/ lives
 */
export function createServer(projectRoot: string): McpServer {
  const server = new McpServer({
    name: "mflow",
    version: "0.1.0",
  });

  registerStatusTools(server, projectRoot);
  registerPeerTools(server, projectRoot);
  registerSyncControlTools(server, projectRoot);

  return server;
}
