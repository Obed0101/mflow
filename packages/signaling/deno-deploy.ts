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
const dashboardGithubClientSecret = Deno.env.get("MFLOW_HOSTED_GITHUB_CLIENT_SECRET")?.trim() || null;
const dashboardGithubCallbackUrl = Deno.env.get("MFLOW_HOSTED_GITHUB_CALLBACK_URL")?.trim() || null;
const dashboardApiKeyPepper = Deno.env.get("MFLOW_API_KEY_PEPPER")?.trim() || null;
const dashboardSessionSecret = Deno.env.get("MFLOW_SESSION_SECRET")?.trim() || dashboardApiKeyPepper || dashboardGithubClientSecret;
const dashboardKv = await openDashboardKv();
const dashboardOAuthStates = new Map<string, number>();
const dashboardAuthFlows = new Map<string, { deviceCode: string; intervalSeconds: number; expiresAt: number }>();
const dashboardSessions = new Map<string, { user: DashboardUser; expiresAt: number }>();
const dashboardApiKeys = new Map<string, DashboardApiKey>();
const dashboardMutationLimits = new Map<string, number[]>();

interface DashboardApiKey { id: string; userId: number; name: string; hash: string; suffix: string; createdAt: number; expiresAt: number | null; lastUsedAt: number | null; revokedAt: number | null; }

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

async function getDashboardUser(req: Request): Promise<DashboardUser | null> {
  const token = getCookie(req.headers.get("cookie"), "mflow_session");
  if (!token) return null;
  const signed = await verifySignedDashboardSession(token);
  if (signed) return signed;
  const session = await getDashboardSession(token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    await deleteDashboardSession(token);
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

function normalizeGitHubDeviceFlowError(error: string | undefined): string {
  if (error?.toLowerCase().includes("device flow")) {
    return "GitHub Device Flow is disabled for this GitHub App. Enable Device Flow in the GitHub App settings, then retry.";
  }
  return error ?? "GitHub device flow failed";
}

function getDashboardAuthHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>mflow dashboard sign in</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      color-scheme: dark;
      --bg: #08090d;
      --panel: #111318;
      --line: #252a33;
      --text: #f5f7f2;
      --muted: #9ca3af;
      --green: #10b981;
      --red: #ef4444;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background:
        radial-gradient(circle at 50% 4%, rgba(16,185,129,.11), transparent 28%),
        radial-gradient(rgba(148,163,184,.12) 1px, transparent 1px),
        var(--bg);
      background-size: auto, 24px 24px;
      color: var(--text);
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main { width: min(440px, 100%); }
    .brand {
      display: block;
      width: fit-content;
      margin: 0 auto 22px;
      color: var(--text);
      font-size: 30px;
      font-weight: 800;
      letter-spacing: -.04em;
      text-decoration: none;
    }
    .card {
      padding: 28px;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: var(--panel);
      box-shadow: 0 24px 80px rgba(0,0,0,.42);
    }
    h1 {
      margin: 0 0 10px;
      font-size: 23px;
      line-height: 1.1;
      letter-spacing: -.035em;
    }
    p {
      margin: 0 0 24px;
      max-width: 46ch;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.55;
    }
    .button {
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      padding: 12px 16px;
      border: 1px solid #303746;
      border-radius: 10px;
      background: #0c1016;
      color: var(--text);
      cursor: pointer;
      font: inherit;
      font-weight: 750;
      transition: transform .15s ease, border-color .15s ease, background .15s ease;
    }
    .button:hover {
      transform: translateY(-1px);
      border-color: var(--green);
      background: #141922;
    }
    .button svg { width: 18px; height: 18px; fill: currentColor; }
    .device {
      margin-top: 18px;
      padding: 16px;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: #080a0f;
      color: var(--muted);
      line-height: 1.55;
    }
    .device a { color: var(--text); text-decoration: underline; text-decoration-color: rgba(245,247,242,.35); text-underline-offset: 3px; }
    .device a:hover { text-decoration-color: var(--green); }
    .error-title { color: var(--red); font-weight: 800; margin-bottom: 6px; }
    .note {
      margin: 16px 0 0;
      color: #6b7280;
      font-size: 12px;
      text-align: center;
    }
    .home {
      display: block;
      width: fit-content;
      margin: 18px auto 0;
      color: var(--muted);
      font-size: 13px;
      text-decoration: none;
    }
    .home:hover { color: var(--text); }
  </style>
</head>
<body>
  <main>
    <a class="brand" href="/">mflow</a>
    <section class="card">
      <h1>Dashboard sign in</h1>
      <p>Sign in with GitHub, then enter your room secret to view room-scoped relay status.</p>
      <a class="button" href="/auth/github/start" aria-label="Sign in with GitHub">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 .5a12 12 0 0 0-3.79 23.39c.6.11.82-.26.82-.58v-2.02c-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.33-1.76-1.33-1.76-1.09-.74.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.8 1.3 3.49.99.11-.78.42-1.3.76-1.6-2.67-.3-5.47-1.33-5.47-5.92 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.24 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.6-2.81 5.61-5.49 5.91.43.37.81 1.1.81 2.22v3.29c0 .32.22.69.83.57A12 12 0 0 0 12 .5Z"/></svg>
        Sign in with GitHub
      </a>
      <p class="note">Self-hosted relays can keep dashboard auth disabled.</p>
    </section>
    <a class="home" href="/" rel="noreferrer">Back to home</a>
  </main>
</body>
</html>`;
}


function getCallbackUrl(req: Request): string {
  return dashboardGithubCallbackUrl ?? `${new URL(req.url).origin}/auth/github/callback`;
}

function isValidOAuthState(state: string): boolean {
  const expiresAt = dashboardOAuthStates.get(state);
  if (!expiresAt) return false;
  if (Date.now() > expiresAt) {
    dashboardOAuthStates.delete(state);
    return false;
  }
  return true;
}

function redirect(location: string, headers: Headers = new Headers()): Response {
  headers.set("Location", location);
  return new Response(null, { status: 302, headers });
}

function oauthStateCookie(state: string, secure: boolean): string {
  return [
    `mflow_oauth_state=${encodeURIComponent(state)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : "",
    "Max-Age=600",
  ].filter(Boolean).join("; ");
}

function clearOAuthStateCookie(secure: boolean): string {
  return [
    "mflow_oauth_state=",
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : "",
    "Max-Age=0",
  ].filter(Boolean).join("; ");
}

async function handleDashboardAuthRequest(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  const secure = url.protocol === "https:";

  if (url.pathname === "/api/auth/config" && req.method === "GET") {
    return Response.json({
      required: dashboardAuthRequired,
      provider: "github",
      configured: Boolean(dashboardGithubClientId && dashboardGithubClientSecret),
      authenticated: Boolean(await getDashboardUser(req)),
      user: await getDashboardUser(req),
      apiKeysConfigured: Boolean(dashboardApiKeyPepper),
    });
  }

  if (url.pathname === "/auth/github/start" && req.method === "GET") {
    if (!dashboardAuthRequired) return redirect("/dashboard");
    if (!dashboardGithubClientId || !dashboardGithubClientSecret) return Response.json({ error: "GitHub OAuth is not configured" }, { status: 503 });
    const state = crypto.randomUUID();
    dashboardOAuthStates.set(state, Date.now() + 10 * 60 * 1000);
    const githubUrl = new URL("https://github.com/login/oauth/authorize");
    githubUrl.searchParams.set("client_id", dashboardGithubClientId);
    githubUrl.searchParams.set("redirect_uri", getCallbackUrl(req));
    githubUrl.searchParams.set("scope", "read:user");
    githubUrl.searchParams.set("state", state);
    const headers = new Headers();
    headers.append("Set-Cookie", oauthStateCookie(state, secure));
    return redirect(githubUrl.toString(), headers);
  }

  if (url.pathname === "/auth/github/callback" && req.method === "GET") {
    if (!dashboardAuthRequired) return redirect("/dashboard");
    if (!dashboardGithubClientId || !dashboardGithubClientSecret) return Response.json({ error: "GitHub OAuth is not configured" }, { status: 503 });
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code") ?? "";
    const cookieState = getCookie(req.headers.get("cookie"), "mflow_oauth_state") ?? "";
    const headers = new Headers();
    headers.append("Set-Cookie", clearOAuthStateCookie(secure));
    if (!code || !state || state !== cookieState || !isValidOAuthState(state)) {
      if (state) dashboardOAuthStates.delete(state);
      return redirect("/dashboard?auth_error=invalid_state", headers);
    }
    dashboardOAuthStates.delete(state);
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Accept": "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: dashboardGithubClientId, client_secret: dashboardGithubClientSecret, code, redirect_uri: getCallbackUrl(req) }),
    });
    const tokenPayload = await tokenRes.json() as { access_token?: string; error?: string; error_description?: string };
    if (!tokenRes.ok || !tokenPayload.access_token) return redirect("/dashboard?auth_error=github_token", headers);
    const user = await fetchGitHubUser(tokenPayload.access_token);
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
    const token = await createDashboardSessionToken(user, expiresAt);
    if (!isSignedDashboardSessionToken(token)) await setDashboardSession(token, { user, expiresAt });
    headers.append("Set-Cookie", sessionCookie(token, secure));
    return redirect("/dashboard", headers);
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
      return Response.json({ error: normalizeGitHubDeviceFlowError(payload.error_description ?? payload.error) }, { status: 502 });
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
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
    const token = await createDashboardSessionToken(user, expiresAt);
    if (!isSignedDashboardSessionToken(token)) await setDashboardSession(token, { user, expiresAt });
    return Response.json({ authenticated: true, user }, { headers: { "Set-Cookie": sessionCookie(token, secure) } });
  }

  if (url.pathname === "/api/auth/logout" && req.method === "POST") {
    const token = getCookie(req.headers.get("cookie"), "mflow_session");
    if (token) await deleteDashboardSession(token);
    return Response.json({ ok: true }, { headers: { "Set-Cookie": clearSessionCookie(secure) } });
  }

  if (url.pathname === "/api/api-keys" && req.method === "GET") {
    const user = await requireDashboardUser(req);
    if (!user) return Response.json({ error: "Sign-in required" }, { status: 401 });
    const keys = await listDashboardApiKeys(user.id);
    return Response.json({ keys: keys.map(publicDashboardApiKey) });
  }

  if (url.pathname === "/api/api-keys" && req.method === "POST") {
    const user = await requireDashboardUser(req);
    if (!user) return Response.json({ error: "Sign-in required" }, { status: 401 });
    if (!dashboardApiKeyPepper) return Response.json({ error: "API key creation is not configured on this relay" }, { status: 503 });
    if (!checkDashboardMutationLimit(`create:${user.id}`)) return Response.json({ error: "Too many requests" }, { status: 429 });
    const body = await req.json().catch(() => null) as { name?: unknown; expiresIn?: unknown } | null;
    const name = sanitizeDashboardKeyName(typeof body?.name === "string" ? body.name : "");
    const expiresAt = dashboardExpirationToTimestamp(typeof body?.expiresIn === "string" ? body.expiresIn : "");
    if (!name) return Response.json({ error: "Name is required" }, { status: 400 });
    if (expiresAt === undefined) return Response.json({ error: "Invalid expiration" }, { status: 400 });
    const plaintext = `mflow_key_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().slice(0, 8)}`;
    const key: DashboardApiKey = { id: crypto.randomUUID(), userId: user.id, name, hash: await hashDashboardApiKey(plaintext), suffix: plaintext.slice(-8), createdAt: Date.now(), expiresAt, lastUsedAt: null, revokedAt: null };
    await saveDashboardApiKey(key);
    return Response.json({ key: publicDashboardApiKey(key), plaintext }, { status: 201 });
  }

  const revokeMatch = url.pathname.match(/^\/api\/api-keys\/([^/]+)\/revoke$/);
  if (revokeMatch && req.method === "POST") {
    const user = await requireDashboardUser(req);
    if (!user) return Response.json({ error: "Sign-in required" }, { status: 401 });
    if (!checkDashboardMutationLimit(`revoke:${user.id}`)) return Response.json({ error: "Too many requests" }, { status: 429 });
    const keys = await listDashboardApiKeys(user.id);
    const key = keys.find((item) => item.id === revokeMatch[1]);
    if (!key) return Response.json({ error: "Not found" }, { status: 404 });
    key.revokedAt = Date.now();
    await saveDashboardApiKey(key);
    return Response.json({ ok: true, key: publicDashboardApiKey(key) });
  }

  return null;
}

