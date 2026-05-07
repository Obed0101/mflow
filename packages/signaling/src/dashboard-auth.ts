import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";

export interface DashboardUser {
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface DashboardAuthConfig {
  required: boolean;
  githubClientId: string | null;
  githubClientSecret: string | null;
  githubCallbackUrl: string | null;
  apiKeyPepper: string | null;
  sessionSecret: string | null;
}

interface DeviceFlow {
  deviceCode: string;
  intervalSeconds: number;
  expiresAt: number;
}

interface Session {
  user: DashboardUser;
  expiresAt: number;
}

export interface DashboardApiKey {
  id: string;
  userId: number;
  name: string;
  hash: string;
  suffix: string;
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export interface DashboardAuthStore {
  getSession(token: string): Promise<Session | null>;
  setSession(token: string, session: Session): Promise<void>;
  deleteSession(token: string): Promise<void>;
  createApiKey(key: DashboardApiKey): Promise<void>;
  listApiKeys(userId: number): Promise<DashboardApiKey[]>;
  getApiKeyByHash(hash: string): Promise<DashboardApiKey | null>;
  updateApiKey(key: DashboardApiKey): Promise<void>;
}

class MemoryDashboardAuthStore implements DashboardAuthStore {
  private readonly sessions = new Map<string, Session>();
  private readonly apiKeys = new Map<string, DashboardApiKey>();

  async getSession(token: string): Promise<Session | null> {
    return this.sessions.get(token) ?? null;
  }

  async setSession(token: string, session: Session): Promise<void> {
    this.sessions.set(token, session);
  }

  async deleteSession(token: string): Promise<void> {
    this.sessions.delete(token);
  }

  async createApiKey(key: DashboardApiKey): Promise<void> {
    this.apiKeys.set(key.hash, key);
  }

  async listApiKeys(userId: number): Promise<DashboardApiKey[]> {
    return [...this.apiKeys.values()].filter((key) => key.userId === userId).sort((a, b) => b.createdAt - a.createdAt);
  }

  async getApiKeyByHash(hash: string): Promise<DashboardApiKey | null> {
    return this.apiKeys.get(hash) ?? null;
  }

