/**
 * Mflow Signaling Server — Deno Deploy Edition
 *
 * Self-contained signaling server for Deno Deploy.
 * No external dependencies — all types and logic inlined.
 *
 * Deploy: deno deploy --project=mflow-signal deno-deploy.ts
 * Or link from https://dash.deno.com to this file in GitHub.
 */

// ─── Types ──────────────────────────────────────────────────

interface PeerInfo {
  peerId: string;
  peerName: string;
  peerType: "agent" | "human";
  joinedAt: number;
}

interface Room {
  id: string;
  secretHash: string;
  peers: Map<string, { ws: WebSocket; info: PeerInfo }>;
  createdAt: number;
}

// ─── Constants ──────────────────────────────────────────────

const MAX_PEERS_PER_ROOM = 10;
const RATE_LIMIT_JOINS_PER_MINUTE = 10;
const RATE_LIMIT_MESSAGES_PER_MINUTE = 100;
const RATE_LIMIT_MAX_VIOLATIONS = 3;
const MAX_MESSAGE_SIZE = 65_536; // 64KB
const MAX_STRING_LENGTH = 256;
const UNAUTHENTICATED_TIMEOUT_MS = 10_000;
const MAX_UNAUTHENTICATED_PER_IP = 5;
const MAX_UNAUTHENTICATED_GLOBAL = 500;

// ─── Room Manager ───────────────────────────────────────────

const rooms = new Map<string, Room>();

function joinRoom(
  ws: WebSocket,
  roomId: string,
  secretHash: string,
  peerId: string,
  peerName: string,
  peerType: "agent" | "human",
): { ok: boolean; code?: string; message?: string; peers?: PeerInfo[] } {
  let room = rooms.get(roomId);

  if (!room) {
    room = { id: roomId, secretHash, peers: new Map(), createdAt: Date.now() };
    rooms.set(roomId, room);
  }

  // Generic message to avoid leaking room existence
  if (room.secretHash !== secretHash) {
    return { ok: false, code: "AUTH_FAILED", message: "Unable to join room" };
  }

  // Reject duplicate peerId from a different socket
  if (room.peers.has(peerId)) {
    const existing = room.peers.get(peerId)!;
    if (existing.ws !== ws && existing.ws.readyState === WebSocket.OPEN) {
      return { ok: false, code: "PEER_ID_TAKEN", message: "Peer ID already in use in this room" };
    }
  }

  if (room.peers.size >= MAX_PEERS_PER_ROOM) {
    return { ok: false, code: "ROOM_FULL", message: `Room is full (max ${MAX_PEERS_PER_ROOM} peers)` };
  }

  const info: PeerInfo = { peerId, peerName, peerType, joinedAt: Date.now() };
  room.peers.set(peerId, { ws, info });

  const existingPeers = Array.from(room.peers.values())
    .filter((p) => p.info.peerId !== peerId)
    .map((p) => p.info);

  return { ok: true, peers: existingPeers };
}

function leaveRoom(ws: WebSocket): { peerId: string; roomId: string; remaining: WebSocket[] } | null {
  for (const [roomId, room] of rooms) {
    for (const [peerId, peer] of room.peers) {
      if (peer.ws === ws) {
        room.peers.delete(peerId);
        const remaining = Array.from(room.peers.values()).map((p) => p.ws);
        if (room.peers.size === 0) {
          rooms.delete(roomId);
        }
        return { peerId, roomId, remaining };
      }
    }
  }
  return null;
}

function findPeerWs(roomId: string, peerId: string): WebSocket | null {
  const room = rooms.get(roomId);
  if (!room) return null;
  return room.peers.get(peerId)?.ws ?? null;
}

function getPeerRoomId(ws: WebSocket): string | null {
  for (const [roomId, room] of rooms) {
    for (const peer of room.peers.values()) {
      if (peer.ws === ws) return roomId;
    }
  }
  return null;
}

function getRoomPeers(roomId: string): Array<{ ws: WebSocket; peerId: string }> {
  const room = rooms.get(roomId);
  if (!room) return [];
  return Array.from(room.peers.entries()).map(([peerId, p]) => ({ ws: p.ws, peerId }));
}

// ─── Rate Limiter ───────────────────────────────────────────

const joinCounts = new Map<string, { count: number; resetAt: number; violations: number }>();
const msgCounts = new Map<string, { count: number; resetAt: number; violations: number }>();

function checkRate(
  map: Map<string, { count: number; resetAt: number; violations: number }>,
  ip: string,
  limit: number,
): { allowed: boolean; shouldDisconnect: boolean } {
  const now = Date.now();
  let entry = map.get(ip);

  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + 60_000, violations: 0 };
    map.set(ip, entry);
  }

  entry.count++;

  if (entry.count > limit) {
    entry.violations++;
    return { allowed: false, shouldDisconnect: entry.violations >= RATE_LIMIT_MAX_VIOLATIONS };
  }

  return { allowed: true, shouldDisconnect: false };
}

