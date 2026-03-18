// ─── IPC Server (Unix Domain Socket for CLI <-> Daemon) ─────
//
// JSON-lines protocol over UDS at .mflow/daemon.sock.
// Each line is a complete JSON object (newline-delimited).

import { createServer, type Server, type Socket } from "node:net";
import { unlink, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { existsSync } from "node:fs";
import type { IPCRequest, IPCResponse } from "@mflow/shared";
import { IPCRequestSchema } from "@mflow/shared";

// ─── Types ──────────────────────────────────────────────────

export interface IPCServerOptions {
  socketPath: string;
}

export interface IPCHandler {
  handleStatus(): Promise<IPCResponse>;
  handlePause(): Promise<IPCResponse>;
  handleResume(): Promise<IPCResponse>;
  handleStop(): Promise<IPCResponse>;
  handleIgnore(pattern: string): Promise<IPCResponse>;
  handlePeers(): Promise<IPCResponse>;
  handleHealth(): Promise<IPCResponse>;
}

// ─── IPCServer ──────────────────────────────────────────────

export class IPCServer {
  private readonly socketPath: string;
  private server: Server | null = null;
  private connections: Set<Socket> = new Set();

  constructor(options: IPCServerOptions) {
    this.socketPath = options.socketPath;
  }

  /**
   * Start listening on the Unix Domain Socket.
   * Removes stale socket files from previous crashes.
   * Ensures the parent directory exists.
   */
  async start(handler: IPCHandler): Promise<void> {
    // Ensure parent directory exists
    const dir = dirname(this.socketPath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    // Remove stale socket file from a previous crash
    await this.removeSocketFile();

    return new Promise<void>((resolve, reject) => {
      const server = createServer((socket) => {
        this.handleConnection(socket, handler);
      });

      server.on("error", (err) => {
        if (!this.server) {
          // Error during startup
          reject(err);
        }
        // Runtime errors are silently handled — connections close themselves
      });

      server.listen(this.socketPath, () => {
        this.server = server;
        resolve();
      });
    });
  }

  /**
   * Stop the server, close all connections, and clean up the socket file.
   */
  async stop(): Promise<void> {
    // Close all active connections
    for (const socket of this.connections) {
      socket.destroy();
    }
    this.connections.clear();

    // Close the server
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => {
          resolve();
        });
      });
      this.server = null;
    }

    // Remove socket file
    await this.removeSocketFile();
  }

  /**
   * Handle a single client connection.
   * Buffers incoming data, splits on newlines, parses JSON, routes to handler.
   */
  private handleConnection(socket: Socket, handler: IPCHandler): void {
    this.connections.add(socket);

    let buffer = "";

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");

      // Process complete lines (newline-delimited JSON)
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);

        if (line.length === 0) {
          continue;
        }

        this.processLine(line, socket, handler);
      }
    });

    socket.on("close", () => {
      this.connections.delete(socket);
    });

    socket.on("error", () => {
      // Broken pipe, connection reset, etc. — just clean up
      this.connections.delete(socket);
    });
  }

  /**
   * Parse a single JSON line, validate it, route to the handler, and write the response.
   */
  private processLine(line: string, socket: Socket, handler: IPCHandler): void {
    void (async () => {
      let response: IPCResponse;

      try {
        // Parse JSON
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          response = { type: "error", message: "Invalid JSON" };
          this.writeResponse(socket, response);
          return;
        }

        // Validate against schema
        const result = IPCRequestSchema.safeParse(parsed);
        if (!result.success) {
          response = {
            type: "error",
            message: `Invalid request: ${result.error.issues.map((i) => i.message).join(", ")}`,
          };
          this.writeResponse(socket, response);
          return;
        }

        const request: IPCRequest = result.data;

        // Route to handler
        response = await this.routeRequest(request, handler);
      } catch (err) {
        response = {
          type: "error",
          message: err instanceof Error ? err.message : "Internal error",
        };
      }

      this.writeResponse(socket, response);
    })();
  }

  /**
   * Route a validated IPC request to the appropriate handler method.
   */
  private async routeRequest(
    request: IPCRequest,
    handler: IPCHandler,
  ): Promise<IPCResponse> {
    switch (request.type) {
      case "status":
        return handler.handleStatus();
      case "pause":
        return handler.handlePause();
      case "resume":
        return handler.handleResume();
      case "stop":
        return handler.handleStop();
      case "ignore":
        return handler.handleIgnore(request.pattern);
      case "peers":
        return handler.handlePeers();
      case "health":
        return handler.handleHealth();
    }
  }

  /**
   * Write a JSON response followed by a newline to the socket.
   * Silently ignores write errors (broken pipe).
   */
  private writeResponse(socket: Socket, response: IPCResponse): void {
    if (socket.writable) {
      socket.write(JSON.stringify(response) + "\n", (err) => {
        if (err) {
          // Broken pipe or closed socket — nothing to do
          socket.destroy();
        }
      });
    }
  }

  /**
   * Remove the socket file if it exists.
   */
  private async removeSocketFile(): Promise<void> {
    try {
      await unlink(this.socketPath);
    } catch (err) {
      // ENOENT is fine — file doesn't exist
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
  }
}
