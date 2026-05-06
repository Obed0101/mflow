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
  lastActivityAt: number;
  activity: ActivityEntry[];
}

// ─── Constants ──────────────────────────────────────────────

const MAX_STRING_LENGTH = 256;

interface SignalingLimits {
  maxPeersPerRoom: number;
  maxWebSocketMessageBytes: number;
  joinAttemptsPerMinute: number;
  messagesPerMinute: number;
  rateLimitViolationsBeforeDisconnect: number;
  unauthenticatedTimeoutMs: number;
  maxUnauthenticatedSocketsPerIp: number;
  maxUnauthenticatedSocketsGlobal: number;
  maxActiveRooms: number;
  idleRoomTtlMs: number;
  maxActivityEntriesPerRoom: number;
}

const DEFAULT_SIGNALING_LIMITS: SignalingLimits = {
  maxPeersPerRoom: 4,
  maxWebSocketMessageBytes: 65_536,
  joinAttemptsPerMinute: 10,
  messagesPerMinute: 120,
  rateLimitViolationsBeforeDisconnect: 3,
  unauthenticatedTimeoutMs: 10_000,
  maxUnauthenticatedSocketsPerIp: 5,
  maxUnauthenticatedSocketsGlobal: 500,
  maxActiveRooms: 200,
  idleRoomTtlMs: 15 * 60_000,
  maxActivityEntriesPerRoom: 20,
};

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const value = Deno.env.get(name);
  if (!value || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function loadSignalingLimits(): SignalingLimits {
  return {
    maxPeersPerRoom: readPositiveIntegerEnv("MFLOW_MAX_PEERS_PER_ROOM", DEFAULT_SIGNALING_LIMITS.maxPeersPerRoom),
    maxWebSocketMessageBytes: readPositiveIntegerEnv("MFLOW_MAX_WS_MESSAGE_BYTES", DEFAULT_SIGNALING_LIMITS.maxWebSocketMessageBytes),
    joinAttemptsPerMinute: readPositiveIntegerEnv("MFLOW_JOIN_ATTEMPTS_PER_MINUTE", DEFAULT_SIGNALING_LIMITS.joinAttemptsPerMinute),
    messagesPerMinute: readPositiveIntegerEnv("MFLOW_MESSAGES_PER_MINUTE", DEFAULT_SIGNALING_LIMITS.messagesPerMinute),
    rateLimitViolationsBeforeDisconnect: readPositiveIntegerEnv("MFLOW_RATE_LIMIT_VIOLATIONS_BEFORE_DISCONNECT", DEFAULT_SIGNALING_LIMITS.rateLimitViolationsBeforeDisconnect),
    unauthenticatedTimeoutMs: readPositiveIntegerEnv("MFLOW_UNAUTHENTICATED_TIMEOUT_MS", DEFAULT_SIGNALING_LIMITS.unauthenticatedTimeoutMs),
    maxUnauthenticatedSocketsPerIp: readPositiveIntegerEnv("MFLOW_MAX_UNAUTHENTICATED_SOCKETS_PER_IP", DEFAULT_SIGNALING_LIMITS.maxUnauthenticatedSocketsPerIp),
    maxUnauthenticatedSocketsGlobal: readPositiveIntegerEnv("MFLOW_MAX_UNAUTHENTICATED_SOCKETS_GLOBAL", DEFAULT_SIGNALING_LIMITS.maxUnauthenticatedSocketsGlobal),
    maxActiveRooms: readPositiveIntegerEnv("MFLOW_MAX_ACTIVE_ROOMS", DEFAULT_SIGNALING_LIMITS.maxActiveRooms),
    idleRoomTtlMs: readPositiveIntegerEnv("MFLOW_IDLE_ROOM_TTL_MS", DEFAULT_SIGNALING_LIMITS.idleRoomTtlMs),
    maxActivityEntriesPerRoom: readPositiveIntegerEnv("MFLOW_MAX_ACTIVITY_ENTRIES_PER_ROOM", DEFAULT_SIGNALING_LIMITS.maxActivityEntriesPerRoom),
  };
}

const limits = loadSignalingLimits();

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
    cleanupIdleRooms();
    if (rooms.size >= limits.maxActiveRooms) {
      return { ok: false, code: "ROOM_FULL", message: `Relay is full (max ${limits.maxActiveRooms} active rooms)` };
    }

    const now = Date.now();
    room = { id: roomId, secretHash, peers: new Map(), createdAt: now, lastActivityAt: now, activity: [] };
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

  if (room.peers.size >= limits.maxPeersPerRoom) {
    return { ok: false, code: "ROOM_FULL", message: `Room is full (max ${limits.maxPeersPerRoom} peers)` };
  }

  const info: PeerInfo = { peerId, peerName, peerType, joinedAt: Date.now() };
  room.peers.set(peerId, { ws, info });
  room.lastActivityAt = Date.now();

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
  room.lastActivityAt = Date.now();
  room.activity.push(entry);
  if (room.activity.length > limits.maxActivityEntriesPerRoom) {
    room.activity.shift();
  }
}

