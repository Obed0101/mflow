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

function getRoomDetailsBySecretHash(hash: string): Array<{ id: string; peerCount: number; createdAt: number; peers: PeerInfo[] }> {
  const details: Array<{ id: string; peerCount: number; createdAt: number; peers: PeerInfo[] }> = [];
  for (const room of rooms.values()) {
    if (room.secretHash !== hash) continue;
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
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #0d1117; color: #c9d1d9;
      font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'SF Mono', monospace;
      font-size: 14px; line-height: 1.6; min-height: 100vh; padding: 24px;
    }
    .container { max-width: 720px; margin: 0 auto; }
    .header {
      border: 1px solid #21262d; border-radius: 8px;
      padding: 20px 24px; margin-bottom: 16px; background: #161b22;
    }
    .header h1 { font-size: 16px; font-weight: 700; color: #e6edf3; margin-bottom: 12px; }
    .status-row { display: flex; flex-wrap: wrap; gap: 8px 24px; font-size: 13px; }
    .status-item { display: flex; align-items: center; gap: 6px; }
    .status-label { color: #6b7280; }
    .status-value { color: #c9d1d9; }
    .dot {
      display: inline-block; width: 8px; height: 8px; border-radius: 50%;
      background: #22c55e; box-shadow: 0 0 6px #22c55e80;
    }
    .dot.warning { background: #eab308; box-shadow: 0 0 6px #eab30880; }
    .dot.error { background: #ef4444; box-shadow: 0 0 6px #ef444480; }
    .section {
      border: 1px solid #21262d; border-radius: 8px;
      padding: 20px 24px; margin-bottom: 16px; background: #161b22;
    }
    .section-title {
      font-size: 13px; font-weight: 600; color: #6b7280;
      text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 16px;
    }
    .auth-form { display: flex; gap: 8px; margin-bottom: 12px; align-items: center; }
    .auth-form input {
      flex: 1; background: #0d1117; border: 1px solid #30363d; border-radius: 6px;
      padding: 8px 12px; color: #c9d1d9; font-family: inherit; font-size: 13px; outline: none;
    }
    .auth-form input:focus { border-color: #58a6ff; box-shadow: 0 0 0 2px #58a6ff30; }
    .auth-form button, .btn {
      background: #21262d; border: 1px solid #30363d; border-radius: 6px;
      padding: 8px 16px; color: #c9d1d9; font-family: inherit; font-size: 13px; cursor: pointer; white-space: nowrap;
    }
    .auth-form button:hover, .btn:hover { background: #30363d; border-color: #484f58; }
    .btn-primary { background: #238636; border-color: #2ea043; color: #ffffff; }
    .btn-primary:hover { background: #2ea043; border-color: #3fb950; }
    .mode-badge {
      display: inline-block; padding: 2px 8px; border-radius: 12px;
      font-size: 11px; font-weight: 600; letter-spacing: 0.02em; margin-left: 8px; vertical-align: middle;
    }
    .mode-badge.public { background: #1f2937; color: #6b7280; border: 1px solid #374151; }
    .mode-badge.room { background: #0c2d1b; color: #3fb950; border: 1px solid #238636; }
    .logout-btn {
      font-size: 12px; color: #f85149; cursor: pointer; text-decoration: underline;
      text-underline-offset: 2px; background: none; border: none; font-family: inherit; padding: 0; margin-left: 12px;
    }
    .logout-btn:hover { color: #ff7b72; }
    .room { margin-bottom: 16px; padding-bottom: 16px; border-bottom: 1px solid #21262d; }
    .room:last-child { margin-bottom: 0; padding-bottom: 0; border-bottom: none; }
    .room-header { display: flex; flex-wrap: wrap; gap: 8px 20px; margin-bottom: 8px; font-size: 13px; }
    .room-id { color: #e6edf3; font-weight: 600; }
    .room-meta { color: #6b7280; }
    .peer { display: flex; align-items: center; gap: 8px; padding: 2px 0 2px 16px; font-size: 13px; }
    .peer-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; }
    .peer-dot.agent { background: #06b6d4; }
    .peer-dot.human { background: #22c55e; }
    .peer-name { color: #c9d1d9; }
    .peer-type { color: #6b7280; font-size: 12px; }
    .peer-type.agent { color: #06b6d4; }
    .peer-type.human { color: #22c55e; }
    .empty-state { color: #6b7280; font-style: italic; font-size: 13px; }
    .auth-msg { color: #6b7280; font-size: 13px; padding: 8px 0; }
    .auth-msg.error-msg { color: #f85149; }
    .footer {
      border: 1px solid #21262d; border-radius: 8px; padding: 12px 24px; background: #161b22;
      display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; font-size: 12px; color: #6b7280;
    }
    .refresh-on { color: #22c55e; }
    .error-banner {
      display: none; background: #1c1214; border: 1px solid #3d1f28; border-radius: 8px;
      padding: 12px 24px; margin-bottom: 16px; color: #ef4444; font-size: 13px;
    }
    .hidden { display: none !important; }
    @media (max-width: 480px) {
      body { padding: 12px; font-size: 13px; }
      .header, .section, .footer { padding: 16px; }
      .status-row { gap: 4px 16px; }
      .auth-form { flex-direction: column; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>mflow signaling server <span class="mode-badge public" id="mode-badge">PUBLIC</span></h1>
      <div class="status-row">
        <div class="status-item">
          <span class="status-label">Status:</span>
          <span class="dot" id="status-dot"></span>
          <span class="status-value" id="status-text">Running</span>
        </div>
        <div class="status-item">
          <span class="status-label">Uptime:</span>
          <span class="status-value" id="uptime">--</span>
        </div>
        <div class="status-item">
          <span class="status-label">Rooms:</span>
          <span class="status-value" id="room-count">--</span>
        </div>
        <div class="status-item">
          <span class="status-label">Peers:</span>
          <span class="status-value" id="peer-count">--</span>
        </div>
        <div class="status-item">
          <span class="status-label">Memory:</span>
          <span class="status-value" id="memory">--</span>
        </div>
      </div>
    </div>
    <div class="error-banner" id="error-banner"></div>
    <div class="section" id="auth-section">
      <div class="section-title">Access <span id="auth-status"></span></div>
      <div id="login-forms">
        <div id="room-login-form">
          <div class="auth-form">
            <input type="password" id="room-secret-input" placeholder="Enter room secret to view your room" autocomplete="off" aria-label="Room secret">
            <button class="btn btn-primary" id="room-login-btn" type="button">View Room</button>
          </div>
        </div>
      </div>
      <div id="logged-in-info" class="hidden">
        <div class="auth-msg" id="logged-in-msg"></div>
        <button class="logout-btn" id="logout-btn" type="button">Logout</button>
      </div>
    </div>
    <div class="section">
      <div class="section-title">Active Rooms</div>
      <div id="rooms-container"><div class="empty-state">Loading...</div></div>
    </div>
    <div class="footer">
      <span>Last updated: <span id="last-updated">--</span></span>
      <span>Auto-refresh: <span class="refresh-on">ON</span></span>
    </div>
  </div>
  <script>
    (function() {
      var lastFetch = 0;
      var consecutiveErrors = 0;
      var mode = 'public';
      var secretHash = null;

      function sha256(str) {
        var encoder = new TextEncoder();
        return crypto.subtle.digest('SHA-256', encoder.encode(str)).then(function(buf) {
          var arr = new Uint8Array(buf);
          var hex = '';
          for (var i = 0; i < arr.length; i++) {
            hex += ('0' + arr[i].toString(16)).slice(-2);
          }
          return hex;
        });
      }

      function loadSession() {
        try {
          var stored = sessionStorage.getItem('mflow_dash_mode');
          if (stored) {
            var s = JSON.parse(stored);
            if (s.mode === 'room' && s.secretHash) { mode = 'room'; secretHash = s.secretHash; }
          }
        } catch (_) {}
      }

      function saveSession() {
        try {
          if (mode === 'room') sessionStorage.setItem('mflow_dash_mode', JSON.stringify({ mode: 'room', secretHash: secretHash }));
          else sessionStorage.removeItem('mflow_dash_mode');
        } catch (_) {}
      }

      function formatUptime(seconds) {
        if (seconds < 60) return seconds + 's';
        if (seconds < 3600) return Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's';
        var h = Math.floor(seconds / 3600);
        var m = Math.floor((seconds % 3600) / 60);
        return h + 'h ' + m + 'm';
      }
      function formatAge(createdAt) {
        var diff = Math.floor((Date.now() - createdAt) / 1000);
        if (diff < 60) return diff + 's';
        if (diff < 3600) return Math.floor(diff / 60) + 'm';
        var h = Math.floor(diff / 3600);
        var m = Math.floor((diff % 3600) / 60);
        return h + 'h ' + m + 'm';
      }
      function escapeHtml(str) {
        var div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
      }

      function updateModeUI() {
        var badge = document.getElementById('mode-badge');
        var loginForms = document.getElementById('login-forms');
        var loggedInInfo = document.getElementById('logged-in-info');
        var loggedInMsg = document.getElementById('logged-in-msg');
        badge.className = 'mode-badge ' + mode;
        badge.textContent = mode.toUpperCase();
        if (mode === 'public') {
          loginForms.classList.remove('hidden');
          loggedInInfo.classList.add('hidden');
        } else {
          loginForms.classList.add('hidden');
          loggedInInfo.classList.remove('hidden');
          loggedInMsg.textContent = 'Viewing rooms matching your secret';
        }
      }

      function renderRooms(data) {
        var container = document.getElementById('rooms-container');
        if (mode === 'public') {
          container.innerHTML = '<div class="auth-msg">Enter a room secret to view room details.</div>';
          return;
        }
        if (!data.rooms || data.rooms.length === 0) {
          container.innerHTML = '<div class="empty-state">No active room with this secret</div>';
          return;
        }
        var html = '';
        for (var i = 0; i < data.rooms.length; i++) {
          var room = data.rooms[i];
          html += '<div class="room"><div class="room-header">';
          html += '<span class="room-id">Room: ' + escapeHtml(room.id.substring(0, 8)) + '</span>';
          html += '<span class="room-meta">Peers: ' + room.peerCount + '</span>';
          html += '<span class="room-meta">Age: ' + formatAge(room.createdAt) + '</span></div>';
          for (var j = 0; j < room.peers.length; j++) {
            var peer = room.peers[j];
            var tc = peer.peerType === 'agent' ? 'agent' : 'human';
            html += '<div class="peer"><span class="peer-dot ' + tc + '"></span>';
            html += '<span class="peer-name">' + escapeHtml(peer.peerName) + '</span>';
            html += '<span class="peer-type ' + tc + '">(' + escapeHtml(peer.peerType) + ')</span></div>';
          }
          html += '</div>';
        }
        container.innerHTML = html;
      }

      function buildApiUrl() {
        if (mode === 'room' && secretHash) return '/api/rooms?secretHash=' + encodeURIComponent(secretHash);
        return '/api/rooms';
      }

      function updateDashboard() {
        fetch(buildApiUrl())
          .then(function(res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
          })
          .then(function(data) {
            consecutiveErrors = 0; lastFetch = Date.now();
            document.getElementById('status-dot').className = 'dot';
            document.getElementById('status-text').textContent = 'Running';
            document.getElementById('uptime').textContent = formatUptime(data.uptime);
            document.getElementById('room-count').textContent = data.totalRooms;
            document.getElementById('peer-count').textContent = data.totalPeers;
            document.getElementById('memory').textContent = (data.memoryMB || 0) + 'MB';
            document.getElementById('error-banner').style.display = 'none';
            renderRooms(data);
          })
          .catch(function(err) {
            consecutiveErrors++;
            document.getElementById('status-dot').className = consecutiveErrors >= 3 ? 'dot error' : 'dot warning';
            document.getElementById('status-text').textContent = consecutiveErrors >= 3 ? 'Unreachable' : 'Retrying...';
            var banner = document.getElementById('error-banner');
            banner.textContent = 'Failed to fetch: ' + err.message;
            banner.style.display = 'block';
          });
      }
      function updateTimestamp() {
        if (lastFetch === 0) return;
        var ago = Math.floor((Date.now() - lastFetch) / 1000);
        document.getElementById('last-updated').textContent = ago + 's ago';
      }

      document.getElementById('room-login-btn').addEventListener('click', function() {
        var secret = document.getElementById('room-secret-input').value.trim();
        if (!secret) return;
        sha256(secret).then(function(hash) {
          mode = 'room'; secretHash = hash;
          saveSession(); updateModeUI(); updateDashboard();
        });
      });
      document.getElementById('room-secret-input').addEventListener('keydown', function(e) {
        if (e.key === 'Enter') document.getElementById('room-login-btn').click();
      });
      document.getElementById('logout-btn').addEventListener('click', function() {
        mode = 'public'; secretHash = null; saveSession(); updateModeUI();
        document.getElementById('room-secret-input').value = '';
        updateDashboard();
      });

      loadSession(); updateModeUI(); updateDashboard();
      setInterval(updateDashboard, 2000);
      setInterval(updateTimestamp, 1000);
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