// Cleanup every 60s — also resets violations when window expires
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of joinCounts) {
    if (now > entry.resetAt) joinCounts.delete(ip);
  }
  for (const [ip, entry] of msgCounts) {
    if (now > entry.resetAt) msgCounts.delete(ip);
  }
}, 60_000);

// ─── Input Validation ──────────────────────────────────────

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_STRING_LENGTH;
}

function validateJoinMessage(
  data: Record<string, unknown>,
): { ok: true; roomId: string; secretHash: string; peerId: string; peerName: string; peerType: "agent" | "human" } | { ok: false; error: string } {
  const { roomId, secretHash, peerId, peerName, peerType } = data;

  if (!isNonEmptyString(roomId)) return { ok: false, error: "roomId must be a non-empty string (max 256 chars)" };
  if (!isNonEmptyString(secretHash)) return { ok: false, error: "secretHash must be a non-empty string (max 256 chars)" };
  if (!isNonEmptyString(peerId)) return { ok: false, error: "peerId must be a non-empty string (max 256 chars)" };
  if (!isNonEmptyString(peerName)) return { ok: false, error: "peerName must be a non-empty string (max 256 chars)" };

  const validType = peerType === "agent" || peerType === "human" || peerType === undefined;
  if (!validType) return { ok: false, error: "peerType must be 'agent' or 'human'" };

  return { ok: true, roomId, secretHash, peerId, peerName, peerType: (peerType as "agent" | "human") ?? "human" };
}

function validateSignalMessage(
  data: Record<string, unknown>,
): { ok: true; to: string } | { ok: false; error: string } {
  if (!isNonEmptyString(data.to)) return { ok: false, error: "signal.to must be a non-empty string" };
  if (data.data === undefined) return { ok: false, error: "signal.data is required" };
  return { ok: true, to: data.to };
}

function validateRelayMessage(
  data: Record<string, unknown>,
): { ok: true; to: string } | { ok: false; error: string } {
  if (!isNonEmptyString(data.to) && data.to !== "*") return { ok: false, error: "relay.to must be a non-empty string or '*'" };
  return { ok: true, to: data.to as string };
}

// ─── Message Handling ───────────────────────────────────────

const startTime = Date.now();
const wsToIp = new Map<WebSocket, string>();
const wsToPeerId = new Map<WebSocket, string>();

// ─── Unauthenticated Connection Tracking ────────────────────

const unauthSockets = new Set<WebSocket>();
const unauthPerIp = new Map<string, number>();

function trackUnauthSocket(ws: WebSocket, ip: string): boolean {
  if (unauthSockets.size >= MAX_UNAUTHENTICATED_GLOBAL) return false;
  const current = unauthPerIp.get(ip) ?? 0;
  if (current >= MAX_UNAUTHENTICATED_PER_IP) return false;

  unauthSockets.add(ws);
  unauthPerIp.set(ip, current + 1);

  setTimeout(() => {
    if (unauthSockets.has(ws)) {
      ws.close(1008, "Authentication timeout");
    }
  }, UNAUTHENTICATED_TIMEOUT_MS);

  return true;
}

function removeFromUnauth(ws: WebSocket): void {
  if (unauthSockets.delete(ws)) {
    const ip = wsToIp.get(ws) ?? "unknown";
    const count = unauthPerIp.get(ip) ?? 1;
    if (count <= 1) {
      unauthPerIp.delete(ip);
    } else {
      unauthPerIp.set(ip, count - 1);
    }
  }
}

function sendError(ws: WebSocket, code: string, message: string): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "error", code, message }));
  }
}

