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

interface ActivityEntry {
  timestamp: number;
  peerId: string;
  peerName: string;
  peerType: "agent" | "human";
  action: "synced" | "created" | "deleted";
  file: string;
}

interface Room {
  id: string;
  secretHash: string;
  peers: Map<string, { ws: WebSocket; info: PeerInfo }>;
  createdAt: number;
  activity: ActivityEntry[];
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
const MAX_ACTIVITY_ENTRIES = 50;

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
    room = { id: roomId, secretHash, peers: new Map(), createdAt: Date.now(), activity: [] };
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

function getPeerInfo(ws: WebSocket): PeerInfo | null {
  for (const room of rooms.values()) {
    for (const peer of room.peers.values()) {
      if (peer.ws === ws) return peer.info;
    }
  }
  return null;
}

function getRoomPeers(roomId: string): Array<{ ws: WebSocket; peerId: string }> {
  const room = rooms.get(roomId);
  if (!room) return [];
  return Array.from(room.peers.entries()).map(([peerId, p]) => ({ ws: p.ws, peerId }));
}

function addActivity(roomId: string, entry: ActivityEntry): void {
  const room = rooms.get(roomId);
  if (!room) return;
  room.activity.push(entry);
  if (room.activity.length > MAX_ACTIVITY_ENTRIES) {
    room.activity.shift();
  }
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

function validateActivityMessage(
  data: Record<string, unknown>,
): { ok: true; action: "synced" | "created" | "deleted"; file: string } | { ok: false; error: string } {
  const { action, file } = data;
  if (action !== "synced" && action !== "created" && action !== "deleted") {
    return { ok: false, error: "action must be 'synced', 'created', or 'deleted'" };
  }
  if (typeof file !== "string" || file.length === 0 || file.length > 1024) {
    return { ok: false, error: "file must be a non-empty string (max 1024 chars)" };
  }
  return { ok: true, action, file };
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

    case "activity": {
      const actValidated = validateActivityMessage(data);
      if (!actValidated.ok) {
        sendError(ws, "INVALID_MESSAGE", actValidated.error);
        return;
      }

      const roomId = getPeerRoomId(ws);
      if (!roomId) return;

      const info = getPeerInfo(ws);
      if (!info) return;

      addActivity(roomId, {
        timestamp: Date.now(),
        peerId: info.peerId,
        peerName: info.peerName,
        peerType: info.peerType,
        action: actValidated.action,
        file: actValidated.file,
      });
      break;
    }

    default:
      sendError(ws, "INVALID_MESSAGE", `Unknown type: ${type}`);
  }
}

// ─── Room Details ────────────────────────────────────────────

function getRoomDetails(): Array<{ id: string; peerCount: number; createdAt: number; peers: PeerInfo[] }> {
  const details: Array<{ id: string; peerCount: number; createdAt: number; peers: PeerInfo[] }> = [];
  for (const room of rooms.values()) {
    const peers: PeerInfo[] = Array.from(room.peers.values()).map((p) => p.info);
    details.push({
      id: room.id,
      peerCount: room.peers.size,
      createdAt: room.createdAt,
      peers,
    });
  }
  return details;
}

function getRoomDetailsBySecretHash(hash: string): Array<{ id: string; peerCount: number; createdAt: number; peers: PeerInfo[]; activity: ActivityEntry[] }> {
  const details: Array<{ id: string; peerCount: number; createdAt: number; peers: PeerInfo[]; activity: ActivityEntry[] }> = [];
  for (const room of rooms.values()) {
    if (room.secretHash !== hash) continue;
    const peers: PeerInfo[] = Array.from(room.peers.values()).map((p) => p.info);
    details.push({
      id: room.id,
      peerCount: room.peers.size,
      createdAt: room.createdAt,
      peers,
      activity: room.activity,
    });
  }
  return details;
}

// ─── Dashboard HTML ──────────────────────────────────────────

function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>mflow signaling server</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #0a0a0a; color: #fafafa;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 14px; line-height: 1.5; min-height: 100vh; padding: 24px;
    }
    .mono { font-family: 'JetBrains Mono', 'Fira Code', monospace; }
    .container { max-width: 760px; margin: 0 auto; }
    .header {
      background: #141414; border: 1px solid #1e1e1e; border-radius: 8px;
      padding: 20px 24px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.3);
    }
    .header-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
    .header-title { display: flex; align-items: center; gap: 10px; }
    .header h1 { font-size: 15px; font-weight: 600; color: #fafafa; letter-spacing: -0.01em; }
    .status-dot { width: 8px; height: 8px; border-radius: 50%; background: #10b981; box-shadow: 0 0 8px #10b98166; flex-shrink: 0; }
    .status-dot.warning { background: #eab308; box-shadow: 0 0 8px #eab30866; }
    .status-dot.error { background: #ef4444; box-shadow: 0 0 8px #ef444466; }
    .uptime-badge { font-size: 12px; color: #737373; font-family: 'JetBrains Mono', monospace; }
    .stats-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
    .stat-card { text-align: center; padding: 12px 8px; background: #0a0a0a; border: 1px solid #1e1e1e; border-radius: 6px; }
    .stat-value { font-size: 24px; font-weight: 700; color: #fafafa; font-family: 'JetBrains Mono', monospace; line-height: 1.2; }
    .stat-label { font-size: 11px; color: #737373; text-transform: uppercase; letter-spacing: 0.05em; margin-top: 2px; }
    .access-bar { margin-bottom: 12px; }
    .login-row { display: flex; gap: 8px; align-items: center; }
    .login-row input {
      flex: 1; background: #141414; border: 1px solid #1e1e1e; border-radius: 6px;
      padding: 8px 12px; color: #fafafa; font-family: 'Inter', sans-serif; font-size: 13px;
      outline: none; transition: border-color 0.15s;
    }
    .login-row input:focus { border-color: #10b981; box-shadow: 0 0 0 2px #10b98120; }
    .login-row input::placeholder { color: #404040; }
    .btn {
      background: #1e1e1e; border: 1px solid #2a2a2a; border-radius: 6px; padding: 8px 16px;
      color: #fafafa; font-family: 'Inter', sans-serif; font-size: 13px; font-weight: 500;
      cursor: pointer; white-space: nowrap; transition: background 0.15s, border-color 0.15s;
    }
    .btn:hover { background: #2a2a2a; border-color: #333; }
    .btn-primary { background: #065f46; border-color: #10b981; color: #10b981; }
    .btn-primary:hover { background: #047857; }
    .room-badge {
      display: flex; align-items: center; gap: 10px; padding: 6px 12px;
      background: #141414; border: 1px solid #1e1e1e; border-radius: 6px; font-size: 13px;
    }
    .room-badge-dot { width: 6px; height: 6px; border-radius: 50%; background: #10b981; flex-shrink: 0; }
    .room-badge-name { color: #fafafa; font-family: 'JetBrains Mono', monospace; font-size: 12px; }
    .room-badge-close {
      background: none; border: none; color: #737373; font-size: 16px; cursor: pointer;
      padding: 0 0 0 4px; line-height: 1; font-family: 'Inter', sans-serif;
    }
    .room-badge-close:hover { color: #ef4444; }
    .card {
      background: #141414; border: 1px solid #1e1e1e; border-radius: 8px;
      padding: 20px 24px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.3);
    }
    .card-title { font-size: 11px; font-weight: 600; color: #737373; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 14px; }
    .room-info { display: flex; flex-wrap: wrap; align-items: center; gap: 16px; margin-bottom: 14px; font-size: 13px; }
    .room-name { font-weight: 600; color: #fafafa; font-family: 'JetBrains Mono', monospace; }
    .room-meta { color: #737373; font-family: 'JetBrains Mono', monospace; font-size: 12px; }
    .peers-row { display: flex; flex-wrap: wrap; gap: 8px; }
    .peer-pill {
      display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px;
      background: #0a0a0a; border: 1px solid #1e1e1e; border-radius: 16px; font-size: 12px; color: #fafafa;
    }
    .peer-pill-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
    .peer-pill-dot.agent { background: #06b6d4; }
    .peer-pill-dot.human { background: #10b981; }
    .peer-pill-type { color: #737373; font-size: 11px; }
    .peer-pill-type.agent { color: #06b6d4; }
    .peer-pill-type.human { color: #10b981; }
    .activity-feed { max-height: 440px; overflow-y: auto; scrollbar-width: thin; scrollbar-color: #1e1e1e transparent; }
    .activity-feed::-webkit-scrollbar { width: 4px; }
    .activity-feed::-webkit-scrollbar-track { background: transparent; }
    .activity-feed::-webkit-scrollbar-thumb { background: #1e1e1e; border-radius: 2px; }
    .activity-row {
      display: grid; grid-template-columns: 60px 1fr auto auto; gap: 12px; align-items: center;
      padding: 8px 0; border-bottom: 1px solid #1a1a1a; font-size: 13px;
      opacity: 1; transition: opacity 0.3s, border-color 0.5s;
    }
    .activity-row:last-child { border-bottom: none; }
    .activity-row.new-entry { border-left: 2px solid #10b981; padding-left: 8px; animation: flash-green 1s ease-out; }
    @keyframes flash-green { 0% { background: #10b98115; border-left-color: #10b981; } 100% { background: transparent; border-left-color: transparent; } }
    @keyframes fade-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
    .activity-row.entering { animation: fade-in 0.3s ease-out; }
    .activity-time { color: #404040; font-family: 'JetBrains Mono', monospace; font-size: 11px; text-align: right; }
    .activity-peer { color: #fafafa; font-family: 'JetBrains Mono', monospace; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .activity-action { font-size: 12px; font-weight: 500; }
    .activity-action.synced { color: #10b981; }
    .activity-action.created { color: #3b82f6; }
    .activity-action.deleted { color: #ef4444; }
    .activity-file {
      color: #737373; font-family: 'JetBrains Mono', monospace; font-size: 11px; text-align: right;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 200px; direction: rtl;
    }
    .empty-activity { color: #404040; font-size: 13px; text-align: center; padding: 32px 0; }
    .public-msg { color: #404040; font-size: 13px; text-align: center; padding: 32px 0; }
    .error-banner {
      display: none; background: #1a0a0a; border: 1px solid #3d1f1f; border-radius: 8px;
      padding: 10px 16px; margin-bottom: 12px; color: #ef4444; font-size: 13px;
    }
    .footer { display: flex; justify-content: space-between; align-items: center; padding: 10px 0; font-size: 12px; color: #404040; }
    .footer-refresh { color: #10b981; }
    .hidden { display: none !important; }
    @media (max-width: 600px) {
      body { padding: 12px; }
      .stats-row { grid-template-columns: repeat(2, 1fr); }
      .header, .card { padding: 16px; }
      .login-row { flex-direction: column; }
      .activity-row { grid-template-columns: 50px 1fr auto; }
      .activity-file { display: none; }
      .room-info { gap: 10px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="header-top">
        <div class="header-title">
          <span class="status-dot" id="status-dot"></span>
          <h1>mflow signaling</h1>
        </div>
        <span class="uptime-badge" id="uptime">--</span>
      </div>
      <div class="stats-row">
        <div class="stat-card"><div class="stat-value" id="room-count">-</div><div class="stat-label">Rooms</div></div>
        <div class="stat-card"><div class="stat-value" id="peer-count">-</div><div class="stat-label">Peers</div></div>
        <div class="stat-card"><div class="stat-value" id="memory">-</div><div class="stat-label">Memory</div></div>
        <div class="stat-card"><div class="stat-value" id="status-text">OK</div><div class="stat-label">Status</div></div>
      </div>
    </div>
    <div class="access-bar" id="access-bar">
      <div class="login-row" id="login-row">
        <input type="password" id="secret-input" placeholder="Room secret" autocomplete="off" aria-label="Room secret">
        <button class="btn btn-primary" id="login-btn" type="button">Connect</button>
      </div>
      <div class="login-row hidden" id="room-badge-row">
        <div class="room-badge" id="room-badge">
          <span class="room-badge-dot"></span>
          <span class="room-badge-name" id="room-badge-name">--</span>
          <button class="room-badge-close" id="logout-btn" type="button" aria-label="Disconnect">&times;</button>
        </div>
      </div>
    </div>
    <div class="error-banner" id="error-banner"></div>
    <div class="card hidden" id="room-card"><div id="rooms-container"></div></div>
    <div class="card hidden" id="activity-card">
      <div class="card-title">Activity</div>
      <div class="activity-feed" id="activity-feed"><div class="empty-activity">Waiting for activity...</div></div>
    </div>
    <div class="card" id="public-card"><div class="public-msg">Enter a room secret to view peers and activity</div></div>
    <div class="footer">
      <span>Updated <span id="last-updated">--</span></span>
      <span>Auto-refresh: <span class="footer-refresh">ON</span> (2s)</span>
    </div>
  </div>
  <script>
    (function() {
      var lastFetch = 0, consecutiveErrors = 0, mode = 'public', secretHash = null;
      var knownActivityIds = {}, activityCount = 0;

      function sha256(str) {
        return crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)).then(function(buf) {
          var arr = new Uint8Array(buf); var hex = '';
          for (var i = 0; i < arr.length; i++) hex += ('0' + arr[i].toString(16)).slice(-2);
          return hex;
        });
      }

      function loadSession() {
        try { var s = JSON.parse(sessionStorage.getItem('mflow_dash') || '{}');
          if (s.mode === 'room' && s.hash) { mode = 'room'; secretHash = s.hash; }
        } catch (_) {}
      }
      function saveSession() {
        try { if (mode === 'room') sessionStorage.setItem('mflow_dash', JSON.stringify({ mode: 'room', hash: secretHash }));
          else sessionStorage.removeItem('mflow_dash');
        } catch (_) {}
      }

      function formatUptime(sec) {
        if (sec < 60) return sec + 's';
        if (sec < 3600) return Math.floor(sec / 60) + 'm';
        return Math.floor(sec / 3600) + 'h ' + Math.floor((sec % 3600) / 60) + 'm';
      }
      function formatAge(ts) {
        var diff = Math.max(0, Math.floor((Date.now() - ts) / 1000));
        if (diff < 60) return diff + 's ago';
        if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
        return Math.floor(diff / 3600) + 'h ago';
      }
      function relativeTime(ts) {
        var diff = Math.max(0, Math.floor((Date.now() - ts) / 1000));
        if (diff < 60) return diff + 's ago';
        if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
        return Math.floor(diff / 3600) + 'h ago';
      }
      function esc(str) { var d = document.createElement('div'); d.textContent = str; return d.innerHTML; }

      function updateUI() {
        var loginRow = document.getElementById('login-row');
        var badgeRow = document.getElementById('room-badge-row');
        var roomCard = document.getElementById('room-card');
        var activityCard = document.getElementById('activity-card');
        var publicCard = document.getElementById('public-card');
        if (mode === 'room') {
          loginRow.classList.add('hidden'); badgeRow.classList.remove('hidden');
          roomCard.classList.remove('hidden'); activityCard.classList.remove('hidden');
          publicCard.classList.add('hidden');
        } else {
          loginRow.classList.remove('hidden'); badgeRow.classList.add('hidden');
          roomCard.classList.add('hidden'); activityCard.classList.add('hidden');
          publicCard.classList.remove('hidden');
        }
      }

      function renderRooms(data) {
        var container = document.getElementById('rooms-container');
        if (!data.rooms || data.rooms.length === 0) {
          container.innerHTML = '<div class="empty-activity">No active room</div>'; return;
        }
        var html = '';
        for (var i = 0; i < data.rooms.length; i++) {
          var room = data.rooms[i];
          document.getElementById('room-badge-name').textContent = room.id.substring(0, 8);
          html += '<div class="room-info">';
          html += '<span class="room-name">Room: ' + esc(room.id.substring(0, 8)) + '</span>';
          html += '<span class="room-meta">Age: ' + formatAge(room.createdAt) + '</span>';
          html += '<span class="room-meta">Peers: ' + room.peerCount + '</span></div>';
          html += '<div class="peers-row">';
          for (var j = 0; j < room.peers.length; j++) {
            var p = room.peers[j]; var tc = p.peerType === 'agent' ? 'agent' : 'human';
            html += '<div class="peer-pill"><span class="peer-pill-dot ' + tc + '"></span>';
            html += '<span class="peer-pill-type ' + tc + '">[' + esc(p.peerType) + ']</span> ';
            html += esc(p.peerName) + '</div>';
          }
          html += '</div>';
        }
        container.innerHTML = html;
      }

      function renderActivity(data) {
        var feed = document.getElementById('activity-feed');
        var entries = [];
        if (data.rooms) {
          for (var i = 0; i < data.rooms.length; i++) {
            var act = data.rooms[i].activity;
            if (act) { for (var j = 0; j < act.length; j++) entries.push(act[j]); }
          }
        }
        if (entries.length === 0) { feed.innerHTML = '<div class="empty-activity">Waiting for activity...</div>'; return; }
        entries.sort(function(a, b) { return b.timestamp - a.timestamp; });
        if (entries.length > 20) entries = entries.slice(0, 20);
        var html = '';
        for (var k = 0; k < entries.length; k++) {
          var e = entries[k]; var entryId = e.timestamp + ':' + e.peerId + ':' + e.file;
          var isNew = !knownActivityIds[entryId]; if (isNew) knownActivityIds[entryId] = true;
          var cls = 'activity-row';
          if (isNew && activityCount > 0) cls += ' new-entry entering';
          html += '<div class="' + cls + '">';
          html += '<span class="activity-time">' + relativeTime(e.timestamp) + '</span>';
          html += '<span class="activity-peer">' + esc(e.peerName) + '</span>';
          html += '<span class="activity-action ' + esc(e.action) + '">' + esc(e.action) + '</span>';
          html += '<span class="activity-file" title="' + esc(e.file) + '">' + esc(e.file) + '</span></div>';
        }
        feed.innerHTML = html; activityCount++;
      }

      function buildUrl() {
        if (mode === 'room' && secretHash) return '/api/rooms?secretHash=' + encodeURIComponent(secretHash);
        return '/api/rooms';
      }

      function refresh() {
        fetch(buildUrl()).then(function(res) {
          if (!res.ok) throw new Error('HTTP ' + res.status); return res.json();
        }).then(function(data) {
          consecutiveErrors = 0; lastFetch = Date.now();
          document.getElementById('status-dot').className = 'status-dot';
          document.getElementById('status-text').textContent = 'OK';
          document.getElementById('uptime').textContent = formatUptime(data.uptime);
          document.getElementById('room-count').textContent = data.totalRooms;
          document.getElementById('peer-count').textContent = data.totalPeers;
          document.getElementById('memory').textContent = (data.memoryMB || 0) + 'MB';
          document.getElementById('error-banner').style.display = 'none';
          if (mode === 'room') { renderRooms(data); renderActivity(data); }
        }).catch(function(err) {
          consecutiveErrors++;
          document.getElementById('status-dot').className = 'status-dot ' + (consecutiveErrors >= 3 ? 'error' : 'warning');
          document.getElementById('status-text').textContent = consecutiveErrors >= 3 ? 'ERR' : '...';
          var banner = document.getElementById('error-banner');
          banner.textContent = err.message; banner.style.display = 'block';
        });
      }

      function updateTimestamps() {
        if (lastFetch === 0) return;
        document.getElementById('last-updated').textContent = Math.floor((Date.now() - lastFetch) / 1000) + 's ago';
      }

      document.getElementById('login-btn').addEventListener('click', function() {
        var val = document.getElementById('secret-input').value.trim();
        if (!val) return;
        sha256(val).then(function(hash) {
          mode = 'room'; secretHash = hash; knownActivityIds = {}; activityCount = 0;
          saveSession(); updateUI(); refresh();
        });
      });
      document.getElementById('secret-input').addEventListener('keydown', function(e) {
        if (e.key === 'Enter') document.getElementById('login-btn').click();
      });
      document.getElementById('logout-btn').addEventListener('click', function() {
        mode = 'public'; secretHash = null; knownActivityIds = {}; activityCount = 0;
        saveSession(); updateUI(); document.getElementById('secret-input').value = '';
        document.getElementById('room-badge-name').textContent = '--'; refresh();
      });

      loadSession(); updateUI(); refresh();
      setInterval(refresh, 2000); setInterval(updateTimestamps, 1000);
    })();
  </script>
</body>
</html>`;
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

  // Dashboard
  if (url.pathname === "/dashboard" && req.method === "GET") {
    return new Response(getDashboardHtml(), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // Rooms API — scoped by auth level
  if (url.pathname === "/api/rooms" && req.method === "GET") {
    const secretHashParam = url.searchParams.get("secretHash");
    const uptime = Math.floor((Date.now() - startTime) / 1000);

    // Room-scoped: return only rooms matching secretHash
    if (secretHashParam) {
      const matched = getRoomDetailsBySecretHash(secretHashParam);
      let matchedPeers = 0;
      for (const r of matched) matchedPeers += r.peerCount;
      return Response.json({
        rooms: matched,
        totalRooms: matched.length,
        totalPeers: matchedPeers,
        uptime,
        memoryMB: 0,
      });
    }

    // Public: aggregate stats only — no room IDs, no peer names
    let totalPeers = 0;
    for (const room of rooms.values()) totalPeers += room.peers.size;
    return Response.json({
      totalRooms: rooms.size,
      totalPeers,
      uptime,
      memoryMB: 0,
    });
  }

  // Landing page (/ without WebSocket upgrade header)
  if (url.pathname === "/" && req.method === "GET" && !req.headers.get("upgrade")) {
    return new Response(getLandingHtml(), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
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

// ─── Landing Page HTML ──────────────────────────────────────
/**
 * Landing page HTML — generated by Google Stitch, served at /
 */
export function getLandingHtml(): string {
  return LANDING_HTML;
}

const LANDING_HTML = `
<!DOCTYPE html>

<html class="dark" lang="en"><head>
<meta charset="utf-8"/>
<meta content="width=device-width, initial-scale=1.0" name="viewport"/>
<title>mflow | Real-time code sync for AI agent teams</title>
<script src="https://cdn.tailwindcss.com?plugins=forms,container-queries"></script>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&amp;family=JetBrains+Mono:wght@400;500&amp;display=swap" rel="stylesheet"/>
<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght@100..700,0..1&amp;display=swap" rel="stylesheet"/>
<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&amp;display=swap" rel="stylesheet"/>
<script id="tailwind-config">
        tailwind.config = {
            darkMode: "class",
            theme: {
                extend: {
                    colors: {
                        "primary": "#10b981",
                        "background-light": "#f6f8f7",
                        "background-dark": "#0a0a0a",
                        "neutral-dark": "#171717",
                        "text-main": "#fafafa",
                        "text-muted": "#737373"
                    },
                    fontFamily: {
                        "display": ["Inter", "sans-serif"],
                        "mono": ["JetBrains Mono", "monospace"]
                    },
                    borderRadius: {
                        "DEFAULT": "0.25rem",
                        "lg": "0.5rem",
                        "xl": "0.75rem",
                        "full": "9999px"
                    },
                },
            },
        }
    </script>
</head>
<body class="bg-background-light dark:bg-background-dark font-display text-slate-900 dark:text-text-main antialiased selection:bg-primary/30">
<header class="fixed top-0 w-full z-50 border-b border-white/5 bg-background-dark/80 backdrop-blur-md">
<div class="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
<div class="flex items-center gap-2">
<span class="text-xl font-bold tracking-tight text-text-main">mflow</span>
</div>
<nav class="hidden md:flex items-center gap-8">
<a class="text-sm font-medium text-text-muted hover:text-primary transition-colors" href="#">GitHub</a>
<a class="text-sm font-medium text-text-muted hover:text-primary transition-colors" href="#">Docs</a>
<a class="text-sm font-medium text-text-muted hover:text-primary transition-colors" href="#">Monitor</a>
</nav>
<div class="flex items-center gap-4">
<button class="bg-primary hover:bg-primary/90 text-background-dark px-4 py-2 rounded-lg text-sm font-bold transition-all">
                    Get Started
                </button>
</div>
</div>
</header>
<main class="pt-32 pb-20">
<section class="max-w-7xl mx-auto px-6 mb-32">
<div class="grid lg:grid-cols-2 gap-16 items-center">
<div class="flex flex-col gap-8">
<h1 class="text-6xl md:text-7xl font-black tracking-tighter text-text-main leading-[1.1]">
                        Real-time code sync for AI agent teams
                    </h1>
<p class="text-lg md:text-xl text-text-muted leading-relaxed max-w-xl">
                        5 agents edit the same codebase simultaneously. Zero merge conflicts. Encrypted end-to-end.
                    </p>
<div class="flex flex-wrap gap-4">
<button class="bg-primary hover:bg-primary/90 text-background-dark px-8 py-4 rounded-xl text-base font-bold transition-all shadow-lg shadow-primary/10">
                            Get Started
                        </button>
<button class="border border-white/10 hover:border-primary/50 hover:bg-primary/5 text-text-main px-8 py-4 rounded-xl text-base font-bold transition-all">
                            View on GitHub
                        </button>
</div>
</div>
<div class="relative">
<div class="absolute -inset-1 bg-gradient-to-r from-primary/20 to-transparent blur-2xl opacity-50"></div>
<div class="relative bg-neutral-dark border border-white/10 rounded-xl overflow-hidden shadow-2xl">
<div class="flex items-center gap-1.5 px-4 py-3 border-b border-white/5 bg-white/5">
<div class="w-3 h-3 rounded-full bg-red-500/20 border border-red-500/50"></div>
<div class="w-3 h-3 rounded-full bg-yellow-500/20 border border-yellow-500/50"></div>
<div class="w-3 h-3 rounded-full bg-green-500/20 border border-green-500/50"></div>
<span class="ml-2 text-xs font-mono text-text-muted">bash — mflow</span>
</div>
<div class="p-6 font-mono text-sm leading-relaxed space-y-1">
<p class="text-text-main"><span class="text-primary">\$</span> mflow start --room my-project --secret my-secret</p>
<p class="text-primary">✓ Connected to room (2 peers)</p>
<p class="text-text-muted">↑ src/auth.ts synced → 3 peers</p>
<p class="text-text-muted">↑ src/routes.ts created → 2 peers</p>
<div class="h-4 w-2 bg-primary inline-block animate-pulse ml-1"></div>
</div>
</div>
</div>
</div>
</section>
<section class="max-w-7xl mx-auto px-6 mb-32">
<div class="mb-12">
<h2 class="text-3xl font-bold tracking-tight mb-4">How it works</h2>
<p class="text-text-muted">Experience seamless collaboration without version control overhead.</p>
</div>
<div class="grid md:grid-cols-3 gap-6">
<div class="bg-neutral-dark border border-white/5 p-8 rounded-2xl hover:border-primary/30 transition-colors group">
<span class="material-symbols-outlined text-primary mb-4 text-3xl group-hover:scale-110 transition-transform">sync_alt</span>
<h3 class="text-xl font-bold mb-3">Sync</h3>
<p class="text-text-muted leading-relaxed">File changes propagate in &lt;1 second between all peers. No git, no commits, no merges.</p>
</div>
<div class="bg-neutral-dark border border-white/5 p-8 rounded-2xl hover:border-primary/30 transition-colors group">
<span class="material-symbols-outlined text-primary mb-4 text-3xl group-hover:scale-110 transition-transform">encrypted</span>
<h3 class="text-xl font-bold mb-3">Encrypt</h3>
<p class="text-text-muted leading-relaxed">AES-256-GCM end-to-end. The server never sees your code. Only encrypted bytes pass through.</p>
</div>
<div class="bg-neutral-dark border border-white/5 p-8 rounded-2xl hover:border-primary/30 transition-colors group">
<span class="material-symbols-outlined text-primary mb-4 text-3xl group-hover:scale-110 transition-transform">lock_person</span>
<h3 class="text-xl font-bold mb-3">Prevent</h3>
<p class="text-text-muted leading-relaxed">Propagation gate automatically queues concurrent edits. File locks for coordinated workflows.</p>
</div>
</div>
</section>
<section class="max-w-7xl mx-auto px-6 mb-32">
<div class="bg-neutral-dark border border-white/5 rounded-3xl overflow-hidden">
<div class="grid lg:grid-cols-2">
<div class="p-12 flex flex-col justify-center gap-6">
<div>
<h2 class="text-3xl font-bold mb-4">Monitor your sync room</h2>
<p class="text-text-muted text-lg mb-6">See who's connected, what files are syncing, and activity in real-time through a centralized dashboard.</p>
<p class="font-mono text-sm text-primary/60 mb-8 break-all">https://mflow-signal.obed0101.deno.net/dashboard</p>
</div>
<button class="bg-primary hover:bg-primary/90 text-background-dark px-6 py-3 rounded-xl font-bold w-fit transition-all">
                            Open Monitor
                        </button>
</div>
<div class="bg-gradient-to-br from-neutral-dark to-primary/10 p-4 lg:p-12 relative overflow-hidden flex items-center justify-center min-h-[300px]" data-alt="Abstract UI dashboard representation with neon green accents">
<div class="w-full h-full rounded-xl bg-background-dark/60 border border-white/10 p-6 font-mono text-xs">
<div class="flex justify-between items-center mb-6">
<div class="text-primary">SIGNAL SERVER: ACTIVE</div>
<div class="text-text-muted">UPTIME: 99.9%</div>
</div>
<div class="space-y-3">
<div class="flex gap-4">
<span class="text-primary">[PEER 1]</span>
<span>agent-alpha connected</span>
</div>
<div class="flex gap-4">
<span class="text-primary">[SYNC]</span>
<span>main.py (4.2kb) → 4 peers</span>
</div>
<div class="flex gap-4">
<span class="text-primary">[LOCK]</span>
<span>db.ts locked by agent-beta</span>
</div>
<div class="flex gap-4 opacity-50">
<span class="text-primary">[PEER 2]</span>
<span>agent-gamma join request...</span>
</div>
</div>
</div>
</div>
</div>
</div>
</section>
<section class="max-w-7xl mx-auto px-6 mb-32">
<div class="mb-12">
<h2 class="text-3xl font-bold tracking-tight mb-4 text-center">Built for scale and security</h2>
</div>
<div class="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
<div class="p-6 rounded-2xl border border-white/5 bg-neutral-dark/40">
<h4 class="text-text-main font-bold mb-2">MCP Server</h4>
<p class="text-sm text-text-muted">Native support for Model Context Protocol to bridge AI tools and local files seamlessly.</p>
</div>
<div class="p-6 rounded-2xl border border-white/5 bg-neutral-dark/40">
<h4 class="text-text-main font-bold mb-2">File Locking</h4>
<p class="text-sm text-text-muted">Prevents race conditions by allowing agents to exclusively lock files during intensive tasks.</p>
</div>
<div class="p-6 rounded-2xl border border-white/5 bg-neutral-dark/40">
<h4 class="text-text-main font-bold mb-2">CLI Dashboard</h4>
<p class="text-sm text-text-muted">A full TUI experience directly in your terminal to monitor health and peer status.</p>
</div>
<div class="p-6 rounded-2xl border border-white/5 bg-neutral-dark/40">
<h4 class="text-text-main font-bold mb-2">Self-Hosted</h4>
<p class="text-sm text-text-muted">Run your own signal server on any infrastructure for maximum privacy and control.</p>
</div>
<div class="p-6 rounded-2xl border border-white/5 bg-neutral-dark/40">
<h4 class="text-text-main font-bold mb-2">Zero Config</h4>
<p class="text-sm text-text-muted">Start syncing in seconds with sensible defaults that work out of the box for any project.</p>
</div>
<div class="p-6 rounded-2xl border border-white/5 bg-neutral-dark/40">
<h4 class="text-text-main font-bold mb-2">Open Source</h4>
<p class="text-sm text-text-muted">MIT licensed core. Audit the code, contribute, or fork it to meet your team's unique needs.</p>
</div>
</div>
</section>
<section class="max-w-7xl mx-auto px-6 mb-32">
<h2 class="text-3xl font-bold tracking-tight mb-12 text-center">Quick Start</h2>
<div class="grid lg:grid-cols-3 gap-6">
<div class="flex flex-col gap-4">
<h3 class="text-sm font-bold text-primary uppercase tracking-wider">1. Install</h3>
<div class="bg-neutral-dark p-4 rounded-lg font-mono text-sm border border-white/10">
<span class="text-text-muted"># Using npm</span><br/>
<span class="text-text-main">npm i -g mflow</span>
</div>
</div>
<div class="flex flex-col gap-4">
<h3 class="text-sm font-bold text-primary uppercase tracking-wider">2. Start syncing</h3>
<div class="bg-neutral-dark p-4 rounded-lg font-mono text-sm border border-white/10">
<span class="text-text-muted"># From project root</span><br/>
<span class="text-text-main">mflow start --room project-x</span>
</div>
</div>
<div class="flex flex-col gap-4">
<h3 class="text-sm font-bold text-primary uppercase tracking-wider">3. Join room</h3>
<div class="bg-neutral-dark p-4 rounded-lg font-mono text-sm border border-white/10">
<span class="text-text-muted"># On another machine</span><br/>
<span class="text-text-main">mflow join --room project-x</span>
</div>
</div>
</div>
</section>
</main>
<footer class="border-t border-white/5 bg-neutral-dark/30 py-16">
<div class="max-w-7xl mx-auto px-6">
<div class="flex flex-col md:flex-row justify-between items-start gap-12 mb-12">
<div class="flex flex-col gap-4">
<span class="text-2xl font-bold tracking-tight text-text-main">mflow</span>
<p class="text-text-muted max-w-xs text-sm">Real-time collaboration for the next generation of AI development teams.</p>
</div>
<div class="grid grid-cols-2 md:grid-cols-3 gap-12">
<div class="flex flex-col gap-4">
<span class="text-xs font-bold text-text-main uppercase">Resources</span>
<a class="text-sm text-text-muted hover:text-primary transition-colors" href="#">GitHub</a>
<a class="text-sm text-text-muted hover:text-primary transition-colors" href="#">Documentation</a>
</div>
<div class="flex flex-col gap-4">
<span class="text-xs font-bold text-text-main uppercase">Product</span>
<a class="text-sm text-text-muted hover:text-primary transition-colors" href="#">Monitor</a>
<a class="text-sm text-text-muted hover:text-primary transition-colors" href="#">Changelog</a>
</div>
<div class="flex flex-col gap-4">
<span class="text-xs font-bold text-text-main uppercase">Legal</span>
<span class="text-sm text-text-muted">MIT License</span>
</div>
</div>
</div>
<div class="flex flex-col md:flex-row justify-between items-center pt-8 border-t border-white/5 gap-4">
<p class="text-sm text-text-muted">Made for AI agent teams.</p>
<div class="flex gap-6">
<span class="material-symbols-outlined text-text-muted hover:text-primary cursor-pointer text-xl">terminal</span>
<span class="material-symbols-outlined text-text-muted hover:text-primary cursor-pointer text-xl">share</span>
</div>
</div>
</div>
</footer>
</body></html>`;