  async updateApiKey(key: DashboardApiKey): Promise<void> {
    this.apiKeys.set(key.hash, key);
  }
}

const flows = new Map<string, DeviceFlow>();
const oauthStates = new Map<string, number>();
const mutationLimits = new Map<string, number[]>();
const store: DashboardAuthStore = new MemoryDashboardAuthStore();

export function loadDashboardAuthConfig(env: Record<string, string | undefined> = process.env): DashboardAuthConfig {
  const githubClientId = env["MFLOW_HOSTED_GITHUB_CLIENT_ID"]?.trim() || null;
  const githubClientSecret = env["MFLOW_HOSTED_GITHUB_CLIENT_SECRET"]?.trim() || null;
  const githubCallbackUrl = env["MFLOW_HOSTED_GITHUB_CALLBACK_URL"]?.trim() || null;
  const apiKeyPepper = env["MFLOW_API_KEY_PEPPER"]?.trim() || null;
  const sessionSecret = env["MFLOW_SESSION_SECRET"]?.trim() || apiKeyPepper || githubClientSecret;
  return {
    required: parseBoolean(env["MFLOW_REQUIRE_DASHBOARD_AUTH"], false),
    githubClientId,
    githubClientSecret,
    githubCallbackUrl,
    apiKeyPepper,
    sessionSecret,
  };
}

export async function getDashboardUser(req: Request, config: DashboardAuthConfig = loadDashboardAuthConfig()): Promise<DashboardUser | null> {
  const token = getCookie(req.headers.get("cookie"), "mflow_session");
  if (!token) return null;
  const signed = verifySignedSession(token, config.sessionSecret);
  if (signed) return signed;
  const session = await store.getSession(token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    await store.deleteSession(token);
    return null;
  }
  return session.user;
}

export async function handleAuthRequest(req: Request, config: DashboardAuthConfig): Promise<Response | null> {
  const url = new URL(req.url);

  if (url.pathname === "/api/auth/config" && req.method === "GET") {
    const user = await getDashboardUser(req, config);
    return Response.json({
      required: config.required,
      provider: "github",
      configured: Boolean(config.githubClientId && config.githubClientSecret),
      apiKeysConfigured: Boolean(config.apiKeyPepper),
      authenticated: Boolean(user),
      user,
    });
  }

  if (url.pathname === "/api/api-keys" && req.method === "GET") {
    const user = await requireDashboardUser(req, config);
    if (!user) return Response.json({ error: "Sign-in required" }, { status: 401 });
    const keys = await store.listApiKeys(user.id);
    return Response.json({ keys: keys.map(publicApiKey) });
  }

  if (url.pathname === "/api/api-keys" && req.method === "POST") {
    const user = await requireDashboardUser(req, config);
    if (!user) return Response.json({ error: "Sign-in required" }, { status: 401 });
    if (!config.apiKeyPepper) return Response.json({ error: "API key creation is not configured on this relay" }, { status: 503 });
    if (!checkMutationLimit(`create:${user.id}`)) return Response.json({ error: "Too many requests" }, { status: 429 });

    const body = await readJson(req);
    const name = sanitizeName(typeof body?.name === "string" ? body.name : "");
    const expiresIn = typeof body?.expiresIn === "string" ? body.expiresIn : "";
    const expiresAt = expirationToTimestamp(expiresIn);
    if (!name) return Response.json({ error: "Name is required" }, { status: 400 });
    if (expiresAt === undefined) return Response.json({ error: "Invalid expiration" }, { status: 400 });

    const plaintext = `mflow_key_${randomBytes(24).toString("base64url")}`;
    const key: DashboardApiKey = {
      id: randomUUID(),
      userId: user.id,
      name,
      hash: hashApiKey(plaintext, config.apiKeyPepper),
      suffix: plaintext.slice(-8),
      createdAt: Date.now(),
      expiresAt,
      lastUsedAt: null,
      revokedAt: null,
    };
    await store.createApiKey(key);
    return Response.json({ key: publicApiKey(key), plaintext }, { status: 201 });
  }

  const revokeMatch = url.pathname.match(/^\/api\/api-keys\/([^/]+)\/revoke$/);
  if (revokeMatch && req.method === "POST") {
    const user = await requireDashboardUser(req, config);
    if (!user) return Response.json({ error: "Sign-in required" }, { status: 401 });
    if (!checkMutationLimit(`revoke:${user.id}`)) return Response.json({ error: "Too many requests" }, { status: 429 });
    const keys = await store.listApiKeys(user.id);
    const key = keys.find((item) => item.id === revokeMatch[1]);
    if (!key) return Response.json({ error: "Not found" }, { status: 404 });
    key.revokedAt = Date.now();
    await store.updateApiKey(key);
    return Response.json({ ok: true, key: publicApiKey(key) });
  }

  if (url.pathname === "/auth/github/start" && req.method === "GET") {
    if (!config.required) return redirect("/dashboard");
    if (!config.githubClientId || !config.githubClientSecret) {
      return Response.json({ error: "GitHub OAuth is not configured" }, { status: 503 });
    }

    const state = randomUUID();
    oauthStates.set(state, Date.now() + 10 * 60 * 1000);
    const callbackUrl = getCallbackUrl(req, config);
    const githubUrl = new URL("https://github.com/login/oauth/authorize");
    githubUrl.searchParams.set("client_id", config.githubClientId);
    githubUrl.searchParams.set("redirect_uri", callbackUrl);
    githubUrl.searchParams.set("scope", "read:user");
    githubUrl.searchParams.set("state", state);

    return redirect(githubUrl.toString(), {
      "Set-Cookie": oauthStateCookie(state, url.protocol === "https:"),
    });
  }

  if (url.pathname === "/auth/github/callback" && req.method === "GET") {
    if (!config.required) return redirect("/dashboard");
    if (!config.githubClientId || !config.githubClientSecret) {
      return Response.json({ error: "GitHub OAuth is not configured" }, { status: 503 });
    }

    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code") ?? "";
    const cookieState = getCookie(req.headers.get("cookie"), "mflow_oauth_state") ?? "";
    if (!code || !state || state !== cookieState || !isValidOAuthState(state)) {
      if (state) oauthStates.delete(state);
      return redirect("/dashboard?auth_error=invalid_state", {
        "Set-Cookie": clearOAuthStateCookie(url.protocol === "https:"),
      });
    }
    oauthStates.delete(state);

    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Accept": "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: config.githubClientId, client_secret: config.githubClientSecret, code, redirect_uri: getCallbackUrl(req, config) }),
    });
    const tokenPayload = await tokenRes.json() as { access_token?: string };
    if (!tokenRes.ok || !tokenPayload.access_token) {
      return redirect("/dashboard?auth_error=github_token", { "Set-Cookie": clearOAuthStateCookie(url.protocol === "https:") });
    }

    const user = await fetchGitHubUser(tokenPayload.access_token);
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
    const token = createSessionToken(user, expiresAt, config);
    if (!isSignedSessionToken(token)) await store.setSession(token, { user, expiresAt });

    const headers = new Headers();
    headers.append("Set-Cookie", sessionCookie(token, url.protocol === "https:"));
    headers.append("Set-Cookie", clearOAuthStateCookie(url.protocol === "https:"));
    return redirect("/dashboard", headers);
  }

  if (url.pathname === "/api/auth/github/device/start" && req.method === "POST") {
    if (!config.required) return Response.json({ error: "dashboard auth is not required" }, { status: 400 });
    if (!config.githubClientId) return Response.json({ error: "GitHub auth is not configured" }, { status: 503 });
    const githubRes = await fetch("https://github.com/login/device/code", {
      method: "POST",
      headers: { "Accept": "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: config.githubClientId, scope: "read:user" }),
    });
    const payload = await githubRes.json() as { device_code?: string; user_code?: string; verification_uri?: string; expires_in?: number; interval?: number; error?: string; error_description?: string };
    if (!githubRes.ok || !payload.device_code || !payload.user_code || !payload.verification_uri) {
      return Response.json({ error: normalizeGitHubDeviceFlowError(payload.error_description ?? payload.error) }, { status: 502 });
    }
    const flowId = randomUUID();
    flows.set(flowId, { deviceCode: payload.device_code, intervalSeconds: Math.max(1, payload.interval ?? 5), expiresAt: Date.now() + Math.max(1, payload.expires_in ?? 900) * 1000 });
    return Response.json({ flowId, userCode: payload.user_code, verificationUri: payload.verification_uri, expiresIn: payload.expires_in ?? 900, interval: payload.interval ?? 5 });
  }

  if (url.pathname === "/api/auth/github/device/poll" && req.method === "POST") {
    if (!config.required) return Response.json({ error: "dashboard auth is not required" }, { status: 400 });
    if (!config.githubClientId) return Response.json({ error: "GitHub auth is not configured" }, { status: 503 });
    const body = await readJson(req);
    const flowId = typeof body?.flowId === "string" ? body.flowId : "";
    const flow = flows.get(flowId);
    if (!flow || Date.now() > flow.expiresAt) {
      if (flowId) flows.delete(flowId);
      return Response.json({ error: "expired_token" }, { status: 400 });
    }
    const githubRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Accept": "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: config.githubClientId, device_code: flow.deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
    });
    const payload = await githubRes.json() as { access_token?: string; error?: string; error_description?: string };
    if (payload.error === "authorization_pending" || payload.error === "slow_down") return Response.json({ pending: true, error: payload.error, interval: flow.intervalSeconds });
    if (!githubRes.ok || !payload.access_token) return Response.json({ error: payload.error_description ?? payload.error ?? "GitHub token exchange failed" }, { status: 502 });
    const user = await fetchGitHubUser(payload.access_token);
    flows.delete(flowId);
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
    const token = createSessionToken(user, expiresAt, config);
    if (!isSignedSessionToken(token)) await store.setSession(token, { user, expiresAt });
    return Response.json({ authenticated: true, user }, { headers: { "Set-Cookie": sessionCookie(token, new URL(req.url).protocol === "https:") } });
  }

  if (url.pathname === "/api/auth/logout" && req.method === "POST") {
    const token = getCookie(req.headers.get("cookie"), "mflow_session");
    if (token) await store.deleteSession(token);
    return Response.json({ ok: true }, { headers: { "Set-Cookie": clearSessionCookie(new URL(req.url).protocol === "https:") } });
  }

  return null;
}