async function openDashboardKv(): Promise<Deno.Kv | null> {
  try {
    return await Deno.openKv();
  } catch {
    return null;
  }
}

async function getDashboardSession(token: string): Promise<{ user: DashboardUser; expiresAt: number } | null> {
  if (dashboardKv) return (await dashboardKv.get<{ user: DashboardUser; expiresAt: number }>(["dashboard", "session", token])).value ?? null;
  return dashboardSessions.get(token) ?? null;
}
async function setDashboardSession(token: string, session: { user: DashboardUser; expiresAt: number }): Promise<void> {
  if (dashboardKv) await dashboardKv.set(["dashboard", "session", token], session, { expireIn: Math.max(1, session.expiresAt - Date.now()) });
  else dashboardSessions.set(token, session);
}
async function deleteDashboardSession(token: string): Promise<void> {
  if (dashboardKv) await dashboardKv.delete(["dashboard", "session", token]);
  else dashboardSessions.delete(token);
}

async function createDashboardSessionToken(user: DashboardUser, expiresAt: number): Promise<string> {
  if (!dashboardSessionSecret) return crypto.randomUUID();
  const payload = base64UrlEncode(JSON.stringify({ user, expiresAt }));
  const sig = await hmacSha256(payload, dashboardSessionSecret);
  return `${payload}.${sig}`;
}

async function verifySignedDashboardSession(token: string): Promise<DashboardUser | null> {
  if (!dashboardSessionSecret || !isSignedDashboardSessionToken(token)) return null;
  const [payload, sig] = token.split(".");
  const expected = await hmacSha256(payload, dashboardSessionSecret);
  if (!constantTimeStringEqual(sig, expected)) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) as { user?: DashboardUser; expiresAt?: number };
    if (!parsed.user || !parsed.expiresAt || Date.now() > parsed.expiresAt) return null;
    return parsed.user;
  } catch {
    return null;
  }
}

function isSignedDashboardSessionToken(token: string): boolean {
  return token.includes(".");
}

async function hmacSha256(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return base64UrlEncodeBytes(new Uint8Array(signature));
}

