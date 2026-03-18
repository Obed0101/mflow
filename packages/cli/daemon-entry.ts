#!/usr/bin/env bun
/**
 * Daemon entry point — spawned by `mflow start` as a detached process.
 * Wires MflowDaemon + WeriftTransport + IPCServer together.
 */

import { MflowDaemon } from "../daemon/src/daemon.js";
import { IPCServer, type IPCHandler } from "../daemon/src/ipc.js";
import { WSRelayTransport } from "../daemon/src/ws-relay-transport.js";
import type { IPCResponse } from "@mflow/shared";
import {
  DEFAULT_SIGNALING_URL,
  RECONNECT_MAX_DELAY_MS,
  MFLOW_SOCK_FILE,
} from "@mflow/shared";
import { hostname } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

// ─── Parse Args ──────────────────────────────────────────────

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    root: { type: "string", default: process.env["MFLOW_PROJECT_ROOT"] ?? process.cwd() },
    room: { type: "string", default: process.env["MFLOW_ROOM"] ?? "" },
    secret: { type: "string", default: process.env["MFLOW_SECRET"] ?? "" },
    signaling: { type: "string", default: process.env["MFLOW_SIGNALING"] ?? DEFAULT_SIGNALING_URL },
  },
});

const projectRoot = values.root!;
const roomId = values.room!;
const secret = values.secret!;
const signalingUrl = values.signaling!;
const peerId = crypto.randomUUID();
const peerName = `${hostname()}-${process.pid}`;

// ─── Create Transport ────────────────────────────────────────

const transport = new WSRelayTransport({
  peerId,
  peerName,
  peerType: "agent",
  signalingUrl,
  reconnectMaxDelayMs: RECONNECT_MAX_DELAY_MS,
});

// ─── Create Daemon ───────────────────────────────────────────

const daemon = new MflowDaemon({
  projectRoot,
  roomId,
  secret,
  peerName,
  peerType: "auto",
  signalingUrl,
  transport,
});

// ─── IPC Handler Adapter ─────────────────────────────────────

const ipcHandler: IPCHandler = {
  async handleStatus(): Promise<IPCResponse> {
    return { type: "status", data: daemon.getStatus() };
  },
  async handlePause(): Promise<IPCResponse> {
    daemon.pause();
    return { type: "ok" };
  },
  async handleResume(): Promise<IPCResponse> {
    daemon.resume();
    return { type: "ok" };
  },
  async handleStop(): Promise<IPCResponse> {
    // Schedule stop after responding
    setTimeout(() => void daemon.stop(), 100);
    return { type: "ok" };
  },
  async handleIgnore(_pattern: string): Promise<IPCResponse> {
    // TODO: forward to watcher via sync orchestrator
    return { type: "ok" };
  },
  async handlePeers(): Promise<IPCResponse> {
    return { type: "peers", data: daemon.getPeers() };
  },
  async handleHealth(): Promise<IPCResponse> {
    return { type: "status", data: daemon.getStatus() };
  },
};

// ─── Create IPC Server ──────────────────────────────────────

const socketPath = join(projectRoot, MFLOW_SOCK_FILE);
const ipc = new IPCServer({ socketPath });

// ─── Start ───────────────────────────────────────────────────

async function main() {
  try {
    await ipc.start(ipcHandler);
    await daemon.start();

    daemon.on("error", (err: Error) => {
      console.error(`[mflow daemon] Error: ${err.message}`);
    });

    daemon.on("stopped", () => {
      void ipc.stop();
      process.exit(0);
    });

    console.log(`[mflow daemon] Running — room: ${roomId || "auto"}, PID: ${process.pid}`);
  } catch (err) {
    console.error(`[mflow daemon] Failed to start: ${(err as Error).message}`);
    await ipc.stop().catch(() => {});
    process.exit(1);
  }
}

main();
