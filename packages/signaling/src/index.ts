import type { ServerWebSocket } from "bun";
import {
  SignalingJoinSchema,
  SignalingSignalSchema,
  SignalingRelaySchema,
  SignalingActivitySchema,
} from "@mflow/shared";
import type { HealthResponse, ActivityEntry } from "@mflow/shared";
import { RoomManager, type PeerContext } from "./rooms.js";
import { RateLimiter } from "./ratelimit.js";
import { relaySignal, relayData } from "./relay.js";
import { getDashboardHtml } from "./dashboard-html.js";
import { getLandingHtml } from "./landing-html.js";
import { loadSignalingLimits } from "./limits.js";
import { getDashboardUser, handleAuthRequest, loadDashboardAuthConfig } from "./dashboard-auth.js";

// ─── State ──────────────────────────────────────────────────

const limits = loadSignalingLimits();
const dashboardAuth = loadDashboardAuthConfig();
const rooms = new RoomManager(limits);
const rateLimiter = new RateLimiter(limits);
const startTime = Date.now();
const idleCleanupTimer = setInterval(() => rooms.cleanupIdleRooms(), 60_000);

// ─── Unauthenticated Connection Tracking ────────────────────

const unauthSockets = new Set<ServerWebSocket<PeerContext>>();
const unauthPerIp = new Map<string, number>();

function trackUnauthSocket(ws: ServerWebSocket<PeerContext>): boolean {
  const ip = ws.data.ip;

  // Global cap
  if (unauthSockets.size >= limits.maxUnauthenticatedSocketsGlobal) {
    return false;
  }

  // Per-IP cap
  const current = unauthPerIp.get(ip) ?? 0;
  if (current >= limits.maxUnauthenticatedSocketsPerIp) {
    return false;
  }

  unauthSockets.add(ws);
  unauthPerIp.set(ip, current + 1);

  // Auto-close after timeout if still unauthenticated
  setTimeout(() => {
    if (unauthSockets.has(ws)) {
      ws.close(1008, "Authentication timeout");
    }
  }, limits.unauthenticatedTimeoutMs);

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
  // Pre-parse size check — reject oversized messages before JSON.parse
  const rawLen = typeof raw === "string" ? raw.length : raw.byteLength;
  if (rawLen > limits.maxWebSocketMessageBytes) {
    sendError(ws, "MESSAGE_TOO_LARGE", `Message exceeds ${limits.maxWebSocketMessageBytes} bytes`);
    return;
  }

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
    case "activity":
      handleActivity(ws, data);
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
  if (ws.data.roomId) rooms.touchRoom(ws.data.roomId);
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
  if (ws.data.roomId) rooms.touchRoom(ws.data.roomId);
  if (!result.ok) {
    sendError(ws, result.code, result.message);
  }
}

// ─── Activity Handler ───────────────────────────────────────

function handleActivity(ws: ServerWebSocket<PeerContext>, data: unknown): void {
  const parsed = SignalingActivitySchema.safeParse(data);
  if (!parsed.success) {
    sendError(ws, "INVALID_MESSAGE", `Invalid activity message: ${parsed.error.message}`);
    return;
  }

  const { roomId, peerId, peerName, peerType } = ws.data;
  if (!roomId) return; // Must be in a room

  const entry: ActivityEntry = {
    timestamp: Date.now(),
    peerId,
    peerName,
    peerType,
    action: parsed.data.action,
    file: parsed.data.file,
  };

  rooms.addActivity(roomId, entry);
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

  async fetch(req, server) {
    const url = new URL(req.url);

    const authResponse = await handleAuthRequest(req, dashboardAuth);
    if (authResponse) return authResponse;

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

    // Dashboard
    if (url.pathname === "/dashboard" && req.method === "GET") {
      return new Response(getDashboardHtml(), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // Rooms API — scoped by auth level
    if (url.pathname === "/api/rooms" && req.method === "GET") {
      if (dashboardAuth.required && !getDashboardUser(req)) {
        return Response.json({ error: "GitHub sign-in required" }, { status: 401 });
      }

      const secretHash = url.searchParams.get("secretHash");
      const uptime = Math.floor((Date.now() - startTime) / 1000);
      const memoryMB = Math.round(process.memoryUsage.rss() / 1_048_576);

      // Room-scoped: return only rooms matching secretHash
      if (secretHash) {
        const matched = rooms.getRoomDetailsBySecretHash(secretHash);
        let matchedPeers = 0;
        for (const r of matched) matchedPeers += r.peerCount;
        return Response.json({
          rooms: matched,
          totalRooms: matched.length,
          totalPeers: matchedPeers,
          uptime,
          memoryMB,
        });
      }

      // Public: aggregate stats only — no room IDs, no peer names
      return Response.json({
        totalRooms: rooms.getRoomCount(),
        totalPeers: rooms.getTotalPeerCount(),
        uptime,
        memoryMB,
      });
    }

    // Landing page
    if (url.pathname === "/" && req.method === "GET") {
      // Only serve landing if NOT a WebSocket upgrade request
      if (!req.headers.get("upgrade")) {
        return new Response(getLandingHtml(), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
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
    maxPayloadLength: limits.maxWebSocketMessageBytes,

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

export { server, idleCleanupTimer };