function handleMessage(ws: WebSocket, raw: string): void {
  const ip = wsToIp.get(ws) ?? "unknown";

  // Message size check
  if (raw.length > MAX_MESSAGE_SIZE) {
    sendError(ws, "MESSAGE_TOO_LARGE", `Message exceeds ${MAX_MESSAGE_SIZE} bytes`);
    return;
  }

  const msgCheck = checkRate(msgCounts, ip, RATE_LIMIT_MESSAGES_PER_MINUTE);
  if (!msgCheck.allowed) {
    sendError(ws, "RATE_LIMITED", "Too many messages");
    if (msgCheck.shouldDisconnect) ws.close(1008, "Rate limit exceeded");
    return;
  }

  let data: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      sendError(ws, "INVALID_MESSAGE", "Expected JSON object");
      return;
    }
    data = parsed as Record<string, unknown>;
  } catch {
    sendError(ws, "INVALID_MESSAGE", "Invalid JSON");
    return;
  }

  if (typeof data.type !== "string") {
    sendError(ws, "INVALID_MESSAGE", "Missing or invalid message type");
    return;
  }

  const type = data.type;

  switch (type) {
    case "join": {
      const joinCheck = checkRate(joinCounts, ip, RATE_LIMIT_JOINS_PER_MINUTE);
      if (!joinCheck.allowed) {
        sendError(ws, "RATE_LIMITED", "Too many join attempts");
        if (joinCheck.shouldDisconnect) ws.close(1008, "Rate limit exceeded");
        return;
      }

      const validated = validateJoinMessage(data);
      if (!validated.ok) {
        sendError(ws, "INVALID_MESSAGE", validated.error);
        return;
      }

      const { roomId, secretHash, peerId, peerName, peerType } = validated;

      // Leave current room if in one
      const leaveResult = leaveRoom(ws);
      if (leaveResult) {
        const msg = JSON.stringify({ type: "peer-left", peerId: leaveResult.peerId });
        for (const peerWs of leaveResult.remaining) {
          if (peerWs.readyState === WebSocket.OPEN) peerWs.send(msg);
        }
      }

      const result = joinRoom(ws, roomId, secretHash, peerId, peerName, peerType);

      if (!result.ok) {
        sendError(ws, result.code!, result.message!);
        return;
      }

      wsToPeerId.set(ws, peerId);
      removeFromUnauth(ws);

      // Send joined to the new peer
      ws.send(JSON.stringify({ type: "joined", roomId, peers: result.peers }));

      // Notify existing peers
      const newPeerInfo: PeerInfo = { peerId, peerName, peerType, joinedAt: Date.now() };
      for (const peer of result.peers!) {
        const peerWs = findPeerWs(roomId, peer.peerId);
        if (peerWs && peerWs.readyState === WebSocket.OPEN) {
          peerWs.send(JSON.stringify({ type: "peer-joined", peer: newPeerInfo }));
        }
      }
      break;
    }

    case "signal": {
      const signalValidated = validateSignalMessage(data);
      if (!signalValidated.ok) {
        sendError(ws, "INVALID_MESSAGE", signalValidated.error);
        return;
      }

      const from = wsToPeerId.get(ws) ?? (isNonEmptyString(data.from) ? data.from : undefined);
      const roomId = getPeerRoomId(ws);
      if (!roomId || !from) return;

      const targetWs = findPeerWs(roomId, signalValidated.to);
      if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(JSON.stringify({ type: "signal", to: signalValidated.to, from, data: data.data }));
      }
      break;
    }

    case "relay": {
      const relayValidated = validateRelayMessage(data);
      if (!relayValidated.ok) {
        sendError(ws, "INVALID_MESSAGE", relayValidated.error);
        return;
      }

      const from = wsToPeerId.get(ws) ?? (isNonEmptyString(data.from) ? data.from : undefined);
      const roomId = getPeerRoomId(ws);
      if (!roomId || !from) return;

      const to = relayValidated.to;
      const relayMsg = JSON.stringify({ type: "relay", to, from, data: data.data });

      if (to === "*") {
        for (const peer of getRoomPeers(roomId)) {
          if (peer.peerId !== from && peer.ws.readyState === WebSocket.OPEN) {
            peer.ws.send(relayMsg);
          }
        }
      } else {
        const targetWs = findPeerWs(roomId, to);
        if (targetWs && targetWs.readyState === WebSocket.OPEN) {
          targetWs.send(relayMsg);
        }
      }
      break;
    }

    default:
      sendError(ws, "INVALID_MESSAGE", `Unknown type: ${type}`);
  }
}

// ─── Server ─────────────────────────────────────────────────

const PORT = parseInt(Deno.env.get("PORT") ?? "8787", 10);

Deno.serve({ port: PORT }, (req, info) => {
  const url = new URL(req.url);

  // Health endpoint
  if (url.pathname === "/health" && req.method === "GET") {
    let totalPeers = 0;
    for (const room of rooms.values()) totalPeers += room.peers.size;

    return Response.json({
      status: "ok",
      rooms: rooms.size,
      peers: totalPeers,
      uptime: Math.floor((Date.now() - startTime) / 1000),
      memoryMB: 0, // Deno Deploy doesn't expose RSS
    });
  }

  // WebSocket upgrade
  if (url.pathname === "/ws" || url.pathname === "/") {
    const upgrade = req.headers.get("upgrade")?.toLowerCase();
    if (upgrade !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const { socket, response } = Deno.upgradeWebSocket(req);
    const trustProxy = Deno.env.get("TRUST_PROXY") === "true";
    const forwardedIp = trustProxy
      ? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
      : undefined;
    const remoteIp = info.remoteAddr && "hostname" in info.remoteAddr
      ? (info.remoteAddr as { hostname: string }).hostname
      : "unknown";
    const ip = forwardedIp ?? remoteIp;

    wsToIp.set(socket, ip);

    socket.onopen = () => {
      if (!trackUnauthSocket(socket, ip)) {
        socket.close(1008, "Too many unauthenticated connections");
      }
    };

    socket.onmessage = (event) => {
      handleMessage(socket, typeof event.data === "string" ? event.data : String(event.data));
    };

    socket.onclose = () => {
      removeFromUnauth(socket);
      const result = leaveRoom(socket);
      if (result) {
        const msg = JSON.stringify({ type: "peer-left", peerId: result.peerId });
        for (const peerWs of result.remaining) {
          if (peerWs.readyState === WebSocket.OPEN) peerWs.send(msg);
        }
      }
      wsToIp.delete(socket);
      wsToPeerId.delete(socket);
    };

    return response;
  }

  return new Response("Not Found", { status: 404 });
});

console.log(`mflow signaling server listening on port ${PORT}`);
