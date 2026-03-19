import type { ServerWebSocket } from "bun";
import {
  SignalingJoinSchema,
  SignalingSignalSchema,
  SignalingRelaySchema,
  UNAUTHENTICATED_TIMEOUT_MS,
  MAX_UNAUTHENTICATED_PER_IP,
  MAX_UNAUTHENTICATED_GLOBAL,
} from "@mflow/shared";
import type { HealthResponse } from "@mflow/shared";
import { RoomManager, type PeerContext } from "./rooms.js";
import { RateLimiter } from "./ratelimit.js";
import { relaySignal, relayData } from "./relay.js";

// ─── State ──────────────────────────────────────────────────

const rooms = new RoomManager();
const rateLimiter = new RateLimiter();
const startTime = Date.now();

// ─── Unauthenticated Connection Tracking ────────────────────

const unauthSockets = new Set<ServerWebSocket<PeerContext>>();
const unauthPerIp = new Map<string, number>();

function trackUnauthSocket(ws: ServerWebSocket<PeerContext>): boolean {
  const ip = ws.data.ip;

  // Global cap
  if (unauthSockets.size >= MAX_UNAUTHENTICATED_GLOBAL) {
    return false;
  }

  // Per-IP cap
  const current = unauthPerIp.get(ip) ?? 0;
  if (current >= MAX_UNAUTHENTICATED_PER_IP) {
    return false;
  }

  unauthSockets.add(ws);
  unauthPerIp.set(ip, current + 1);

  // Auto-close after timeout if still unauthenticated
  setTimeout(() => {
    if (unauthSockets.has(ws)) {
      ws.close(1008, "Authentication timeout");
    }
  }, UNAUTHENTICATED_TIMEOUT_MS);

  return true;
}

function promoteFromUnauth(ws: ServerWebSocket<PeerContext>): void {
  if (unauthSockets.delete(ws)) {
    const ip = ws.data.ip;
    const count = unauthPerIp.get(ip) ?? 1;
    if (count <= 1) {
      unauthPerIp.delete(ip);
    } else {
      unauthPerIp.set(ip, count - 1);
    }
  }
}

function removeFromUnauth(ws: ServerWebSocket<PeerContext>): void {
  promoteFromUnauth(ws);
}

// ─── Helpers ────────────────────────────────────────────────

function sendError(
  ws: ServerWebSocket<PeerContext>,
  code: string,
  message: string,
): void {
  ws.send(JSON.stringify({ type: "error", code, message }));
}

function getIp(ws: ServerWebSocket<PeerContext>): string {
  return ws.data.ip;
}

// ─── Message Handler ────────────────────────────────────────

function handleMessage(
  ws: ServerWebSocket<PeerContext>,
  raw: string | Buffer,
): void {
  const ip = getIp(ws);

  // Rate limit messages
  const msgCheck = rateLimiter.checkMessage(ip);
  if (!msgCheck.allowed) {
    sendError(ws, "RATE_LIMITED", "Too many messages — slow down");
    if (msgCheck.shouldDisconnect) {
      ws.close(1008, "Rate limit exceeded");
    }
    return;
  }

  // Parse JSON
  let data: unknown;
  try {
    data = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf-8"));
  } catch {
    sendError(ws, "INVALID_MESSAGE", "Invalid JSON");
    return;
  }

  if (!data || typeof data !== "object" || !("type" in data)) {
    sendError(ws, "INVALID_MESSAGE", "Missing message type");
    return;
  }

  const msgType = (data as { type: string }).type;

  switch (msgType) {
    case "join":
      handleJoin(ws, data);
      break;
    case "signal":
      handleSignal(ws, data);
      break;
    case "relay":
      handleRelay(ws, data);
      break;
    default:
      sendError(ws, "INVALID_MESSAGE", `Unknown message type: ${msgType}`);
  }
}

// ─── Join Handler ───────────────────────────────────────────