function base64UrlEncode(value: string): string {
  return base64UrlEncodeBytes(new TextEncoder().encode(value));
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function constantTimeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function saveDashboardApiKey(key: DashboardApiKey): Promise<void> {
  if (dashboardKv) { await dashboardKv.set(["dashboard", "apiKey", key.hash], key); await dashboardKv.set(["dashboard", "apiKeysByUser", key.userId, key.id], key.hash); }
  else dashboardApiKeys.set(key.hash, key);
}
async function listDashboardApiKeys(userId: number): Promise<DashboardApiKey[]> {
  if (!dashboardKv) return [...dashboardApiKeys.values()].filter((key) => key.userId === userId).sort((a,b)=>b.createdAt-a.createdAt);
  const keys: DashboardApiKey[] = [];
  for await (const entry of dashboardKv.list<string>({ prefix: ["dashboard", "apiKeysByUser", userId] })) {
    const key = (await dashboardKv.get<DashboardApiKey>(["dashboard", "apiKey", entry.value])).value;
    if (key) keys.push(key);
  }
  return keys.sort((a,b)=>b.createdAt-a.createdAt);
}
async function requireDashboardUser(req: Request): Promise<DashboardUser | null> {
  if (!dashboardAuthRequired) return { id: 0, login: "self-hosted", name: "Self-hosted admin", avatarUrl: null };
  return getDashboardUser(req);
}
async function getDashboardApiKeyByHash(hash: string): Promise<DashboardApiKey | null> {
  if (dashboardKv) return (await dashboardKv.get<DashboardApiKey>(["dashboard", "apiKey", hash])).value ?? null;
  return dashboardApiKeys.get(hash) ?? null;
}
async function validateDashboardApiKey(req: Request): Promise<DashboardApiKey | null> {
  const header = req.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match || !dashboardApiKeyPepper) return null;
  const key = await getDashboardApiKeyByHash(await hashDashboardApiKey(match[1].trim()));
  if (!key || key.revokedAt) return null;
  if (key.expiresAt && Date.now() > key.expiresAt) return null;
  key.lastUsedAt = Date.now();
  await saveDashboardApiKey(key);
  return key;
}
async function hasDashboardAccess(req: Request): Promise<boolean> {
  if (!dashboardAuthRequired) return true;
  if (await getDashboardUser(req)) return true;
  return Boolean(await validateDashboardApiKey(req));
}
async function hashDashboardApiKey(key: string): Promise<string> {
  const input = new TextEncoder().encode(`${dashboardApiKeyPepper}:${key}`);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function publicDashboardApiKey(key: DashboardApiKey) { return { id: key.id, name: key.name, suffix: key.suffix, createdAt: key.createdAt, expiresAt: key.expiresAt, lastUsedAt: key.lastUsedAt, revokedAt: key.revokedAt }; }
function sanitizeDashboardKeyName(name: string): string { return name.trim().replace(/\s+/g, " ").slice(0, 80); }
function dashboardExpirationToTimestamp(value: string): number | null | undefined { const now=Date.now(), day=86400000; const table: Record<string, number | null> = { "1d": now+day, "3d": now+3*day, "7d": now+7*day, "1m": now+30*day, "6m": now+180*day, "1y": now+365*day, never: null }; return Object.prototype.hasOwnProperty.call(table, value) ? table[value] : undefined; }
function checkDashboardMutationLimit(key: string): boolean { const now=Date.now(); const recent=(dashboardMutationLimits.get(key)??[]).filter((ts)=>now-ts<60000); if(recent.length>=10){dashboardMutationLimits.set(key,recent);return false} recent.push(now); dashboardMutationLimits.set(key,recent); return true; }

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
  <title>mflow dashboard</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #09090b;
      --bg-card: rgba(24, 24, 27, 0.4);
      --border: rgba(255, 255, 255, 0.1);
      --border-hover: rgba(255, 255, 255, 0.2);
      --text: #f8fafc;
      --text-muted: #a1a1aa;
      --green: #10b981;
      --green-glow: rgba(16, 185, 129, 0.15);
      --red: #ef4444;
      --blue: #3b82f6;
      --mono: 'JetBrains Mono', monospace;
      --sans: 'Inter', sans-serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background:
        radial-gradient(circle at 20% -10%, rgba(52,211,153,.12), transparent 32%),
        var(--bg);
      color: var(--text);
      font-family: var(--sans);
      font-size: 14px;
      line-height: 1.5;
      min-height: 100vh;
      display: block;
    }
    .app-shell {
      min-height: 100vh;
      display: grid;
      grid-template-columns: 236px 1fr;
    }
    .sidebar {
      position: sticky;
      top: 0;
      height: 100vh;
      display: flex;
      flex-direction: column;
      padding: 28px 18px;
      border-right: 1px solid var(--border);
      background: rgba(8, 9, 13, .74);
    }
    .side-brand {
      display: flex;
      align-items: center;
      gap: 10px;
      color: var(--text);
      text-decoration: none;
      font-size: 20px;
      font-weight: 800;
      letter-spacing: -.045em;
      margin: 0 10px 32px;
    }
    .side-brand::before {
      content: '';
      width: 9px;
      height: 9px;
      border-radius: 999px;
      background: var(--green);
      box-shadow: 0 0 18px rgba(52,211,153,.9);
    }
    .side-nav {
      display: grid;
      gap: 8px;
    }
    .side-link {
      display: flex;
      align-items: center;
      gap: 10px;
      min-height: 42px;
      padding: 0 12px;
      border: 1px solid transparent;
      border-radius: 12px;
      color: var(--text-muted);
      text-decoration: none;
      font-weight: 750;
      transition: background .16s ease, border-color .16s ease, color .16s ease;
    }
    .side-link svg { width: 18px; height: 18px; fill: currentColor; }
    .side-link:hover,
    .side-link[aria-current="page"] {
      color: var(--text);
      border-color: var(--border);
      background: rgba(255,255,255,.045);
    }
    .side-spacer { flex: 1; }
    .side-user {
      display: grid;
      gap: 10px;
      padding-top: 16px;
      border-top: 1px solid var(--border);
    }
    .side-user-card {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px;
      border: 1px solid var(--border);
      border-radius: 14px;
      background: rgba(255,255,255,.035);
    }
    .side-user-card img {
      width: 30px;
      height: 30px;
      border-radius: 10px;
      border: 1px solid var(--border);
    }
    .side-user-card span {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 800;
    }
    .side-actions {
      display: flex;
      gap: 8px;
    }
    .side-actions a {
      flex: 1;
      min-height: 38px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 1px solid var(--border);
      border-radius: 11px;
      background: rgba(255,255,255,.035);
      color: var(--text-muted);
      text-decoration: none;
      font-weight: 800;
      transition: color .16s, border-color .16s, background .16s;
    }
    .side-actions a:hover {
      color: var(--text);
      border-color: var(--border-hover);
      background: rgba(255,255,255,.06);
    }
    .github-link svg { width: 18px; height: 18px; fill: currentColor; }

    /* ── Top Navigation ────────────────────────── */
    .topnav {
      height: 64px;
      border-bottom: 1px solid var(--border);
      background: rgba(8, 9, 13, 0.78);
      backdrop-filter: blur(18px);
      position: sticky;
      top: 0;
      z-index: 10;
    }
    .topnav-inner {
      max-width: 1120px;
      height: 100%;
      margin: 0 auto;
      padding: 0 24px;
      display: grid;
      grid-template-columns: 1fr auto 1fr;
      align-items: center;
      gap: 16px;
    }
    .topnav-brand {
      display: flex;
      align-items: center;
      gap: 10px;
      font-weight: 800;
      font-size: 17px;
      letter-spacing: -.04em;
      color: var(--text);
      text-decoration: none;
    }
    .topnav-brand::before {
      content: '';
      display: block;
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: var(--green);
      box-shadow: 0 0 18px rgba(52,211,153,.9);
    }
    .topnav-status {
      justify-self: center;
      color: var(--text-muted);
      font: 600 12px var(--mono);
      letter-spacing: .02em;
    }
    .topnav-links {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 10px;
    }
    .topnav-links a {
      color: var(--text);
      text-decoration: none;
      font-size: 13px;
      font-weight: 700;
      transition: transform .16s ease, border-color .16s ease, background .16s ease;
    }
    .topnav-links a:hover { transform: translateY(-1px); }
    .topnav-cta {
      color: #050607 !important;
      background: #f6f7f4;
      border-radius: 10px;
      padding: 9px 14px;
      font-weight: 800 !important;
    }
    .icon-link {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 38px;
      height: 38px;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: rgba(255,255,255,.04);
    }
    .icon-link svg { width: 18px; height: 18px; fill: currentColor; }
    .nav-link {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 38px;
      height: 38px;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: rgba(255,255,255,.04);
    }
    .nav-link svg { width: 18px; height: 18px; fill: currentColor; }
    .user-menu {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 4px 6px 4px 4px;
      border: 1px solid var(--border);
      border-radius: 999px;
      background: rgba(255,255,255,0.03);
    }
    .user-menu img {
      width: 24px;
      height: 24px;
      border-radius: 999px;
      border: 1px solid var(--border);
    }
    .user-login {
      max-width: 120px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: #fff;
      font-size: 13px;
      font-weight: 700;
    }
    .signout-link {
      color: var(--text-muted) !important;
      font-size: 12px !important;
      padding: 0 6px;
    }
    .settings-toggle {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text);
      border-radius: 8px;
      padding: 7px 10px;
      font-weight: 700;
      cursor: pointer;
    }

    /* ── Main Content ──────────────────────────── */
    .main {
      flex: 1;
      padding: 56px 48px;
      max-width: 1000px;
      width: 100%;
      margin: 0;
    }

    /* ── Stats Header ──────────────────────────── */
    .stats-header {
      display: flex;
      gap: 24px;
      margin-bottom: 32px;
      flex-wrap: wrap;
    }
    .stat-item {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 120px;
      padding: 16px 20px;
      background: rgba(255,255,255,0.02);
      border: 1px solid var(--border);
      border-radius: 12px;
    }
    .stat-label {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .stat-value {
      font-size: 20px;
      font-weight: 700;
      font-family: var(--mono);
      color: #fff;
    }

    /* ── Cards ─────────────────────────────────── */
    .card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 32px;
      margin-bottom: 24px;
    }
    .card-title {
      font-size: 16px;
      font-weight: 600;
      color: #fff;
      margin-bottom: 16px;
    }

    /* ── Forms & Inputs ────────────────────────── */
    .input-group {
      display: flex;
      gap: 12px;
      max-width: 500px;
    }
    input {
      flex: 1;
      background: rgba(0,0,0,0.3);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px 16px;
      color: #fff;
      font-family: var(--sans);
      font-size: 14px;
      outline: none;
      transition: border-color 0.2s;
    }
    input:focus { border-color: var(--green); }
    .btn {
      background: #fff;
      color: #000;
      border: none;
      border-radius: 8px;
      padding: 10px 20px;
      font-weight: 600;
      font-size: 14px;
      cursor: pointer;
      transition: opacity 0.2s;
      white-space: nowrap;
    }
    .btn:hover { opacity: 0.9; }
    .btn-outline {
      background: transparent;
      color: #fff;
      border: 1px solid var(--border);
    }
    .btn-outline:hover { background: rgba(255,255,255,0.05); }

    /* ── Room Data ─────────────────────────────── */
    .room-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 24px;
    }
    .room-id {
      font-family: var(--mono);
      font-size: 15px;
      font-weight: 700;
      color: var(--green);
    }
    .peers-list {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 32px;
    }
    .peer-chip {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: rgba(0,0,0,0.3);
      border: 1px solid var(--border);
      padding: 6px 12px;
      border-radius: 100px;
      font-size: 13px;
      font-family: var(--mono);
    }
    .peer-type {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      padding: 2px 6px;
      border-radius: 4px;
    }
    .peer-type.agent { background: rgba(59,130,246,0.15); color: var(--blue); }
    .peer-type.human { background: rgba(16,185,129,0.15); color: var(--green); }

    /* ── Activity Feed ─────────────────────────── */
    .activity-feed {
      display: flex;
      flex-direction: column;
    }
    .activity-row {
      display: grid;
      grid-template-columns: 80px 1fr auto 200px;
      gap: 16px;
      align-items: center;
      padding: 12px 0;
      border-bottom: 1px solid rgba(255,255,255,0.05);
    }
    .activity-row:last-child { border-bottom: none; }
    .activity-time { font-size: 12px; color: var(--text-muted); font-family: var(--mono); }
    .activity-peer { font-weight: 500; color: #fff; }
    .activity-action { font-size: 11px; font-weight: 700; text-transform: uppercase; }
    .action-synced { color: var(--green); }
    .action-created { color: var(--blue); }
    .action-deleted { color: var(--red); }
    .activity-file { font-family: var(--mono); font-size: 12px; color: var(--text-muted); text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .hidden { display: none !important; }
    .error-msg { color: var(--red); font-size: 13px; margin-top: 12px; }

    @media (max-width: 640px) {
      .app-shell { grid-template-columns: 1fr; }
      .sidebar {
        position: static;
        height: auto;
        padding: 16px;
        border-right: 0;
        border-bottom: 1px solid var(--border);
      }
      .side-brand { margin-bottom: 14px; }
      .side-nav { grid-template-columns: 1fr 1fr; }
      .side-spacer { display: none; }
      .side-user { margin-top: 12px; }
      .main { padding: 28px 16px; }
      .topnav-inner { grid-template-columns: 1fr auto; }
      .topnav-status { display: none; }
      .user-login, .signout-link { display: none; }
      .activity-row { grid-template-columns: 60px 1fr auto; }
      .activity-file { display: none; }
      .input-group { flex-direction: column; }
    }
  </style>
</head>
<body>

  <div class="app-shell">
    <aside class="sidebar">
      <a href="/" class="side-brand">mflow</a>
      <nav class="side-nav" aria-label="Dashboard navigation">
        <a class="side-link" href="/dashboard" aria-current="page">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 13h7V4H4v9Zm0 7h7v-5H4v5Zm9 0h7v-9h-7v9Zm0-16v5h7V4h-7Z"/></svg>
          Dashboard
        </a>
        <a class="side-link" href="/settings">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.4 13.5a7.8 7.8 0 0 0 0-3l2-1.5-2-3.5-2.4 1a8 8 0 0 0-2.6-1.5L14 2.4h-4L9.6 5a8 8 0 0 0-2.6 1.5l-2.4-1-2 3.5 2 1.5a7.8 7.8 0 0 0 0 3l-2 1.5 2 3.5 2.4-1a8 8 0 0 0 2.6 1.5l.4 2.6h4l.4-2.6a8 8 0 0 0 2.6-1.5l2.4 1 2-3.5-2-1.5ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5Z"/></svg>
          Settings
        </a>
      </nav>
      <div class="side-spacer"></div>
      <div class="side-user">
        <div id="user-info" class="side-user-card hidden">
          <img id="user-avatar" src="" alt="">
          <span id="user-login"></span>
        </div>
        <div class="side-actions">
          <a href="#" id="auth-logout-btn">Sign out</a>
          <a class="github-link" href="https://github.com/Obed0101/mflow" target="_blank" rel="noreferrer" aria-label="Open mflow on GitHub">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 .5a12 12 0 0 0-3.79 23.39c.6.11.82-.26.82-.58v-2.02c-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.33-1.76-1.33-1.76-1.09-.74.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.8 1.3 3.49.99.11-.78.42-1.3.76-1.6-2.67-.3-5.47-1.33-5.47-5.92 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.24 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.6-2.81 5.61-5.49 5.91.43.37.81 1.1.81 2.22v3.29c0 .32.22.69.83.57A12 12 0 0 0 12 .5Z"/></svg>
          </a>
        </div>
      </div>
    </aside>

  <main class="main">

    <div class="stats-header">
      <div class="stat-item">
        <span class="stat-label">Relay Status</span>
        <span class="stat-value" style="color: var(--green)" id="status-text">Online</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">Active Rooms</span>
        <span class="stat-value" id="room-count">-</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">Total Peers</span>
        <span class="stat-value" id="peer-count">-</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">Uptime</span>
        <span class="stat-value" id="uptime">--</span>
      </div>
    </div>

    <!-- Auth Gate -->
    <div id="github-gate" class="card hidden" style="text-align: center; padding: 64px 24px;">
      <h2 style="font-size: 20px; font-weight: 600; color: #fff; margin-bottom: 12px;">GitHub Authentication Required</h2>
      <p style="color: var(--text-muted); margin-bottom: 32px;">This relay requires you to sign in before accessing the dashboard.</p>
      <button class="btn" id="github-login-btn">Sign in with GitHub</button>
      <div id="device-box" class="hidden" style="margin-top: 32px; padding: 24px; background: rgba(0,0,0,0.5); border-radius: 12px; border: 1px solid var(--border);"></div>
    </div>

    <!-- Room Gate -->
    <div id="room-gate" class="card">
      <h2 class="card-title">Monitor Room</h2>
      <p style="color: var(--text-muted); font-size: 13px; margin-bottom: 20px;">Enter your room secret to view live peers and file activity.</p>

      <div id="login-row" class="input-group">
        <input type="password" id="secret-input" placeholder="Room Secret..." autocomplete="off">
        <button class="btn" id="login-btn">Connect</button>
      </div>

      <div id="room-badge-row" class="hidden" style="display:flex; align-items:center; justify-content:space-between;">
        <span class="room-id" id="active-room-id">--</span>
        <button class="btn btn-outline" id="logout-btn" style="padding: 6px 12px; font-size: 12px;">Disconnect</button>
      </div>

      <div id="error-banner" class="error-msg hidden"></div>
    </div>

    <!-- Room Data -->
    <div id="room-data" class="hidden">
      <div class="card">
        <h3 style="font-size: 13px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; margin-bottom: 16px;">Connected Peers</h3>
        <div id="peers-container" class="peers-list"></div>

        <h3 style="font-size: 13px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; margin-bottom: 16px; margin-top: 16px;">Recent Activity</h3>
        <div id="activity-feed" class="activity-feed"></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:28px;">
          <div style="border:1px solid var(--border);border-radius:10px;padding:18px;background:rgba(0,0,0,0.18);">
            <div style="font-size:12px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px;">File tree</div>
            <div style="font-size:13px;color:var(--text-muted);">Room file tree view will use the Trees renderer.</div>
          </div>
          <div style="border:1px solid var(--border);border-radius:10px;padding:18px;background:rgba(0,0,0,0.18);">
            <div style="font-size:12px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px;">Changed files</div>
            <div style="font-size:13px;color:var(--text-muted);">Room diff view will use the Diffs renderer.</div>
          </div>
        </div>
      </div>
    </div>

  </main>
  </div>

  <script>
    (function() {
      var lastFetch = 0;
      var consecutiveErrors = 0;
      var mode = 'public';
      var secretHash = null;
      var knownActivityIds = {};
      var authRequired = false;
      var authenticated = false;
      var authPollTimer = null;

      function sha256(str) {
        return crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)).then(function(buf) {
          var arr = new Uint8Array(buf);
          var hex = '';
          for (var i = 0; i < arr.length; i++) hex += ('0' + arr[i].toString(16)).slice(-2);
          return hex;
        });
      }

      function loadSession() {
        try { sessionStorage.removeItem('mflow_dash'); } catch (_) {}
      }

      function saveSession() {
        try { sessionStorage.removeItem('mflow_dash'); } catch (_) {}
      }

      function esc(str) {
        var d = document.createElement('div');
        d.textContent = str;
        return d.innerHTML;
      }

      function formatUptime(sec) {
        if (sec < 60) return sec + 's';
        if (sec < 3600) return Math.floor(sec / 60) + 'm';
        return Math.floor(sec / 3600) + 'h ' + Math.floor((sec % 3600) / 60) + 'm';
      }

      function relativeTime(ts) {
        var diff = Math.max(0, Math.floor((Date.now() - ts) / 1000));
        if (diff < 60) return diff + 's';
        if (diff < 3600) return Math.floor(diff / 60) + 'm';
        return Math.floor(diff / 3600) + 'h';
      }

      function updateUI() {
        var githubGate = document.getElementById('github-gate');
        var roomGate = document.getElementById('room-gate');
        var loginRow = document.getElementById('login-row');
        var badgeRow = document.getElementById('room-badge-row');
        var roomData = document.getElementById('room-data');
        var userInfo = document.getElementById('user-info');
        if (authenticated) { userInfo.classList.remove('hidden'); } else { userInfo.classList.add('hidden'); }

        if (authRequired && !authenticated) {
          githubGate.classList.remove('hidden');
          roomGate.classList.add('hidden');
          roomData.classList.add('hidden');
          return;
        }

        githubGate.classList.add('hidden');
        roomGate.classList.remove('hidden');

        if (mode === 'room') {
          loginRow.classList.add('hidden');
          badgeRow.classList.remove('hidden');
          roomData.classList.remove('hidden');
        } else {
          loginRow.classList.remove('hidden');
          badgeRow.classList.add('hidden');
          roomData.classList.add('hidden');
        }
      }

      function refresh() {
        var request = mode === 'room' && secretHash
          ? fetch('/api/rooms', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ secretHash: secretHash })
            })
          : fetch('/api/rooms');
        request
          .then(function(res) {
            if (res.status === 401) { authenticated = false; updateUI(); return; }
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
          })
          .then(function(data) {
            if (!data) return;
            consecutiveErrors = 0;
            document.getElementById('status-text').textContent = 'Online';
            document.getElementById('status-text').style.color = 'var(--green)';
            document.getElementById('uptime').textContent = formatUptime(data.uptime);
            document.getElementById('room-count').textContent = data.totalRooms;
            document.getElementById('peer-count').textContent = data.totalPeers;
            document.getElementById('error-banner').classList.add('hidden');

            if (mode === 'room' && data.rooms && data.rooms.length > 0) {
              var room = data.rooms[0];
              document.getElementById('active-room-id').textContent = 'Room: ' + room.id.substring(0, 16) + '...';

              var pCont = document.getElementById('peers-container');
              var pHtml = '';
              room.peers.forEach(function(p) {
                var tc = p.peerType === 'agent' ? 'agent' : 'human';
                pHtml += '<div class="peer-chip"><span class="peer-type ' + tc + '">' + p.peerType + '</span>' + esc(p.peerName) + '</div>';
              });
              pCont.innerHTML = pHtml || '<span style="color:var(--text-muted)">No peers connected</span>';

              var aCont = document.getElementById('activity-feed');
              var aHtml = '';
              var entries = room.activity || [];
              entries.sort((a,b) => b.timestamp - a.timestamp).slice(0, 20).forEach(function(e) {
                aHtml += '<div class="activity-row">';
                aHtml += '<span class="activity-time">' + relativeTime(e.timestamp) + ' ago</span>';
                aHtml += '<span class="activity-peer">' + esc(e.peerName) + '</span>';
                aHtml += '<div><span class="activity-action action-' + e.action + '">' + e.action + '</span></div>';
                aHtml += '<span class="activity-file" title="' + esc(e.file) + '">' + esc(e.file) + '</span>';
                aHtml += '</div>';
              });
              aCont.innerHTML = aHtml || '<div style="color:var(--text-muted); padding: 20px 0;">No recent activity</div>';
            } else if (mode === 'room') {
               // Room empty or secret invalid
               document.getElementById('active-room-id').textContent = 'Room empty or invalid secret';
               document.getElementById('peers-container').innerHTML = '<span style="color:var(--text-muted)">No peers connected</span>';
               document.getElementById('activity-feed').innerHTML = '<div style="color:var(--text-muted); padding: 20px 0;">No recent activity</div>';
            }
          })
          .catch(function(err) {
            consecutiveErrors++;
            document.getElementById('status-text').textContent = 'Error';
            document.getElementById('status-text').style.color = 'var(--red)';
          });
      }

      function loadAuthConfig() {
        return fetch('/api/auth/config')
          .then(function(res) { return res.json(); })
          .then(function(config) {
            authRequired = !!config.required;
            authenticated = !!config.authenticated;
            if (authenticated && config.user) {
                document.getElementById('user-avatar').src = config.user.avatarUrl;
                document.getElementById('user-login').textContent = config.user.login;
            }
          });
      }

      document.getElementById('login-btn').onclick = function() {
        var val = document.getElementById('secret-input').value.trim();
        if (!val) return;
        sha256(val).then(function(hash) {
          mode = 'room'; secretHash = hash;
          saveSession(); updateUI(); refresh();
        });
      };

      document.getElementById('secret-input').onkeydown = function(e) {
        if (e.key === 'Enter') document.getElementById('login-btn').click();
      };

      document.getElementById('logout-btn').onclick = function() {
        mode = 'public'; secretHash = null;
        saveSession(); updateUI();
        document.getElementById('secret-input').value = '';
        refresh();
      };

      document.getElementById('github-login-btn').onclick = function() {
        window.location.href = '/auth/github/start';
      };

      document.getElementById('auth-logout-btn').onclick = function(e) {
        e.preventDefault();
        fetch('/api/auth/logout', { method: 'POST' }).then(() => location.reload());
      };


      loadSession();
      loadAuthConfig().then(function() {
        updateUI();
        refresh();
        setInterval(refresh, 2000);
      });
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

  if (url.pathname === "/health" && req.method === "GET") {
    let totalPeers = 0;
    for (const room of rooms.values()) totalPeers += room.peers.size;

    return Response.json({
      status: "ok",
      rooms: rooms.size,
      peers: totalPeers,
      uptime: Math.floor((Date.now() - startTime) / 1000),
      memoryMB: 0,
    });
  }

  if (url.pathname === "/dashboard" && req.method === "GET") {
    if (dashboardAuthRequired && !(await getDashboardUser(req))) {
      return new Response(getDashboardAuthHtml(), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    return new Response(getDashboardHtml(), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  if (url.pathname === "/settings" && req.method === "GET") {
    if (dashboardAuthRequired && !(await getDashboardUser(req))) {
      return new Response(getDashboardAuthHtml(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    return new Response(getSettingsHtml(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  if (url.pathname === "/api/rooms" && req.method === "POST") {
    if (dashboardAuthRequired && !(await hasDashboardAccess(req))) {
      return Response.json({ error: "GitHub sign-in required" }, { status: 401 });
    }

    const body = await req.json().catch(() => null) as { secretHash?: unknown } | null;
    const secretHash = typeof body?.secretHash === "string" ? body.secretHash : "";
    if (!secretHash) return Response.json({ error: "secretHash is required" }, { status: 400 });

    const matched = getRoomDetailsBySecretHash(secretHash);
    let matchedPeers = 0;
    for (const r of matched) matchedPeers += r.peerCount;
    return Response.json({
      rooms: matched,
      totalRooms: matched.length,
      totalPeers: matchedPeers,
      uptime: Math.floor((Date.now() - startTime) / 1000),
      memoryMB: 0,
    });
  }

  if (url.pathname === "/api/rooms" && req.method === "GET") {
    if (dashboardAuthRequired && !(await hasDashboardAccess(req))) {
      return Response.json({ error: "GitHub sign-in required" }, { status: 401 });
    }

    let totalPeers = 0;
    for (const room of rooms.values()) totalPeers += room.peers.size;
    return Response.json({
      totalRooms: rooms.size,
      totalPeers,
      uptime: Math.floor((Date.now() - startTime) / 1000),
      memoryMB: 0,
    });
  }

  if (url.pathname === "/" && req.method === "GET" && !req.headers.get("upgrade")) {
    return new Response(getLandingHtml(), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

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
 * Landing page HTML served at /.
 */
function getSettingsHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>mflow settings</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root{color-scheme:dark;--bg:#08090b;--panel:rgba(24,24,27,.42);--line:rgba(255,255,255,.1);--line2:rgba(255,255,255,.18);--text:#f6f7f4;--muted:#9ca3af;--green:#34d399;--red:#f87171;--mono:'JetBrains Mono',monospace;--sans:'Inter',system-ui,sans-serif}*{box-sizing:border-box;margin:0;padding:0}body{min-height:100vh;background:radial-gradient(circle at 20% -10%,rgba(52,211,153,.12),transparent 32%),var(--bg);color:var(--text);font-family:var(--sans);-webkit-font-smoothing:antialiased}a{color:inherit;text-decoration:none}.app-shell{min-height:100vh;display:grid;grid-template-columns:236px 1fr}.sidebar{position:sticky;top:0;height:100vh;display:flex;flex-direction:column;padding:28px 18px;border-right:1px solid var(--line);background:rgba(8,9,13,.74)}.side-brand{display:flex;align-items:center;gap:10px;color:var(--text);font-size:20px;font-weight:800;letter-spacing:-.045em;margin:0 10px 32px}.side-brand:before{content:'';width:9px;height:9px;border-radius:999px;background:var(--green);box-shadow:0 0 18px rgba(52,211,153,.9)}.side-nav{display:grid;gap:8px}.side-link{display:flex;align-items:center;gap:10px;min-height:42px;padding:0 12px;border:1px solid transparent;border-radius:12px;color:var(--muted);font-weight:750;transition:background .16s,border-color .16s,color .16s}.side-link svg{width:18px;height:18px;fill:currentColor}.side-link:hover,.side-link[aria-current=page]{color:var(--text);border-color:var(--line);background:rgba(255,255,255,.045)}.side-spacer{flex:1}.side-user{display:grid;gap:10px;padding-top:16px;border-top:1px solid var(--line)}.side-user-card{display:flex;align-items:center;gap:10px;padding:8px;border:1px solid var(--line);border-radius:14px;background:rgba(255,255,255,.035)}.side-user-card img{width:30px;height:30px;border-radius:10px;border:1px solid var(--line)}.side-user-card span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:800}.side-actions{display:flex;gap:8px}.side-actions a,.side-actions button{flex:1;min-height:38px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--line);border-radius:11px;background:rgba(255,255,255,.035);color:var(--muted);font:inherit;font-weight:800;cursor:pointer}.side-actions a:hover,.side-actions button:hover{color:var(--text);border-color:var(--line2);background:rgba(255,255,255,.06)}.github-link svg{width:18px;height:18px;fill:currentColor}main{max-width:1180px;padding:46px 54px 80px}.back{display:inline-flex;align-items:center;gap:8px;width:fit-content;margin-bottom:30px;color:var(--muted);font-size:13px;font-weight:800}.back svg{width:17px;height:17px}.back:hover{color:var(--text)}.eyebrow{color:var(--green);font:700 12px var(--mono);text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px}h1{font-size:clamp(38px,5vw,70px);line-height:1;letter-spacing:-.06em;margin-bottom:22px}p{color:var(--muted);font-size:16px;line-height:1.6}.hero{margin-bottom:48px;animation:rise .32s ease both}.grid{display:grid;grid-template-columns:.85fr 1.15fr;gap:18px}.card{border:1px solid var(--line);border-radius:18px;background:var(--panel);box-shadow:0 20px 70px rgba(0,0,0,.28);padding:24px;animation:rise .38s ease both}.card h2{font-size:17px;margin-bottom:20px;letter-spacing:-.02em}.account{display:flex;align-items:center;gap:16px;margin-bottom:26px}.account img{width:58px;height:58px;border-radius:16px;border:1px solid var(--line2)}.account strong{display:block;font-size:20px}.form{display:grid;grid-template-columns:1fr auto auto;gap:10px;margin-bottom:20px}input,select{width:100%;background:#0b0d12;border:1px solid var(--line);border-radius:12px;color:var(--text);padding:12px 14px;font:inherit;outline:0}input:focus,select:focus{border-color:var(--green);box-shadow:0 0 0 3px rgba(52,211,153,.12)}.btn{border:0;border-radius:12px;background:#f6f7f4;color:#050607;padding:12px 16px;font:inherit;font-weight:850;cursor:pointer}.btn.ghost{background:transparent;color:var(--text);border:1px solid var(--line)}.btn.danger{background:rgba(248,113,113,.12);color:#fecaca;border:1px solid rgba(248,113,113,.22)}.key-once{display:none;margin:10px 0 18px;padding:14px;border:1px solid rgba(52,211,153,.28);background:rgba(52,211,153,.08);border-radius:14px}.key-once code{display:block;overflow:auto;font-family:var(--mono);font-size:13px;margin:8px 0}.row{display:grid;grid-template-columns:1fr 110px 110px 110px auto;gap:12px;align-items:center;padding:12px 0;border-top:1px solid rgba(255,255,255,.07);font-size:13px}.row .name{font-weight:750}.muted{color:var(--muted)}.suffix{font-family:var(--mono);color:var(--text)}.note{display:grid;gap:12px;color:var(--muted);font-size:14px}.note div{padding-left:14px;border-left:2px solid rgba(52,211,153,.4)}.error{color:var(--red);font-size:13px;margin-top:10px}.empty{padding:22px 0;color:var(--muted);font-size:16px}@keyframes rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}@media(max-width:820px){.app-shell{grid-template-columns:1fr}.sidebar{position:static;height:auto;padding:16px;border-right:0;border-bottom:1px solid var(--line)}.side-brand{margin-bottom:14px}.side-nav{grid-template-columns:1fr 1fr}.side-spacer{display:none}.side-user{margin-top:12px}main{padding:28px 16px}.grid{grid-template-columns:1fr}.form{grid-template-columns:1fr}.row{grid-template-columns:1fr;gap:5px}}
</style>
</head>
<body>
<div class="app-shell">
  <aside class="sidebar">
    <a href="/" class="side-brand">mflow</a>
    <nav class="side-nav" aria-label="Settings navigation">
      <a class="side-link" href="/dashboard"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 13h7V4H4v9Zm0 7h7v-5H4v5Zm9 0h7v-9h-7v9Zm0-16v5h7V4h-7Z"/></svg>Dashboard</a>
      <a class="side-link" href="/settings" aria-current="page"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.4 13.5a7.8 7.8 0 0 0 0-3l2-1.5-2-3.5-2.4 1a8 8 0 0 0-2.6-1.5L14 2.4h-4L9.6 5a8 8 0 0 0-2.6 1.5l-2.4-1-2 3.5 2 1.5a7.8 7.8 0 0 0 0 3l-2 1.5 2 3.5 2.4-1a8 8 0 0 0 2.6 1.5l.4 2.6h4l.4-2.6a8 8 0 0 0 2.6-1.5l2.4 1 2-3.5-2-1.5ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5Z"/></svg>Settings</a>
    </nav>
    <div class="side-spacer"></div>
    <div class="side-user">
      <div class="side-user-card" id="user-chip" hidden><img id="avatar" alt=""><span id="login"></span></div>
      <div class="side-actions"><button id="logout">Sign out</button><a class="github-link" href="https://github.com/Obed0101/mflow" target="_blank" rel="noreferrer" aria-label="Open mflow on GitHub"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 .5a12 12 0 0 0-3.79 23.39c.6.11.82-.26.82-.58v-2.02c-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.33-1.76-1.33-1.76-1.09-.74.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.8 1.3 3.49.99.11-.78.42-1.3.76-1.6-2.67-.3-5.47-1.33-5.47-5.92 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.24 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.6-2.81 5.61-5.49 5.91.43.37.81 1.1.81 2.22v3.29c0 .32.22.69.83.57A12 12 0 0 0 12 .5Z"/></svg></a></div>
    </div>
  </aside>
  <main>
    <a class="back" href="/dashboard"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M15.8 5.3 9.1 12l6.7 6.7-1.4 1.4L6.3 12l8.1-8.1 1.4 1.4Z"></path></svg>Back to dashboard</a>
    <section class="hero"><div class="eyebrow">Hosted settings</div><h1>Account and API keys.</h1><p>Create scoped hosted relay keys for CLI/admin room operations. Plaintext keys are shown once and never stored.</p></section>
    <div class="grid"><section class="card"><h2>Account</h2><div class="account"><img id="account-avatar" alt=""><div><strong id="account-name">Loading…</strong><p id="account-login">GitHub-authenticated dashboard session.</p></div></div><div class="note"><div>Session cookie is HttpOnly, SameSite=Lax, and Secure on HTTPS.</div><div>Room secrets stay separate from hosted dashboard keys.</div><div>Revoke keys you no longer use. Expired keys are rejected server-side.</div></div></section><section class="card"><h2>API keys</h2><div class="form"><input id="key-name" placeholder="Key name, e.g. Work laptop"><select id="key-exp"><option value="7d">7 days</option><option value="1d">1 day</option><option value="3d">3 days</option><option value="1m">1 month</option><option value="6m">6 months</option><option value="1y">1 year</option><option value="never">Never</option></select><button class="btn" id="create">Create key</button></div><div class="key-once" id="key-once"><strong>Copy this key now. It will not be shown again.</strong><code id="key-plain"></code><button class="btn ghost" id="copy">Copy</button></div><div id="error" class="error"></div><div id="keys"></div></section></div>
  </main>
</div>
<script>
(function(){var user=null;function esc(v){var d=document.createElement('div');d.textContent=v==null?'':String(v);return d.innerHTML}function fmt(ts){return ts?new Date(ts).toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'}):'Never'}function rel(ts){return ts?new Date(ts).toLocaleString():'Never'}function auth(){return fetch('/api/auth/config').then(r=>r.json()).then(c=>{if(c.required&&!c.authenticated){location.href='/dashboard';return}user=c.user||{login:'self-hosted',name:'Self-hosted admin',avatarUrl:''};document.getElementById('login').textContent=user.login;document.getElementById('account-name').textContent=user.name||user.login;document.getElementById('account-login').textContent='@'+user.login;['avatar','account-avatar'].forEach(id=>{var img=document.getElementById(id);if(user.avatarUrl)img.src=user.avatarUrl;else img.style.display='none'});document.getElementById('user-chip').hidden=false})}function load(){return fetch('/api/api-keys').then(r=>r.json()).then(d=>{var keys=d.keys||[];document.getElementById('keys').innerHTML=keys.length?keys.map(k=>'<div class="row"><div><div class="name">'+esc(k.name)+'</div><div class="muted">Created '+rel(k.createdAt)+'</div></div><div><div class="muted">Suffix</div><div class="suffix">••••'+esc(k.suffix)+'</div></div><div><div class="muted">Expires</div>'+fmt(k.expiresAt)+'</div><div><div class="muted">Last used</div>'+fmt(k.lastUsedAt)+'</div><button class="btn danger" data-revoke="'+esc(k.id)+'" '+(k.revokedAt?'disabled':'')+'>'+(k.revokedAt?'Revoked':'Revoke')+'</button></div>').join(''):'<div class="empty">No API keys yet.</div>';document.querySelectorAll('[data-revoke]').forEach(b=>b.onclick=function(){fetch('/api/api-keys/'+this.dataset.revoke+'/revoke',{method:'POST'}).then(load)})})}document.getElementById('create').onclick=function(){document.getElementById('error').textContent='';fetch('/api/api-keys',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:document.getElementById('key-name').value,expiresIn:document.getElementById('key-exp').value})}).then(async r=>{var d=await r.json();if(!r.ok)throw new Error(d.error||'Failed to create key');document.getElementById('key-plain').textContent=d.plaintext;document.getElementById('key-once').style.display='block';document.getElementById('key-name').value='';return load()}).catch(e=>document.getElementById('error').textContent=e.message)};document.getElementById('copy').onclick=function(){navigator.clipboard.writeText(document.getElementById('key-plain').textContent||'')};document.getElementById('logout').onclick=function(){fetch('/api/auth/logout',{method:'POST'}).then(()=>location.href='/dashboard')};auth().then(load)})();
</script>
</body>
</html>`;
}


function getLandingHtml(): string {
  return LANDING_HTML;
}

const LANDING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>mflow — real-time code sync for AI agent teams</title>
<meta name="description" content="Open-source file sync between worktrees while AI agents edit. Room + secret access, self-hostable, MIT licensed."/>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet"/>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0a0a0c;
  --surface:#141416;
  --surface-2:#1a1a1e;
  --border:rgba(255,255,255,.08);
  --border-hover:rgba(255,255,255,.16);
  --text:#e8e8ed;
  --text-2:#a0a0ab;
  --text-3:#5a5a66;
  --accent:#34d399;
  --accent-dim:rgba(52,211,153,.12);
  --accent-glow:rgba(52,211,153,.06);
  --mono:'JetBrains Mono',ui-monospace,monospace;
  --sans:'Inter',-apple-system,sans-serif;
}
html{scroll-behavior:smooth}
body{
  background:var(--bg);color:var(--text);
  font-family:var(--sans);font-size:15px;line-height:1.6;
  -webkit-font-smoothing:antialiased;
}
a{color:inherit;text-decoration:none}
.w{max-width:1080px;margin:0 auto;padding:0 32px}

/* ── Ambient glow ─────────────────────────── */
.glow{
  position:fixed;top:-400px;left:50%;transform:translateX(-50%);
  width:900px;height:900px;pointer-events:none;z-index:0;
  background:radial-gradient(circle,var(--accent-glow) 0%,transparent 60%);
  opacity:.7;
}

/* ── Nav ──────────────────────────────────── */
nav{
  position:fixed;top:0;left:0;right:0;z-index:100;
  background:rgba(10,10,12,.85);backdrop-filter:blur(16px);
  border-bottom:1px solid var(--border);
}
.nav-inner{
  display:grid;grid-template-columns:1fr auto 1fr;align-items:center;
  height:56px;
}
.nav-brand{font-size:16px;font-weight:700;letter-spacing:-.02em;justify-self:start}
.nav-center{display:flex;align-items:center;gap:28px;justify-self:center}
.nav-center a{font-size:13px;color:var(--text-2);font-weight:500;transition:color .15s}
.nav-center a:hover{color:var(--text)}
.nav-right{justify-self:end;display:flex;align-items:center;gap:10px}
.nav-dashboard{
  display:inline-flex;align-items:center;gap:6px;
  font-size:13px;font-weight:700;color:#000;
  padding:8px 16px;border-radius:8px;
  background:#fff;
  transition:transform .15s,opacity .15s;
}
.nav-dashboard:hover{transform:translateY(-1px);opacity:.92}
.nav-gh{
  display:inline-flex;align-items:center;gap:6px;
  font-size:13px;font-weight:600;color:var(--text);
  padding:6px 14px;border-radius:6px;
  border:1px solid var(--border);transition:border-color .15s,background .15s;
}
.nav-gh:hover{border-color:var(--border-hover);background:var(--surface)}
.nav-gh svg{width:16px;height:16px;fill:currentColor}

/* ── Hero ─────────────────────────────────── */
.hero{padding:140px 0 100px;text-align:center;position:relative;z-index:1}
.hero-badge{
  display:inline-block;font-size:12px;font-weight:600;
  color:var(--accent);letter-spacing:.04em;
  padding:5px 14px;border-radius:100px;
  border:1px solid rgba(52,211,153,.25);background:var(--accent-dim);
  margin-bottom:28px;
}
.hero h1{
  font-size:clamp(38px,5.5vw,60px);font-weight:800;
  letter-spacing:-.045em;line-height:1.08;margin-bottom:20px;
  color:#fff;
}
.hero .sub{
  font-size:18px;color:var(--text-2);max-width:540px;
  margin:0 auto 36px;line-height:1.55;
}
.hero-btns{display:flex;justify-content:center;gap:12px;flex-wrap:wrap}
.btn-p{
  display:inline-flex;align-items:center;gap:6px;
  padding:11px 24px;border-radius:8px;font-size:14px;font-weight:600;
  background:#fff;color:#000;transition:opacity .15s;
}
.btn-p:hover{opacity:.88}
.btn-s{
  display:inline-flex;align-items:center;gap:6px;
  padding:11px 24px;border-radius:8px;font-size:14px;font-weight:600;
  border:1px solid var(--border);color:var(--text);
  transition:border-color .15s,background .15s;
}
.btn-s:hover{border-color:var(--border-hover);background:var(--surface)}

/* ── Terminal ─────────────────────────────── */
.term-wrap{max-width:640px;margin:56px auto 0}
.term{
  background:#0f0f11;border:1px solid var(--border);
  border-radius:10px;overflow:hidden;
  box-shadow:0 20px 60px rgba(0,0,0,.5);
}
.term-bar{
  display:flex;align-items:center;gap:7px;
  padding:11px 16px;border-bottom:1px solid var(--border);
}
.term-dot{width:11px;height:11px;border-radius:50%}
.term-dot:nth-child(1){background:#ff5f57}
.term-dot:nth-child(2){background:#febc2e}
.term-dot:nth-child(3){background:#28c840}
.term-label{margin-left:auto;font-size:11px;color:var(--text-3);font-family:var(--mono)}
.term pre{
  padding:20px;font-family:var(--mono);font-size:13px;
  line-height:1.75;color:var(--text-2);overflow-x:auto;
}
.term .p{color:var(--accent)}
.term .c{color:#fff}
.term .g{color:var(--accent)}
.term .d{color:var(--text-3)}

/* ── Section ──────────────────────────────── */
section{padding:100px 0;position:relative;z-index:1}
.s-label{
  font-size:12px;font-weight:700;color:var(--accent);
  text-transform:uppercase;letter-spacing:.1em;margin-bottom:10px;
}
.s-title{font-size:30px;font-weight:700;letter-spacing:-.03em;margin-bottom:14px;color:#fff}
.s-desc{color:var(--text-2);max-width:520px;margin-bottom:40px;font-size:16px;line-height:1.6}
.s-center{text-align:center}
.s-center .s-desc{margin-left:auto;margin-right:auto}

/* ── Feature grid (How it works) ──────────── */
.feat-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--border);border-radius:14px;overflow:hidden}
.feat{background:var(--surface);padding:36px 28px}
.feat-icon{
  width:40px;height:40px;border-radius:10px;margin-bottom:18px;
  display:flex;align-items:center;justify-content:center;
  background:var(--accent-dim);color:var(--accent);
}
.feat-icon svg{width:20px;height:20px}
.feat h3{font-size:16px;font-weight:700;margin-bottom:8px;color:#fff}
.feat p{font-size:14px;color:var(--text-2);line-height:1.55}

/* ── Access model ─────────────────────────── */
.access-card{
  background:var(--surface);border:1px solid var(--border);
  border-radius:14px;overflow:hidden;
}
.access-top{padding:40px 36px 32px}
.access-steps{
  display:grid;grid-template-columns:repeat(3,1fr);gap:1px;
  background:var(--border);
}
.access-step{background:var(--surface);padding:24px}
.access-step .num{font-size:11px;font-weight:700;color:var(--accent);margin-bottom:6px}
.access-step strong{display:block;font-size:14px;margin-bottom:4px;color:#fff}
.access-step span{font-size:13px;color:var(--text-2)}
.access-note{
  padding:20px 36px;border-top:1px solid var(--border);
  font-size:13px;color:var(--text-2);
  background:var(--accent-dim);
}
.access-note strong{color:var(--text);font-weight:600}

/* ── Limits ───────────────────────────────── */
.limits-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--border);border-radius:14px;overflow:hidden}
.limit{background:var(--surface);padding:28px 24px}
.limit-val{font-size:28px;font-weight:800;color:#fff;font-family:var(--mono);line-height:1.1}
.limit-name{font-size:14px;font-weight:600;margin:6px 0 4px;color:var(--text)}
.limit-desc{font-size:13px;color:var(--text-3)}

/* ── Dashboard promo ──────────────────────── */
.promo{
  background:var(--surface);border:1px solid var(--border);
  border-radius:14px;overflow:hidden;
  display:grid;grid-template-columns:1fr 1fr;
}
.promo-text{padding:48px 40px;display:flex;flex-direction:column;justify-content:center}
.promo-text h2{font-size:26px;font-weight:700;margin-bottom:14px;color:#fff;letter-spacing:-.02em}
.promo-text p{font-size:15px;color:var(--text-2);margin-bottom:8px;line-height:1.55}
.promo-path{font-family:var(--mono);font-size:13px;color:var(--text-3);margin-bottom:24px}
.promo-visual{
  background:linear-gradient(135deg,var(--surface-2),rgba(52,211,153,.05));
  padding:40px;display:flex;align-items:center;justify-content:center;
  border-left:1px solid var(--border);
}
.promo-mock{
  width:100%;background:var(--bg);border:1px solid var(--border);
  border-radius:10px;padding:24px;font-family:var(--mono);font-size:12px;
  line-height:2;color:var(--text-2);
}
.promo-mock .hl{color:var(--accent)}

/* ── Quick start ──────────────────────────── */
.qs-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:24px}
.qs-step .qs-num{
  font-size:11px;font-weight:700;color:var(--accent);
  text-transform:uppercase;letter-spacing:.08em;margin-bottom:12px;
}
.qs-code{
  padding:16px;background:var(--surface);
  border:1px solid var(--border);border-radius:8px;
  font-family:var(--mono);font-size:13px;line-height:1.6;color:var(--text);
}
.qs-code .cmt{color:var(--text-3)}

/* ── Extras ───────────────────────────────── */
.extras{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--border);border-radius:14px;overflow:hidden}
.extra{background:var(--surface);padding:28px 24px}
.extra h4{font-size:15px;font-weight:700;margin-bottom:6px;color:#fff}
.extra p{font-size:14px;color:var(--text-2);line-height:1.5}

/* ── Footer ───────────────────────────────── */
footer{border-top:1px solid var(--border);padding:64px 0 40px;position:relative;z-index:1}
.ftr-grid{display:flex;justify-content:space-between;gap:48px;margin-bottom:40px}
.ftr-brand-col{max-width:240px}
.ftr-brand{font-size:18px;font-weight:700;margin-bottom:10px}
.ftr-tagline{font-size:13px;color:var(--text-2);line-height:1.5}
.ftr-links{display:flex;gap:48px}
.ftr-col-title{font-size:11px;font-weight:700;color:var(--text);text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px}
.ftr-col a,.ftr-col span{display:block;font-size:13px;color:var(--text-2);margin-bottom:8px;transition:color .15s}
.ftr-col a:hover{color:var(--accent)}
.ftr-bottom{padding-top:24px;border-top:1px solid var(--border);font-size:13px;color:var(--text-3)}

/* ── Responsive ───────────────────────────── */
@media(max-width:768px){
  .nav-inner{display:flex;justify-content:space-between}
  .nav-center{display:none}
  .hero{padding:110px 0 60px}
  .feat-grid,.limits-grid,.qs-grid,.extras,.access-steps{grid-template-columns:1fr}
  .promo{grid-template-columns:1fr}
  .promo-visual{border-left:none;border-top:1px solid var(--border)}
  .ftr-grid{flex-direction:column;gap:32px}
  .ftr-links{flex-wrap:wrap;gap:32px}
  section{padding:64px 0}
}
</style>
</head>
<body>
<div class="glow"></div>

<nav>
  <div class="w nav-inner">
    <a href="/" class="nav-brand">mflow</a>
    <div class="nav-center">
      <a href="#how">How it works</a>
      <a href="#access">Access</a>
      <a href="#limits">Limits</a>
      <a href="#quickstart">Quick Start</a>
    </div>
    <div class="nav-right">
      <a href="/dashboard" class="nav-dashboard">Dashboard</a>
      <a href="https://github.com/Obed0101/mflow" class="nav-gh"><svg viewBox="0 0 16 16"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>GitHub</a>
    </div>
  </div>
</nav>

<main>

<div class="w">
  <div class="hero">
    <div class="hero-badge">Open source · MIT licensed · self-hostable</div>
    <h1>Real-time file sync<br/>for AI agent teams</h1>
    <p class="sub">Sync working files across worktrees while agents edit in parallel. No account needed — just a room name and a strong secret.</p>
    <div class="hero-btns">
      <a class="btn-p" href="/dashboard">Open Dashboard</a>
      <a class="btn-s" href="#quickstart">Install CLI</a>
      <a class="btn-s" href="https://github.com/Obed0101/mflow" style="gap:8px"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>GitHub</a>
    </div>

    <div class="term-wrap">
      <div class="term">
        <div class="term-bar">
          <div class="term-dot"></div>
          <div class="term-dot"></div>
          <div class="term-dot"></div>
          <span class="term-label">bash</span>
        </div>
        <pre><span class="p">$</span> <span class="c">npm i -g mflow-sdk</span>
<span class="p">$</span> <span class="c">mflow start --room my-project --secret "$MFLOW_SECRET"</span>

<span class="g">✓ Connected to public relay (fair-use: 4 peers/room)</span>
  <span class="d">↑ src/auth.ts synced → 3 peers</span>
  <span class="d">! Treat the room secret like a password</span></pre>
      </div>
    </div>
  </div>
</div>

<!-- How it works -->
<section id="how">
  <div class="w">
    <div class="s-label">How it works</div>
    <h2 class="s-title">File sync, not chat sync</h2>
    <p class="s-desc">Mflow propagates file changes between peers. It does not sync chat history, tool logs, or agent memory.</p>
    <div class="feat-grid">
      <div class="feat">
        <div class="feat-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4"/></svg></div>
        <h3>Sync</h3>
        <p>File changes propagate between peers through encrypted room traffic.</p>
      </div>
      <div class="feat">
        <div class="feat-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg></div>
        <h3>Encrypt</h3>
        <p>Room secrets derive encryption keys. The relay should not be treated as trusted storage.</p>
      </div>
      <div class="feat">
        <div class="feat-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg></div>
        <h3>Coordinate</h3>
        <p>Pause/resume and file locks help avoid conflicts during git operations or hot-file edits.</p>
      </div>
    </div>
  </div>
</section>

<!-- Access Model -->
<section id="access">
  <div class="w">
    <div class="access-card">
      <div class="access-top">
        <div class="s-label">Access model</div>
        <h2 class="s-title">Room + secret based</h2>
        <p style="color:var(--text-2);font-size:15px;line-height:1.6;max-width:560px">No login or register flow in the OSS release. The dashboard hashes your room secret in the browser and only sends the hash. The plaintext secret never leaves your machine.</p>
      </div>
      <div class="access-steps">
        <div class="access-step"><div class="num">Step 1</div><strong>Start a room</strong><span>Run the CLI with a room name and a strong secret.</span></div>
        <div class="access-step"><div class="num">Step 2</div><strong>Share the secret</strong><span>Give it only to trusted peers, out-of-band.</span></div>
        <div class="access-step"><div class="num">Step 3</div><strong>Monitor</strong><span>Open /dashboard and enter the same secret.</span></div>
      </div>
      <div class="access-note"><strong>Hosted relay auth ·</strong> The hosted dashboard can require GitHub device sign-in before showing room status. Sync peers still join with room + secret. Self-hosted deployments can keep auth disabled.</div>
    </div>
  </div>
</section>

<!-- Limits -->
<section id="limits">
  <div class="w">
    <div class="s-center">
      <div class="s-label">Public relay limits</div>
      <h2 class="s-title">Fair-use defaults</h2>
      <p class="s-desc">These limits protect the shared Deno free-tier relay. Self-host for larger rooms or production reliability.</p>
    </div>
    <div class="limits-grid">
      <div class="limit"><div class="limit-val">4</div><div class="limit-name">peers per room</div><div class="limit-desc">Enough for demos and small agent swarms.</div></div>
      <div class="limit"><div class="limit-val">64 KB</div><div class="limit-name">max message size</div><div class="limit-desc">Oversized messages rejected before parsing.</div></div>
      <div class="limit"><div class="limit-val">120/m</div><div class="limit-name">messages per IP</div><div class="limit-desc">Repeated violations disconnect the socket.</div></div>
      <div class="limit"><div class="limit-val">10/m</div><div class="limit-name">joins per IP</div><div class="limit-desc">Protects room auth from noisy clients.</div></div>
      <div class="limit"><div class="limit-val">5</div><div class="limit-name">unauth sockets/IP</div><div class="limit-desc">Unauthenticated sockets auto-timeout.</div></div>
      <div class="limit"><div class="limit-val">500</div><div class="limit-name">global unauth cap</div><div class="limit-desc">Relay-wide cap before authentication.</div></div>
      <div class="limit"><div class="limit-val">200</div><div class="limit-name">active rooms</div><div class="limit-desc">Room cap for the shared hosted relay.</div></div>
      <div class="limit"><div class="limit-val">15 m</div><div class="limit-name">idle room TTL</div><div class="limit-desc">Idle rooms are eligible for cleanup.</div></div>
      <div class="limit"><div class="limit-val">20</div><div class="limit-name">activity entries</div><div class="limit-desc">Dashboard activity is intentionally bounded.</div></div>
    </div>
  </div>
</section>

<!-- Dashboard promo -->
<section>
  <div class="w">
    <div class="promo">
      <div class="promo-text">
        <h2>Monitor your sync room</h2>
        <p>Use the dashboard to see connected peers and recent room activity. Enter the same room secret you used in the CLI.</p>
        <div class="promo-path">/dashboard</div>
        <a class="btn-p" href="/dashboard" style="width:fit-content">Open Monitor</a>
      </div>
      <div class="promo-visual">
        <div class="promo-mock">
          <div style="display:flex;justify-content:space-between;margin-bottom:16px"><span class="hl">SIGNAL SERVER: ACTIVE</span><span>FAIR-USE RELAY</span></div>
          <div><span class="hl">[ROOM]</span> 4 peers max on public relay</div>
          <div><span class="hl">[SYNC]</span> src/auth.ts → 3 peers</div>
          <div><span class="hl">[LOCK]</span> db.ts locked by agent-beta</div>
          <div style="opacity:.4"><span class="hl">[SELF-HOST]</span> raise limits with MFLOW_* env vars</div>
        </div>
      </div>
    </div>
  </div>
</section>

<!-- Quick Start -->
<section id="quickstart">
  <div class="w">
    <div class="s-center" style="margin-bottom:48px">
      <h2 class="s-title">Quick Start</h2>
    </div>
    <div class="qs-grid">
      <div class="qs-step">
        <div class="qs-num">1. Install</div>
        <div class="qs-code"><span class="cmt"># npm package, CLI binary is mflow</span><br/>npm i -g mflow-sdk</div>
      </div>
      <div class="qs-step">
        <div class="qs-num">2. Start syncing</div>
        <div class="qs-code"><span class="cmt"># From project root</span><br/>mflow start --room project-x \\<br/>  --secret "$MFLOW_SECRET"</div>
      </div>
      <div class="qs-step">
        <div class="qs-num">3. Join from another worktree</div>
        <div class="qs-code"><span class="cmt"># Same room and same secret</span><br/>mflow start --room project-x \\<br/>  --secret "$MFLOW_SECRET"</div>
      </div>
    </div>
  </div>
</section>

<!-- Extras -->
<section>
  <div class="w">
    <div class="extras">
      <div class="extra"><h4>Self-hostable</h4><p>Run your own signaling server on Deno Deploy, Bun, Docker, or private infrastructure.</p></div>
      <div class="extra"><h4>MCP and CLI</h4><p>Works from CLI first, with MCP integration for supported harnesses.</p></div>
      <div class="extra"><h4>Future managed relay</h4><p>Managed/private relay may come later. Core OSS and self-hosting remain the base path.</p></div>
    </div>
  </div>
</section>

</main>

<footer>
  <div class="w">
    <div class="ftr-grid">
      <div class="ftr-brand-col">
        <div class="ftr-brand">mflow</div>
        <div class="ftr-tagline">Open-source real-time code sync for AI agent teams.</div>
      </div>
      <div class="ftr-links">
        <div class="ftr-col">
          <div class="ftr-col-title">Resources</div>
          <a href="https://github.com/Obed0101/mflow">GitHub</a>
          <a href="#quickstart">Documentation</a>
        </div>
        <div class="ftr-col">
          <div class="ftr-col-title">Product</div>
          <a href="/dashboard">Monitor</a>
          <a href="#limits">Limits</a>
        </div>
        <div class="ftr-col">
          <div class="ftr-col-title">Legal</div>
          <span>MIT License</span>
        </div>
      </div>
    </div>
    <div class="ftr-bottom">Made for AI agent teams. No hosted account required.</div>
  </div>
</footer>
</body>
</html>`;