export async function validateApiKey(req: Request, config: DashboardAuthConfig): Promise<DashboardApiKey | null> {
  const header = req.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match || !config.apiKeyPepper) return null;
  const hash = hashApiKey(match[1].trim(), config.apiKeyPepper);
  const key = await store.getApiKeyByHash(hash);
  if (!key || key.revokedAt) return null;
  if (key.expiresAt && Date.now() > key.expiresAt) return null;
  key.lastUsedAt = Date.now();
  await store.updateApiKey(key);
  return key;
}

async function requireDashboardUser(req: Request, config: DashboardAuthConfig): Promise<DashboardUser | null> {
  if (!config.required) return { id: 0, login: "self-hosted", name: "Self-hosted admin", avatarUrl: null };
  return getDashboardUser(req, config);
}

function hashApiKey(key: string, pepper: string): string {
  return createHash("sha256").update(`${pepper}:${key}`).digest("hex");
}

function createSessionToken(user: DashboardUser, expiresAt: number, config: DashboardAuthConfig): string {
  if (!config.sessionSecret) return randomUUID();
  const payload = base64UrlEncode(JSON.stringify({ user, expiresAt }));
  const sig = createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifySignedSession(token: string, secret: string | null): DashboardUser | null {
  if (!secret || !isSignedSessionToken(token)) return null;
  const [payload, sig] = token.split(".");
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  if (!timingSafeEqualString(sig, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { user?: DashboardUser; expiresAt?: number };
    if (!parsed.user || !parsed.expiresAt || Date.now() > parsed.expiresAt) return null;
    return parsed.user;
  } catch {
    return null;
  }
}

function isSignedSessionToken(token: string): boolean {
  return token.includes(".");
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return createHash("sha256").update(a).digest("hex") === createHash("sha256").update(b).digest("hex") && a === b;
}

function publicApiKey(key: DashboardApiKey) {
  return { id: key.id, name: key.name, suffix: key.suffix, createdAt: key.createdAt, expiresAt: key.expiresAt, lastUsedAt: key.lastUsedAt, revokedAt: key.revokedAt };
}

function expirationToTimestamp(value: string): number | null | undefined {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const table: Record<string, number | null> = { "1d": now + day, "3d": now + 3 * day, "7d": now + 7 * day, "1m": now + 30 * day, "6m": now + 180 * day, "1y": now + 365 * day, never: null };
  return Object.prototype.hasOwnProperty.call(table, value) ? table[value] : undefined;
}

function sanitizeName(name: string): string {
  return name.trim().replace(/\s+/g, " ").slice(0, 80);
}

function checkMutationLimit(key: string): boolean {
  const now = Date.now();
  const recent = (mutationLimits.get(key) ?? []).filter((ts) => now - ts < 60_000);
  if (recent.length >= 10) {
    mutationLimits.set(key, recent);
    return false;
  }
  recent.push(now);
  mutationLimits.set(key, recent);
  return true;
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (!value) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

function normalizeGitHubDeviceFlowError(error: string | undefined): string {
  if (error?.toLowerCase().includes("device flow")) return "GitHub Device Flow is disabled for this GitHub App. Enable Device Flow in the GitHub App settings, then retry.";
  return error ?? "GitHub device flow failed";
}
function getCallbackUrl(req: Request, config: DashboardAuthConfig): string { return config.githubCallbackUrl ?? `${new URL(req.url).origin}/auth/github/callback`; }
function isValidOAuthState(state: string): boolean { const expiresAt = oauthStates.get(state); if (!expiresAt) return false; if (Date.now() > expiresAt) { oauthStates.delete(state); return false; } return true; }
function redirect(location: string, headers: HeadersInit = {}): Response { const responseHeaders = new Headers(headers); responseHeaders.set("Location", location); return new Response(null, { status: 302, headers: responseHeaders }); }
function getCookie(cookieHeader: string | null, name: string): string | null { if (!cookieHeader) return null; for (const part of cookieHeader.split(";")) { const [k, ...rest] = part.trim().split("="); if (k === name) return decodeURIComponent(rest.join("=")); } return null; }
async function readJson(req: Request): Promise<Record<string, unknown> | null> { try { const value = await req.json(); return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; } catch { return null; } }
async function fetchGitHubUser(accessToken: string): Promise<DashboardUser> { const res = await fetch("https://api.github.com/user", { headers: { "Accept": "application/vnd.github+json", "Authorization": `Bearer ${accessToken}`, "User-Agent": "mflow-signaling" } }); if (!res.ok) throw new Error("GitHub user fetch failed"); const user = await res.json() as { id: number; login: string; name?: string | null; avatar_url?: string | null }; return { id: user.id, login: user.login, name: user.name ?? null, avatarUrl: user.avatar_url ?? null }; }
function sessionCookie(token: string, secure: boolean): string { return [`mflow_session=${encodeURIComponent(token)}`, "Path=/", "HttpOnly", "SameSite=Lax", secure ? "Secure" : "", "Max-Age=604800"].filter(Boolean).join("; "); }
function clearSessionCookie(secure: boolean): string { return ["mflow_session=", "Path=/", "HttpOnly", "SameSite=Lax", secure ? "Secure" : "", "Max-Age=0"].filter(Boolean).join("; "); }
function oauthStateCookie(state: string, secure: boolean): string { return [`mflow_oauth_state=${encodeURIComponent(state)}`, "Path=/", "HttpOnly", "SameSite=Lax", secure ? "Secure" : "", "Max-Age=600"].filter(Boolean).join("; "); }
function clearOAuthStateCookie(secure: boolean): string { return ["mflow_oauth_state=", "Path=/", "HttpOnly", "SameSite=Lax", secure ? "Secure" : "", "Max-Age=0"].filter(Boolean).join("; "); }