function handleJoin(ws: ServerWebSocket<PeerContext>, data: unknown): void {
  const ip = getIp(ws);

  // Rate limit joins
  const joinCheck = rateLimiter.checkJoin(ip);
  if (!joinCheck.allowed) {
    sendError(ws, "RATE_LIMITED", "Too many join attempts — slow down");
    if (joinCheck.shouldDisconnect) {
      ws.close(1008, "Rate limit exceeded");
    }
    return;
  }

  // Validate schema
  const parsed = SignalingJoinSchema.safeParse(data);
  if (!parsed.success) {
    sendError(ws, "INVALID_MESSAGE", `Invalid join message: ${parsed.error.message}`);
    return;
  }

  const { roomId, secretHash, peerId, peerName, peerType } = parsed.data;

  // Leave current room if already in one
  const leaveResult = rooms.leave(ws);
  if (leaveResult) {
    notifyPeerLeft(leaveResult.peerId, leaveResult.remainingPeers);
  }

  // Join room
  const result = rooms.join(ws, roomId, secretHash, peerId, peerName, peerType);

  if (!result.ok) {
    sendError(ws, result.code, result.message);
    return;
  }

  // Successfully authenticated — remove from unauthenticated tracking
  promoteFromUnauth(ws);

  // Send joined response to the new peer
  ws.send(
    JSON.stringify({
      type: "joined",
      roomId,
      peers: result.peers,
    }),
  );

  // Notify existing peers about the new peer
  const newPeerInfo = {
    peerId,
    peerName,
    peerType,
    joinedAt: Date.now(),
  };

  for (const peer of result.peers) {
    const peerWs = rooms.findPeer(roomId, peer.peerId);
    if (peerWs) {
      peerWs.send(
        JSON.stringify({
          type: "peer-joined",
          peer: newPeerInfo,
        }),
      );
    }
  }
}

// ─── Signal Handler ─────────────────────────────────────────

function handleSignal(ws: ServerWebSocket<PeerContext>, data: unknown): void {
  const parsed = SignalingSignalSchema.safeParse(data);
  if (!parsed.success) {
    sendError(ws, "INVALID_MESSAGE", `Invalid signal message: ${parsed.error.message}`);
    return;
  }

  const result = relaySignal(rooms, ws, parsed.data);
  if (!result.ok) {
    sendError(ws, result.code, result.message);
  }
}

// ─── Relay Handler ──────────────────────────────────────────

function handleRelay(ws: ServerWebSocket<PeerContext>, data: unknown): void {
  const parsed = SignalingRelaySchema.safeParse(data);
  if (!parsed.success) {
    sendError(ws, "INVALID_MESSAGE", `Invalid relay message: ${parsed.error.message}`);
    return;
  }

  const result = relayData(rooms, ws, parsed.data);
  if (!result.ok) {
    sendError(ws, result.code, result.message);
  }
}

// ─── Peer Left Notification ─────────────────────────────────

function notifyPeerLeft(
  peerId: string,
  remainingPeers: ServerWebSocket<PeerContext>[],
): void {
  const msg = JSON.stringify({ type: "peer-left", peerId });
  for (const peerWs of remainingPeers) {
    peerWs.send(msg);
  }
}

// ─── Server ─────────────────────────────────────────────────

const PORT = parseInt(process.env["PORT"] ?? "8787", 10);

const server = Bun.serve<PeerContext>({
  port: PORT,

  fetch(req, server) {
    const url = new URL(req.url);

    // Health endpoint
    if (url.pathname === "/health" && req.method === "GET") {
      const body: HealthResponse = {
        status: "ok",
        rooms: rooms.getRoomCount(),
        peers: rooms.getTotalPeerCount(),
        uptime: Math.floor((Date.now() - startTime) / 1000),
        memoryMB: Math.round(process.memoryUsage.rss() / 1_048_576),
      };
      return Response.json(body);
    }

    // WebSocket upgrade
    if (url.pathname === "/ws" || url.pathname === "/") {
      const trustProxy = process.env["TRUST_PROXY"] === "true";
      const forwardedIp = trustProxy
        ? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
        : undefined;
      const ip = forwardedIp ?? server.requestIP(req)?.address ?? "unknown";

      const upgraded = server.upgrade(req, {
        data: {
          peerId: "",
          peerName: "",
          peerType: "human" as const,
          roomId: null,
          ip,
        },
      });

      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    return new Response("Not Found", { status: 404 });
  },

  websocket: {
    open(ws) {
      if (!trackUnauthSocket(ws)) {
        ws.close(1008, "Too many unauthenticated connections");
      }
    },

    message(ws, raw) {
      handleMessage(ws, raw);
    },

    close(ws) {
      removeFromUnauth(ws);
      const result = rooms.leave(ws);
      if (result) {
        notifyPeerLeft(result.peerId, result.remainingPeers);
      }
    },
  },
});

rateLimiter.start();

console.log(`mflow signaling server listening on port ${server.port}`);

export { server };