function touchRoom(roomId: string): void {
  const room = rooms.get(roomId);
  if (room) room.lastActivityAt = Date.now();
}

function cleanupIdleRooms(now = Date.now()): number {
  let removed = 0;
  for (const [roomId, room] of rooms) {
    if (now - room.lastActivityAt <= limits.idleRoomTtlMs) continue;
    for (const peer of room.peers.values()) {
      peer.ws.close(1001, "Room idle timeout");
    }
    rooms.delete(roomId);
    removed++;
  }
  return removed;
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
    return { allowed: false, shouldDisconnect: entry.violations >= limits.rateLimitViolationsBeforeDisconnect };
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

setInterval(() => {
  cleanupIdleRooms();
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

// ─── Dashboard GitHub Auth ─────────────────────────────────

interface DashboardUser {
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

const dashboardAuthRequired = parseBooleanEnv("MFLOW_REQUIRE_DASHBOARD_AUTH", false);
const dashboardGithubClientId = Deno.env.get("MFLOW_HOSTED_GITHUB_CLIENT_ID")?.trim() || null;
const dashboardAuthFlows = new Map<string, { deviceCode: string; intervalSeconds: number; expiresAt: number }>();
const dashboardSessions = new Map<string, { user: DashboardUser; expiresAt: number }>();

function parseBooleanEnv(name: string, fallback: boolean): boolean {
  const value = Deno.env.get(name);
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function getCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function getDashboardUser(req: Request): DashboardUser | null {
  const token = getCookie(req.headers.get("cookie"), "mflow_session");
  if (!token) return null;
  const session = dashboardSessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    dashboardSessions.delete(token);
    return null;
  }
  return session.user;
}

function sessionCookie(token: string, secure: boolean): string {
  return [
    `mflow_session=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : "",
    "Max-Age=604800",
  ].filter(Boolean).join("; ");
}

function clearSessionCookie(secure: boolean): string {
  return [
    "mflow_session=",
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : "",
    "Max-Age=0",
  ].filter(Boolean).join("; ");
}

async function fetchGitHubUser(accessToken: string): Promise<DashboardUser> {
  const res = await fetch("https://api.github.com/user", {
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${accessToken}`,
      "User-Agent": "mflow-signaling",
    },
  });
  if (!res.ok) throw new Error("GitHub user fetch failed");
  const user = await res.json() as { id: number; login: string; name?: string | null; avatar_url?: string | null };
  return {
    id: user.id,
    login: user.login,
    name: user.name ?? null,
    avatarUrl: user.avatar_url ?? null,
  };
}

function getDashboardAuthHtml(): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>mflow dashboard sign in</title><style>
  :root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#080a0f;color:#f3f4f1;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:grid;place-items:center;padding:24px;background-image:radial-gradient(circle at 50% 18%,rgba(16,185,129,.08),transparent 34%),radial-gradient(rgba(148,163,184,.11) 1px,transparent 1px);background-size:auto,22px 22px}
  .wrap{width:min(560px,100%)}.brand{display:flex;align-items:center;justify-content:center;gap:12px;margin-bottom:22px;color:#f8faf7;font-size:34px;font-weight:800;letter-spacing:-.04em}.mark{width:38px;height:38px;border:1px solid #2a2f3a;border-radius:12px;display:grid;place-items:center;background:#0d1117;color:#10b981;box-shadow:0 0 32px rgba(16,185,129,.08)}
  .box{background:#111318;border:1px solid #262b35;border-radius:14px;padding:30px;box-shadow:0 24px 80px rgba(0,0,0,.42)}h1{font-size:24px;letter-spacing:-.03em;margin:0 0 10px}p{color:#a5abb8;line-height:1.55;margin:0 0 22px;font-size:15px}.btn{width:100%;display:flex;align-items:center;justify-content:center;gap:10px;background:#0d1117;border:1px solid #2c3442;color:#f3f4f1;border-radius:9px;padding:12px 16px;font-weight:800;cursor:pointer;font-size:15px;transition:background .15s,border-color .15s,transform .15s}.btn:hover{background:#141922;border-color:#10b981;transform:translateY(-1px)}.btn svg{width:18px;height:18px;fill:currentColor}
  .device{margin-top:18px;padding:16px;background:#090b10;border:1px solid #262b35;border-radius:10px;color:#a5abb8}.code{display:block;color:#10b981;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:30px;font-weight:900;letter-spacing:.1em;margin:10px 0}.links{display:flex;justify-content:center;gap:18px;margin-top:20px;font-size:13px}.links a,.device a{color:#7dd3fc;text-decoration:none}.links a:hover,.device a:hover{text-decoration:underline}.note{margin-top:16px;color:#6b7280;font-size:12px;text-align:center}
  </style></head><body><main class="wrap"><div class="brand"><div class="mark">m</div><span>mflow</span></div><div class="box"><h1>Dashboard sign in</h1><p>Use GitHub first, then enter your room secret to view room-scoped status.</p><button class="btn" id="start" type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 .5a12 12 0 0 0-3.79 23.39c.6.11.82-.26.82-.58v-2.02c-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.33-1.76-1.33-1.76-1.09-.74.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.8 1.3 3.49.99.11-.78.42-1.3.76-1.6-2.67-.3-5.47-1.33-5.47-5.92 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.24 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.6-2.81 5.61-5.49 5.91.43.37.81 1.1.81 2.22v3.29c0 .32.22.69.83.57A12 12 0 0 0 12 .5Z"/></svg>Sign in with GitHub</button><div class="device" id="device" hidden></div><p class="note">Self-hosted relays can keep dashboard auth disabled.</p></div><nav class="links"><a href="https://trees.software/" rel="noreferrer">Trees</a><a href="https://diffs.com/" rel="noreferrer">Diffs</a></nav></main><script>
  var timer=null;var device=document.getElementById('device');
  document.getElementById('start').onclick=function(){device.hidden=false;device.textContent='Starting GitHub device login...';fetch('/api/auth/github/device/start',{method:'POST'}).then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})}).then(function(x){if(!x.ok)throw new Error(x.j.error||'GitHub login failed');var d=x.j;device.innerHTML='Open <a target="_blank" rel="noreferrer" href="'+d.verificationUri+'">'+d.verificationUri+'</a><span class="code">'+d.userCode+'</span>Waiting for approval...';timer=setInterval(function(){fetch('/api/auth/github/device/poll',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({flowId:d.flowId})}).then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})}).then(function(p){if(p.j.pending)return;if(!p.ok)throw new Error(p.j.error||'Approval failed');clearInterval(timer);location.href='/dashboard'}).catch(function(e){clearInterval(timer);device.textContent=e.message})},Math.max(1,d.interval||5)*1000)}).catch(function(e){device.textContent=e.message})};
  </script></body></html>`;
}

async function handleDashboardAuthRequest(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  const secure = url.protocol === "https:";

  if (url.pathname === "/api/auth/config" && req.method === "GET") {
    return Response.json({
      required: dashboardAuthRequired,
      provider: "github",
      configured: Boolean(dashboardGithubClientId),
      authenticated: Boolean(getDashboardUser(req)),
      user: getDashboardUser(req),
    });
  }

  if (url.pathname === "/api/auth/github/device/start" && req.method === "POST") {
    if (!dashboardAuthRequired) return Response.json({ error: "dashboard auth is not required" }, { status: 400 });
    if (!dashboardGithubClientId) return Response.json({ error: "GitHub auth is not configured" }, { status: 503 });

    const githubRes = await fetch("https://github.com/login/device/code", {
      method: "POST",
      headers: { "Accept": "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: dashboardGithubClientId, scope: "read:user" }),
    });
    const payload = await githubRes.json() as { device_code?: string; user_code?: string; verification_uri?: string; expires_in?: number; interval?: number; error?: string; error_description?: string };
    if (!githubRes.ok || !payload.device_code || !payload.user_code || !payload.verification_uri) {
      return Response.json({ error: payload.error_description ?? payload.error ?? "GitHub device flow failed" }, { status: 502 });
    }
    const flowId = crypto.randomUUID();
    dashboardAuthFlows.set(flowId, {
      deviceCode: payload.device_code,
      intervalSeconds: Math.max(1, payload.interval ?? 5),
      expiresAt: Date.now() + Math.max(1, payload.expires_in ?? 900) * 1000,
    });
    return Response.json({ flowId, userCode: payload.user_code, verificationUri: payload.verification_uri, expiresIn: payload.expires_in ?? 900, interval: payload.interval ?? 5 });
  }

  if (url.pathname === "/api/auth/github/device/poll" && req.method === "POST") {
    if (!dashboardAuthRequired) return Response.json({ error: "dashboard auth is not required" }, { status: 400 });
    if (!dashboardGithubClientId) return Response.json({ error: "GitHub auth is not configured" }, { status: 503 });
    const body = await req.json().catch(() => null) as { flowId?: string } | null;
    const flowId = typeof body?.flowId === "string" ? body.flowId : "";
    const flow = dashboardAuthFlows.get(flowId);
    if (!flow || Date.now() > flow.expiresAt) {
      if (flowId) dashboardAuthFlows.delete(flowId);
      return Response.json({ error: "expired_token" }, { status: 400 });
    }
    const githubRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Accept": "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: dashboardGithubClientId, device_code: flow.deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
    });
    const payload = await githubRes.json() as { access_token?: string; error?: string; error_description?: string };
    if (payload.error === "authorization_pending" || payload.error === "slow_down") return Response.json({ pending: true, error: payload.error, interval: flow.intervalSeconds });
    if (!githubRes.ok || !payload.access_token) return Response.json({ error: payload.error_description ?? payload.error ?? "GitHub token exchange failed" }, { status: 502 });
    const user = await fetchGitHubUser(payload.access_token);
    dashboardAuthFlows.delete(flowId);
    const token = crypto.randomUUID();
    dashboardSessions.set(token, { user, expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 });
    return Response.json({ authenticated: true, user }, { headers: { "Set-Cookie": sessionCookie(token, secure) } });
  }

  if (url.pathname === "/api/auth/logout" && req.method === "POST") {
    const token = getCookie(req.headers.get("cookie"), "mflow_session");
    if (token) dashboardSessions.delete(token);
    return Response.json({ ok: true }, { headers: { "Set-Cookie": clearSessionCookie(secure) } });
  }

  return null;
}

// ─── Unauthenticated Connection Tracking ────────────────────

const unauthSockets = new Set<WebSocket>();
const unauthPerIp = new Map<string, number>();

function trackUnauthSocket(ws: WebSocket, ip: string): boolean {
  if (unauthSockets.size >= limits.maxUnauthenticatedSocketsGlobal) return false;
  const current = unauthPerIp.get(ip) ?? 0;
  if (current >= limits.maxUnauthenticatedSocketsPerIp) return false;

  unauthSockets.add(ws);
  unauthPerIp.set(ip, current + 1);

  setTimeout(() => {
    if (unauthSockets.has(ws)) {
      ws.close(1008, "Authentication timeout");
    }
  }, limits.unauthenticatedTimeoutMs);

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
  if (raw.length > limits.maxWebSocketMessageBytes) {
    sendError(ws, "MESSAGE_TOO_LARGE", `Message exceeds ${limits.maxWebSocketMessageBytes} bytes`);
    return;
  }

  const msgCheck = checkRate(msgCounts, ip, limits.messagesPerMinute);
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
      const joinCheck = checkRate(joinCounts, ip, limits.joinAttemptsPerMinute);
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
      touchRoom(roomId);

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
      touchRoom(roomId);

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

Deno.serve({ port: PORT }, async (req, info) => {
  const url = new URL(req.url);

  const authResponse = await handleDashboardAuthRequest(req);
  if (authResponse) return authResponse;

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
    if (dashboardAuthRequired && !getDashboardUser(req)) {
      return new Response(getDashboardAuthHtml(), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    return new Response(getDashboardHtml(), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // Rooms API — scoped by auth level
  if (url.pathname === "/api/rooms" && req.method === "GET") {
    if (dashboardAuthRequired && !getDashboardUser(req)) {
      return Response.json({ error: "GitHub sign-in required" }, { status: 401 });
    }

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
<html class="dark" lang="en">
<head>
<meta charset="utf-8"/>
<meta content="width=device-width, initial-scale=1.0" name="viewport"/>
<title>mflow | Open-source real-time code sync for AI agent teams</title>
<script src="https://cdn.tailwindcss.com?plugins=forms,container-queries"></script>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&amp;family=JetBrains+Mono:wght@400;500&amp;display=swap" rel="stylesheet"/>
<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght@100..700,0..1&amp;display=swap" rel="stylesheet"/>
<script id="tailwind-config">
  tailwind.config = {
    darkMode: "class",
    theme: {
      extend: {
        colors: {
          primary: "#10b981",
          "background-light": "#f6f8f7",
          "background-dark": "#0a0a0a",
          "neutral-dark": "#171717",
          "text-main": "#fafafa",
          "text-muted": "#737373"
        },
        fontFamily: {
          display: ["Inter", "sans-serif"],
          mono: ["JetBrains Mono", "monospace"]
        },
        borderRadius: {
          DEFAULT: "0.25rem",
          lg: "0.5rem",
          xl: "0.75rem",
          full: "9999px"
        }
      }
    }
  }
</script>
</head>
<body class="bg-background-light dark:bg-background-dark font-display text-slate-900 dark:text-text-main antialiased selection:bg-primary/30">
<header class="fixed top-0 w-full z-50 border-b border-white/5 bg-background-dark/80 backdrop-blur-md">
  <div class="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
    <a class="flex items-center gap-2" href="#top" aria-label="mflow home">
      <span class="text-xl font-bold tracking-tight text-text-main">mflow</span>
    </a>
    <nav class="hidden md:flex items-center gap-8">
      <a class="text-sm font-medium text-text-muted hover:text-primary transition-colors" href="https://github.com/Obed0101/mflow">GitHub</a>
      <a class="text-sm font-medium text-text-muted hover:text-primary transition-colors" href="#quickstart">Install</a>
      <a class="text-sm font-medium text-text-muted hover:text-primary transition-colors" href="/dashboard">Monitor</a>
      <a class="text-sm font-medium text-text-muted hover:text-primary transition-colors" href="#access">Access</a>
      <a class="text-sm font-medium text-text-muted hover:text-primary transition-colors" href="#limits">Limits</a>
    </nav>
    <a class="bg-primary hover:bg-primary/90 text-background-dark px-4 py-2 rounded-lg text-sm font-bold transition-all" href="/dashboard">
      Open Dashboard
    </a>
  </div>
</header>
<main id="top" class="pt-32 pb-20">
<section class="max-w-7xl mx-auto px-6 mb-28">
  <div class="grid lg:grid-cols-2 gap-16 items-center">
    <div class="flex flex-col gap-8">
      <div class="inline-flex w-fit items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-3 py-1 text-xs font-semibold text-primary">
        MIT licensed core · self-hostable · public relay is fair-use
      </div>
      <h1 class="text-5xl md:text-7xl font-black tracking-tighter text-text-main leading-[1.06]">
        Real-time code sync for AI agent teams
      </h1>
      <p class="text-lg md:text-xl text-text-muted leading-relaxed max-w-xl">
        Sync working files between multiple worktrees or machines while agents edit. No account required. Bring a room name and a strong secret.
      </p>
      <div class="flex flex-wrap gap-4">
        <a class="bg-primary hover:bg-primary/90 text-background-dark px-8 py-4 rounded-xl text-base font-bold transition-all shadow-lg shadow-primary/10" href="/dashboard">
          Open Dashboard
        </a>
        <a class="border border-white/10 hover:border-primary/50 hover:bg-primary/5 text-text-main px-8 py-4 rounded-xl text-base font-bold transition-all" href="#quickstart">
          Install CLI
        </a>
        <a class="border border-white/10 hover:border-primary/50 hover:bg-primary/5 text-text-main px-8 py-4 rounded-xl text-base font-bold transition-all" href="https://github.com/Obed0101/mflow">
          View on GitHub
        </a>
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
          <p class="text-text-main"><span class="text-primary">$</span> npm i -g mflow-sdk</p>
          <p class="text-text-main"><span class="text-primary">$</span> mflow start --room my-project --secret "$MFLOW_SECRET"</p>
          <p class="text-primary">✓ Connected to public relay (fair-use: 4 peers/room)</p>
          <p class="text-text-muted">↑ src/auth.ts synced → 3 peers</p>
          <p class="text-text-muted">! Treat the room secret like a password</p>
          <div class="h-4 w-2 bg-primary inline-block animate-pulse ml-1"></div>
        </div>
      </div>
    </div>
  </div>
</section>

<section id="access" class="max-w-7xl mx-auto px-6 mb-28">
  <div class="bg-neutral-dark border border-white/5 rounded-3xl p-8 md:p-12">
    <div class="grid lg:grid-cols-[1.1fr_0.9fr] gap-10 items-start">
      <div>
        <p class="text-sm font-bold text-primary uppercase tracking-wider mb-3">Access today</p>
        <h2 class="text-3xl font-bold tracking-tight mb-4">Access is room + secret based</h2>
        <p class="text-text-muted text-lg leading-relaxed mb-6">
          There is no login or register flow in this OSS release. The dashboard asks for your room secret, hashes it in the browser, and only uses the hash to load room-scoped status. The secret itself is not sent by the dashboard.
        </p>
        <div class="grid md:grid-cols-3 gap-4 text-sm">
          <div class="rounded-xl border border-white/10 bg-background-dark/60 p-4">
            <div class="font-bold text-text-main mb-1">1. Start a room</div>
            <div class="text-text-muted">Run the CLI with a room and strong secret.</div>
          </div>
          <div class="rounded-xl border border-white/10 bg-background-dark/60 p-4">
            <div class="font-bold text-text-main mb-1">2. Share secret</div>
            <div class="text-text-muted">Give it only to trusted peers out-of-band.</div>
          </div>
          <div class="rounded-xl border border-white/10 bg-background-dark/60 p-4">
            <div class="font-bold text-text-main mb-1">3. Monitor</div>
            <div class="text-text-muted">Open /dashboard and enter the same secret.</div>
          </div>
        </div>
      </div>
      <div class="rounded-2xl border border-primary/20 bg-primary/5 p-6">
        <h3 class="font-bold text-text-main mb-3">Login/register status</h3>
        <p class="text-sm text-text-muted leading-relaxed">
          The hosted dashboard can require GitHub device sign-in before showing room status. Sync peers still join with room + secret. Self-hosted deployments can remain accountless.
        </p>
        <button class="mt-5 inline-flex rounded-xl border border-white/10 px-4 py-2 text-sm font-bold text-text-muted cursor-not-allowed opacity-70" type="button" disabled>
          Login/register planned
        </button>
      </div>
    </div>
  </div>
</section>

<section id="limits" class="max-w-7xl mx-auto px-6 mb-28">
  <div class="mb-10 text-center">
    <p class="text-sm font-bold text-primary uppercase tracking-wider mb-3">Public hosted relay limits</p>
    <h2 class="text-3xl font-bold tracking-tight mb-4">Fair-use limits per room, IP, and relay</h2>
    <p class="text-text-muted max-w-2xl mx-auto">These limits protect the shared Deno free-tier relay. Self-host if you need larger rooms, private infrastructure, or production reliability.</p>
  </div>
  <div class="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
    <div class="rounded-2xl border border-white/10 bg-neutral-dark p-6"><div class="text-3xl font-black text-primary mb-1">4</div><div class="font-bold mb-1">peers per room</div><p class="text-sm text-text-muted">Enough for demos and small agent swarms.</p></div>
    <div class="rounded-2xl border border-white/10 bg-neutral-dark p-6"><div class="text-3xl font-black text-primary mb-1">64KB</div><div class="font-bold mb-1">max WebSocket message</div><p class="text-sm text-text-muted">Oversized messages are rejected before parsing.</p></div>
    <div class="rounded-2xl border border-white/10 bg-neutral-dark p-6"><div class="text-3xl font-black text-primary mb-1">120/min</div><div class="font-bold mb-1">messages per IP</div><p class="text-sm text-text-muted">Repeated violations can disconnect the socket.</p></div>
    <div class="rounded-2xl border border-white/10 bg-neutral-dark p-6"><div class="text-3xl font-black text-primary mb-1">10/min</div><div class="font-bold mb-1">joins per IP</div><p class="text-sm text-text-muted">Protects room auth from noisy clients.</p></div>
    <div class="rounded-2xl border border-white/10 bg-neutral-dark p-6"><div class="text-3xl font-black text-primary mb-1">5</div><div class="font-bold mb-1">unauth sockets per IP</div><p class="text-sm text-text-muted">Unauthenticated sockets auto-timeout.</p></div>
    <div class="rounded-2xl border border-white/10 bg-neutral-dark p-6"><div class="text-3xl font-black text-primary mb-1">500</div><div class="font-bold mb-1">global unauth sockets</div><p class="text-sm text-text-muted">Relay-wide protection before authentication.</p></div>
    <div class="rounded-2xl border border-white/10 bg-neutral-dark p-6"><div class="text-3xl font-black text-primary mb-1">200</div><div class="font-bold mb-1">active rooms max</div><p class="text-sm text-text-muted">Room cap for the shared hosted relay.</p></div>
    <div class="rounded-2xl border border-white/10 bg-neutral-dark p-6"><div class="text-3xl font-black text-primary mb-1">15m</div><div class="font-bold mb-1">idle room TTL</div><p class="text-sm text-text-muted">Idle rooms are eligible for cleanup.</p></div>
    <div class="rounded-2xl border border-white/10 bg-neutral-dark p-6"><div class="text-3xl font-black text-primary mb-1">20</div><div class="font-bold mb-1">activity entries per room</div><p class="text-sm text-text-muted">Dashboard activity is intentionally bounded.</p></div>
  </div>
</section>

<section class="max-w-7xl mx-auto px-6 mb-28">
  <div class="mb-12">
    <h2 class="text-3xl font-bold tracking-tight mb-4">How it works</h2>
    <p class="text-text-muted">Mflow syncs files. It does not sync chat history, tool logs, or agent memory.</p>
  </div>
  <div class="grid md:grid-cols-3 gap-6">
    <div class="bg-neutral-dark border border-white/5 p-8 rounded-2xl hover:border-primary/30 transition-colors group">
      <span class="material-symbols-outlined text-primary mb-4 text-3xl group-hover:scale-110 transition-transform">sync_alt</span>
      <h3 class="text-xl font-bold mb-3">Sync</h3>
      <p class="text-text-muted leading-relaxed">File changes propagate between peers through encrypted room traffic.</p>
    </div>
    <div class="bg-neutral-dark border border-white/5 p-8 rounded-2xl hover:border-primary/30 transition-colors group">
      <span class="material-symbols-outlined text-primary mb-4 text-3xl group-hover:scale-110 transition-transform">encrypted</span>
      <h3 class="text-xl font-bold mb-3">Encrypt</h3>
      <p class="text-text-muted leading-relaxed">Room secrets derive encryption keys. The relay should not be treated as trusted storage.</p>
    </div>
    <div class="bg-neutral-dark border border-white/5 p-8 rounded-2xl hover:border-primary/30 transition-colors group">
      <span class="material-symbols-outlined text-primary mb-4 text-3xl group-hover:scale-110 transition-transform">lock_person</span>
      <h3 class="text-xl font-bold mb-3">Coordinate</h3>
      <p class="text-text-muted leading-relaxed">Pause/resume and file locks help avoid conflict during git operations or hot-file edits.</p>
    </div>
  </div>
</section>

<section class="max-w-7xl mx-auto px-6 mb-28">
  <div class="bg-neutral-dark border border-white/5 rounded-3xl overflow-hidden">
    <div class="grid lg:grid-cols-2">
      <div class="p-12 flex flex-col justify-center gap-6">
        <div>
          <h2 class="text-3xl font-bold mb-4">Monitor your sync room</h2>
          <p class="text-text-muted text-lg mb-6">Use the dashboard to see connected peers and recent room activity. Enter the same room secret you used in the CLI.</p>
          <p class="font-mono text-sm text-primary/60 mb-8 break-all">/dashboard</p>
        </div>
        <a class="bg-primary hover:bg-primary/90 text-background-dark px-6 py-3 rounded-xl font-bold w-fit transition-all" href="/dashboard">
          Open Monitor
        </a>
      </div>
      <div class="bg-gradient-to-br from-neutral-dark to-primary/10 p-4 lg:p-12 relative overflow-hidden flex items-center justify-center min-h-[300px]">
        <div class="w-full h-full rounded-xl bg-background-dark/60 border border-white/10 p-6 font-mono text-xs">
          <div class="flex justify-between items-center mb-6"><div class="text-primary">SIGNAL SERVER: ACTIVE</div><div class="text-text-muted">FAIR-USE RELAY</div></div>
          <div class="space-y-3">
            <div class="flex gap-4"><span class="text-primary">[ROOM]</span><span>4 peers max on public relay</span></div>
            <div class="flex gap-4"><span class="text-primary">[SYNC]</span><span>src/auth.ts → 3 peers</span></div>
            <div class="flex gap-4"><span class="text-primary">[LOCK]</span><span>db.ts locked by agent-beta</span></div>
            <div class="flex gap-4 opacity-50"><span class="text-primary">[SELF-HOST]</span><span>raise limits with MFLOW_* env vars</span></div>
          </div>
        </div>
      </div>
    </div>
  </div>
</section>

<section id="quickstart" class="max-w-7xl mx-auto px-6 mb-28">
  <h2 class="text-3xl font-bold tracking-tight mb-12 text-center">Quick Start</h2>
  <div class="grid lg:grid-cols-3 gap-6">
    <div class="flex flex-col gap-4">
      <h3 class="text-sm font-bold text-primary uppercase tracking-wider">1. Install</h3>
      <div class="bg-neutral-dark p-4 rounded-lg font-mono text-sm border border-white/10"><span class="text-text-muted"># npm package, CLI binary is mflow</span><br/><span class="text-text-main">npm i -g mflow-sdk</span></div>
    </div>
    <div class="flex flex-col gap-4">
      <h3 class="text-sm font-bold text-primary uppercase tracking-wider">2. Start syncing</h3>
      <div class="bg-neutral-dark p-4 rounded-lg font-mono text-sm border border-white/10"><span class="text-text-muted"># From project root</span><br/><span class="text-text-main">mflow start --room project-x --secret "$MFLOW_SECRET"</span></div>
    </div>
    <div class="flex flex-col gap-4">
      <h3 class="text-sm font-bold text-primary uppercase tracking-wider">3. Join from another worktree</h3>
      <div class="bg-neutral-dark p-4 rounded-lg font-mono text-sm border border-white/10"><span class="text-text-muted"># Same room and same secret</span><br/><span class="text-text-main">mflow start --room project-x --secret "$MFLOW_SECRET"</span></div>
    </div>
  </div>
</section>

<section class="max-w-7xl mx-auto px-6 mb-20">
  <div class="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
    <div class="p-6 rounded-2xl border border-white/5 bg-neutral-dark/40"><h4 class="text-text-main font-bold mb-2">Self-hostable</h4><p class="text-sm text-text-muted">Run your own signaling server on Deno Deploy, Bun, Docker, or private infrastructure.</p></div>
    <div class="p-6 rounded-2xl border border-white/5 bg-neutral-dark/40"><h4 class="text-text-main font-bold mb-2">MCP and CLI</h4><p class="text-sm text-text-muted">Works from CLI first, with MCP integration for supported harnesses.</p></div>
    <div class="p-6 rounded-2xl border border-white/5 bg-neutral-dark/40"><h4 class="text-text-main font-bold mb-2">Future managed relay</h4><p class="text-sm text-text-muted">Managed/private relay may come later. Core OSS and self-hosting remain the base path.</p></div>
  </div>
</section>
</main>
<footer class="border-t border-white/5 bg-neutral-dark/30 py-16">
  <div class="max-w-7xl mx-auto px-6">
    <div class="flex flex-col md:flex-row justify-between items-start gap-12 mb-12">
      <div class="flex flex-col gap-4"><span class="text-2xl font-bold tracking-tight text-text-main">mflow</span><p class="text-text-muted max-w-xs text-sm">Open-source real-time code sync for AI agent teams.</p></div>
      <div class="grid grid-cols-2 md:grid-cols-3 gap-12">
        <div class="flex flex-col gap-4"><span class="text-xs font-bold text-text-main uppercase">Resources</span><a class="text-sm text-text-muted hover:text-primary transition-colors" href="https://github.com/Obed0101/mflow">GitHub</a><a class="text-sm text-text-muted hover:text-primary transition-colors" href="#quickstart">Documentation</a></div>
        <div class="flex flex-col gap-4"><span class="text-xs font-bold text-text-main uppercase">Product</span><a class="text-sm text-text-muted hover:text-primary transition-colors" href="/dashboard">Monitor</a><a class="text-sm text-text-muted hover:text-primary transition-colors" href="#limits">Limits</a></div>
        <div class="flex flex-col gap-4"><span class="text-xs font-bold text-text-main uppercase">Related</span><a class="text-sm text-text-muted hover:text-primary transition-colors" href="https://trees.software/">Trees</a><a class="text-sm text-text-muted hover:text-primary transition-colors" href="https://diffs.com/">Diffs</a></div>
        <div class="flex flex-col gap-4"><span class="text-xs font-bold text-text-main uppercase">Legal</span><span class="text-sm text-text-muted">MIT License</span></div>
      </div>
    </div>
    <div class="flex flex-col md:flex-row justify-between items-center pt-8 border-t border-white/5 gap-4"><p class="text-sm text-text-muted">Made for AI agent teams. No hosted account required.</p></div>
  </div>
</footer>
</body>
</html>`;
