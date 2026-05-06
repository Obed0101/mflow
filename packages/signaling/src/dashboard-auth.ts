import { randomUUID } from "node:crypto";

export interface DashboardUser {
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface DashboardAuthConfig {
  required: boolean;
  githubClientId: string | null;
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

const flows = new Map<string, DeviceFlow>();
const sessions = new Map<string, Session>();

export function loadDashboardAuthConfig(env: Record<string, string | undefined> = process.env): DashboardAuthConfig {
  const githubClientId = env["MFLOW_HOSTED_GITHUB_CLIENT_ID"]?.trim() || null;
  return {
    required: parseBoolean(env["MFLOW_REQUIRE_DASHBOARD_AUTH"], false),
    githubClientId,
  };
}

export function getDashboardUser(req: Request): DashboardUser | null {
  const token = getCookie(req.headers.get("cookie"), "mflow_session");
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return null;
  }
  return session.user;
}

export async function handleAuthRequest(req: Request, config: DashboardAuthConfig): Promise<Response | null> {
  const url = new URL(req.url);

  if (url.pathname === "/api/auth/config" && req.method === "GET") {
    return Response.json({
      required: config.required,
      provider: "github",
      configured: Boolean(config.githubClientId),
      authenticated: Boolean(getDashboardUser(req)),
      user: getDashboardUser(req),
    });
  }

  if (url.pathname === "/api/auth/github/device/start" && req.method === "POST") {
    if (!config.required) return Response.json({ error: "dashboard auth is not required" }, { status: 400 });
    if (!config.githubClientId) return Response.json({ error: "GitHub auth is not configured" }, { status: 503 });

    const githubRes = await fetch("https://github.com/login/device/code", {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: config.githubClientId,
        scope: "read:user",
      }),
    });
    const payload = await githubRes.json() as {
      device_code?: string;
      user_code?: string;
      verification_uri?: string;
      expires_in?: number;
      interval?: number;
      error?: string;
      error_description?: string;
    };

    if (!githubRes.ok || !payload.device_code || !payload.user_code || !payload.verification_uri) {
      return Response.json(
        { error: payload.error_description ?? payload.error ?? "GitHub device flow failed" },
        { status: 502 },
      );
    }

    const flowId = randomUUID();
    flows.set(flowId, {
      deviceCode: payload.device_code,
      intervalSeconds: Math.max(1, payload.interval ?? 5),
      expiresAt: Date.now() + Math.max(1, payload.expires_in ?? 900) * 1000,
    });

    return Response.json({
      flowId,
      userCode: payload.user_code,
      verificationUri: payload.verification_uri,
      expiresIn: payload.expires_in ?? 900,
      interval: payload.interval ?? 5,
    });
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
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: config.githubClientId,
        device_code: flow.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    const payload = await githubRes.json() as {
      access_token?: string;
      error?: string;
      error_description?: string;
    };

    if (payload.error === "authorization_pending" || payload.error === "slow_down") {
      return Response.json({ pending: true, error: payload.error, interval: flow.intervalSeconds });
    }
    if (!githubRes.ok || !payload.access_token) {
      return Response.json({ error: payload.error_description ?? payload.error ?? "GitHub token exchange failed" }, { status: 502 });
    }

    const user = await fetchGitHubUser(payload.access_token);
    flows.delete(flowId);
    const token = randomUUID();
    sessions.set(token, {
      user,
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });

    return Response.json(
      { authenticated: true, user },
      { headers: { "Set-Cookie": sessionCookie(token, new URL(req.url).protocol === "https:") } },
    );
  }

  if (url.pathname === "/api/auth/logout" && req.method === "POST") {
    const token = getCookie(req.headers.get("cookie"), "mflow_session");
    if (token) sessions.delete(token);
    return Response.json(
      { ok: true },
      { headers: { "Set-Cookie": clearSessionCookie(new URL(req.url).protocol === "https:") } },
    );
  }

  return null;
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (!value) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

function getCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const value = await req.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
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
