#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

// ─── Resolve project root ──────────────────────────────────────
// Priority: --root flag > MFLOW_PROJECT_ROOT env > cwd
const rootFlagIdx = process.argv.indexOf("--root");
const projectRoot =
  (rootFlagIdx !== -1 ? process.argv[rootFlagIdx + 1] : undefined) ??
  process.env.MFLOW_PROJECT_ROOT ??
  process.cwd();

// ─── Start MCP server ──────────────────────────────────────────
const server = createServer(projectRoot);
const transport = new StdioServerTransport();

// All logging must go to stderr (stdout is the MCP JSON-RPC channel)
console.error(`[mflow-mcp] Starting server for project: ${projectRoot}`);

server.server.onerror = (error: Error) => {
  console.error("[mflow-mcp] Server error:", error.message);
};

process.on("SIGINT", async () => {
  console.error("[mflow-mcp] Shutting down...");
  await server.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await server.close();
  process.exit(0);
});

await server.connect(transport);
console.error("[mflow-mcp] Server connected and ready.");
