/**
 * T6.2 — Signaling server integration tests
 *
 * Properties verified:
 *   P3.1  Room join          — valid secret → joined + peer list
 *   P3.2  Peer discovery     — existing peer gets peer-joined notification
 *   P3.3  Room auth          — wrong secret hash → AUTH_FAILED
 *   P3.4  Rate limiting      — >10 joins/min → RATE_LIMITED; 3 violations → disconnect
 *   P3.5  Health endpoint    — GET /health returns rooms/peers/uptime
 *   LIMIT Peer limit         — 11th peer → ROOM_FULL
 *
 * Strategy: each describe block (and each rate-limit test) starts its own
 * Bun.serve instance on a high local port.  This gives each
 * test group a fresh RoomManager and RateLimiter so tests never share state.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import type { Server, ServerWebSocket } from "bun";
import {
  MAX_PEERS_PER_ROOM,
  RATE_LIMIT_JOINS_PER_MINUTE,
  RATE_LIMIT_VIOLATIONS_BEFORE_DISCONNECT,
} from "@mflow/shared";
import { sha256 } from "@mflow/shared";
import { RoomManager } from "../../packages/signaling/src/rooms.js";
import { RateLimiter } from "../../packages/signaling/src/ratelimit.js";
import type { PeerContext } from "../../packages/signaling/src/rooms.js";
import {
  SignalingJoinSchema,
  SignalingSignalSchema,
} from "@mflow/shared";
import { relaySignal } from "../../packages/signaling/src/relay.js";
import {
  DEFAULT_SIGNALING_LIMITS,
  loadSignalingLimits,
  type SignalingLimits,
} from "../../packages/signaling/src/limits.js";
import type {
  SignalingJoined,
  SignalingPeerJoined,
  SignalingError,
  HealthResponse,
} from "@mflow/shared";

// ─── Test server factory ─────────────────────────────────────────────────────

/**
 * Start a self-contained signaling server on an OS-assigned port.
 * Each call creates fresh RoomManager + RateLimiter instances with no shared state.
 */
function startTestServer(): Server {
  const rooms = new RoomManager();
  const rateLimiter = new RateLimiter();
  const startTime = Date.now();

  rateLimiter.start();

  function sendError(ws: ServerWebSocket<PeerContext>, code: string, message: string): void {
    ws.send(JSON.stringify({ type: "error", code, message }));
  }

  function notifyPeerLeft(peerId: string, remaining: ServerWebSocket<PeerContext>[]): void {
    const msg = JSON.stringify({ type: "peer-left", peerId });
    for (const rws of remaining) rws.send(msg);
  }

  function handleJoin(ws: ServerWebSocket<PeerContext>, data: unknown): void {
    const ip = ws.data.ip;
    const joinCheck = rateLimiter.checkJoin(ip);
    if (!joinCheck.allowed) {
      sendError(ws, "RATE_LIMITED", "Too many join attempts — slow down");
      if (joinCheck.shouldDisconnect) {
        ws.close(1008, "Rate limit exceeded");
      }
      return;
    }

    const parsed = SignalingJoinSchema.safeParse(data);
    if (!parsed.success) {
      sendError(ws, "INVALID_MESSAGE", `Invalid join message: ${parsed.error.message}`);
      return;
    }

    const { roomId, secretHash, peerId, peerName, peerType } = parsed.data;

    const leaveResult = rooms.leave(ws);
    if (leaveResult) {
      notifyPeerLeft(leaveResult.peerId, leaveResult.remainingPeers);
    }

    const result = rooms.join(ws, roomId, secretHash, peerId, peerName, peerType);
    if (!result.ok) {
      sendError(ws, result.code, result.message);
      return;
    }

    ws.send(JSON.stringify({ type: "joined", roomId, peers: result.peers }));

    const newPeerInfo = { peerId, peerName, peerType, joinedAt: Date.now() };
    for (const peer of result.peers) {
      const peerWs = rooms.findPeer(roomId, peer.peerId);
      if (peerWs) {
        peerWs.send(JSON.stringify({ type: "peer-joined", peer: newPeerInfo }));
      }
    }
  }

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

  function handleMessage(ws: ServerWebSocket<PeerContext>, raw: string | Buffer): void {
    const rawLen = typeof raw === "string" ? raw.length : raw.byteLength;
    if (rawLen > DEFAULT_SIGNALING_LIMITS.maxWebSocketMessageBytes) {
      sendError(ws, "MESSAGE_TOO_LARGE", `Message exceeds ${DEFAULT_SIGNALING_LIMITS.maxWebSocketMessageBytes} bytes`);
      return;
    }

    const ip = ws.data.ip;
    const msgCheck = rateLimiter.checkMessage(ip);
    if (!msgCheck.allowed) {
      sendError(ws, "RATE_LIMITED", "Too many messages — slow down");
      if (msgCheck.shouldDisconnect) ws.close(1008, "Rate limit exceeded");
      return;
    }

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
      default:
        sendError(ws, "INVALID_MESSAGE", `Unknown message type: ${msgType}`);
    }
  }

  return startBunServerWithRetry({

    fetch(req, server) {
      const url = new URL(req.url);

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

      if (url.pathname === "/ws" || url.pathname === "/") {
        // Honour x-forwarded-for so rate-limit tests can set per-client IPs.
        const ip =
          req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
          server.requestIP(req)?.address ??
          "127.0.0.1";

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
      maxPayloadLength: DEFAULT_SIGNALING_LIMITS.maxWebSocketMessageBytes * 2,
      open(_ws) {},
      message(ws, raw) {
        handleMessage(ws, raw);
      },
      close(ws) {
        const result = rooms.leave(ws);
        if (result) {
          notifyPeerLeft(result.peerId, result.remainingPeers);
        }
      },
    },
  });
}

function startBunServerWithRetry(options: Omit<Parameters<typeof Bun.serve<PeerContext>>[0], "port">): Server {
  let lastError: unknown;
  for (let i = 0; i < 20; i++) {
    const port = 20_000 + ((process.pid + i + Math.floor(Math.random() * 10_000)) % 30_000);
    try {
      return Bun.serve<PeerContext>({ ...options, port });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Failed to start test server");
}

// ─── WebSocket client helpers ────────────────────────────────────────────────

/** Open a WebSocket connection and wait for it to be ready. */
function connect(port: number, forwardedIp?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    // Bun's WebSocket accepts a second options argument with headers.
    // The server reads x-forwarded-for to determine the client IP for rate limiting.
    const opts = forwardedIp
      ? { headers: { "x-forwarded-for": forwardedIp } }
      : undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, opts as any);
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", (e) => reject(e));
  });
}

/** Send a message and await the next message from the server. */
function sendAndReceive(ws: WebSocket, msg: object): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timeout waiting for server response")),
      3000,
    );
    ws.addEventListener(
      "message",
      (e) => {
        clearTimeout(timer);
        resolve(JSON.parse(e.data as string) as Record<string, unknown>);
      },
      { once: true },
    );
    ws.send(JSON.stringify(msg));
  });
}

/** Collect the next N messages from a WebSocket. */
function collectMessages(
  ws: WebSocket,
  count: number,
  timeoutMs = 3000,
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const collected: Record<string, unknown>[] = [];
    const timer = setTimeout(
      () => reject(new Error(`Timeout: collected ${collected.length}/${count} messages`)),
      timeoutMs,
    );

    const handler = (e: MessageEvent) => {
      collected.push(JSON.parse(e.data as string) as Record<string, unknown>);
      if (collected.length === count) {
        clearTimeout(timer);
        ws.removeEventListener("message", handler);
        resolve(collected);
      }
    };
    ws.addEventListener("message", handler);
  });
}

/** Wait for the WebSocket close event. */
function waitForClose(ws: WebSocket, timeoutMs = 3000): Promise<CloseEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timeout waiting for close")), timeoutMs);
    ws.addEventListener(
      "close",
      (e) => {
        clearTimeout(timer);
        resolve(e);
      },
      { once: true },
    );
  });
}

/** Close a WebSocket cleanly and wait for the event to settle. */
async function closeWs(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return;
  const closed = waitForClose(ws, 1000).catch(() => {});
  ws.close();
  await closed;
}

function makeRoomLimits(overrides: Partial<SignalingLimits>): SignalingLimits {
  return { ...DEFAULT_SIGNALING_LIMITS, ...overrides };
}

function fakeServerWebSocket(peerId = ""): ServerWebSocket<PeerContext> {
  return {
    data: {
      peerId,
      peerName: peerId,
      peerType: "human",
      roomId: null,
      ip: "127.0.0.1",
    },
    close() {},
    send() {},
  } as unknown as ServerWebSocket<PeerContext>;
}

// ─── Fixed valid hash ────────────────────────────────────────────────────────

const VALID_SECRET = "my-room-secret";
let VALID_HASH: string;

// Compute once before any suite runs.
beforeAll(async () => {
  VALID_HASH = await sha256(VALID_SECRET);
});

// ─── P3.1: Room Join ─────────────────────────────────────────────────────────

describe("P3.1: Room Join", () => {
  let server: Server;
  let port: number;

  beforeAll(() => {
    server = startTestServer();
    port = server.port;
  });

  afterAll(() => {
    server.stop(true);
  });

  test("peer joins room with valid secret hash and receives joined response with empty peer list", async () => {
    const roomId = "p31-empty-room";
    const ws = await connect(port);

    const response = (await sendAndReceive(ws, {
      type: "join",
      roomId,
      secretHash: VALID_HASH,
      peerId: "peer-a",
      peerName: "Alice",
      peerType: "human",
    })) as SignalingJoined;

    expect(response.type).toBe("joined");
    expect(response.roomId).toBe(roomId);
    expect(Array.isArray(response.peers)).toBe(true);
    expect(response.peers).toHaveLength(0);

    await closeWs(ws);
  });

  test("second peer receives joined response that includes the first peer", async () => {
    const roomId = "p31-two-peers";
    const wsA = await connect(port);
    const wsB = await connect(port);

    await sendAndReceive(wsA, {
      type: "join",
      roomId,
      secretHash: VALID_HASH,
      peerId: "peer-a2",
      peerName: "Alice",
      peerType: "human",
    });

    // wsA will receive a peer-joined notification — drain it so the listener
    // queue stays clean.
    const drainA = collectMessages(wsA, 1);

    const response = (await sendAndReceive(wsB, {
      type: "join",
      roomId,
      secretHash: VALID_HASH,
      peerId: "peer-b2",
      peerName: "Bob",
      peerType: "agent",
    })) as SignalingJoined;

    expect(response.type).toBe("joined");
    expect(response.peers).toHaveLength(1);
    expect(response.peers[0].peerId).toBe("peer-a2");
    expect(response.peers[0].peerName).toBe("Alice");
    expect(response.peers[0].peerType).toBe("human");

    await drainA;
    await closeWs(wsA);
    await closeWs(wsB);
  });
});

// ─── P3.2: Peer Discovery ────────────────────────────────────────────────────

describe("P3.2: Peer Discovery", () => {
  let server: Server;
  let port: number;

  beforeAll(() => {
    server = startTestServer();
    port = server.port;
  });

  afterAll(() => {
    server.stop(true);
  });

  test("existing peer receives peer-joined notification when new peer joins", async () => {
    const roomId = "p32-discovery";
    const wsA = await connect(port);
    const wsB = await connect(port);

    await sendAndReceive(wsA, {
      type: "join",
      roomId,
      secretHash: VALID_HASH,
      peerId: "disc-peer-a",
      peerName: "Alice",
      peerType: "human",
    });

    // Start listening for the peer-joined event on A before B sends join.
    const peerJoinedPromise = collectMessages(wsA, 1);

    wsB.send(
      JSON.stringify({
        type: "join",
        roomId,
        secretHash: VALID_HASH,
        peerId: "disc-peer-b",
        peerName: "Bob",
        peerType: "agent",
      }),
    );

    const [notification] = (await peerJoinedPromise) as [SignalingPeerJoined];

    expect(notification.type).toBe("peer-joined");
    expect(notification.peer.peerId).toBe("disc-peer-b");
    expect(notification.peer.peerName).toBe("Bob");
    expect(notification.peer.peerType).toBe("agent");
    expect(typeof notification.peer.joinedAt).toBe("number");

    await closeWs(wsA);
    await closeWs(wsB);
  });

  test("joining peer does not receive a self peer-joined echo", async () => {
    const roomId = "p32-no-self-echo";
    const ws = await connect(port);

    const firstMsg = await sendAndReceive(ws, {
      type: "join",
      roomId,
      secretHash: VALID_HASH,
      peerId: "solo-peer",
      peerName: "Solo",
      peerType: "human",
    });

    expect(firstMsg["type"]).toBe("joined");

    // Confirm no extra message arrives in the next 300 ms.
    const extra = await collectMessages(ws, 1, 300).catch(() => null);
    expect(extra).toBeNull();

    await closeWs(ws);
  });
});

// ─── P3.3: Room Auth ─────────────────────────────────────────────────────────

describe("P3.3: Room Auth", () => {
  let server: Server;
  let port: number;

  beforeAll(() => {
    server = startTestServer();
    port = server.port;
  });

  afterAll(() => {
    server.stop(true);
  });

  test("incorrect secret hash is rejected with AUTH_FAILED", async () => {
    const roomId = "p33-auth-room";
    const wsCreator = await connect(port);
    const wsAttacker = await connect(port);

    await sendAndReceive(wsCreator, {
      type: "join",
      roomId,
      secretHash: VALID_HASH,
      peerId: "creator",
      peerName: "Creator",
      peerType: "human",
    });

    // Wrong hash — all zeros, still 64 hex characters to pass schema validation.
    const wrongHash = "0".repeat(64);
    const response = (await sendAndReceive(wsAttacker, {
      type: "join",
      roomId,
      secretHash: wrongHash,
      peerId: "attacker",
      peerName: "Attacker",
      peerType: "human",
    })) as SignalingError;

    expect(response.type).toBe("error");
    expect(response.code).toBe("AUTH_FAILED");
    expect(typeof response.message).toBe("string");
    expect(response.message.length).toBeGreaterThan(0);

    await closeWs(wsCreator);
    await closeWs(wsAttacker);
  });

  test("correct secret hash from a second peer is accepted", async () => {
    const roomId = "p33-auth-valid";
    const wsA = await connect(port);
    const wsB = await connect(port);

    await sendAndReceive(wsA, {
      type: "join",
      roomId,
      secretHash: VALID_HASH,
      peerId: "auth-a",
      peerName: "Alice",
      peerType: "human",
    });

    const drainA = collectMessages(wsA, 1);

    const response = await sendAndReceive(wsB, {
      type: "join",
      roomId,
      secretHash: VALID_HASH,
      peerId: "auth-b",
      peerName: "Bob",
      peerType: "human",
    });

    expect(response["type"]).toBe("joined");
    await drainA;

    await closeWs(wsA);
    await closeWs(wsB);
  });
});

// ─── P3.4: Rate Limiting ─────────────────────────────────────────────────────

describe("P3.4: Rate Limiting", () => {
  /**
   * Each rate-limit test needs a completely fresh server and rate-limiter
   * because the join bucket fills up and the state is not resetable between tests.
   */

  test(`${RATE_LIMIT_JOINS_PER_MINUTE + 1}th join attempt in the same minute returns RATE_LIMITED`, async () => {
    const server = startTestServer();
    const port = server.port;
    const ws = await connect(port);
    const prefix = "rl-limit";

    try {
      // Exhaust the allowed joins.
      for (let i = 0; i < RATE_LIMIT_JOINS_PER_MINUTE; i++) {
        const r = await sendAndReceive(ws, {
          type: "join",
          roomId: `${prefix}-${i}`,
          secretHash: VALID_HASH,
          peerId: `peer-${i}`,
          peerName: `Peer ${i}`,
          peerType: "human",
        });
        expect(r["type"]).toBe("joined");
      }

      // The next join must be denied.
      const denied = (await sendAndReceive(ws, {
        type: "join",
        roomId: `${prefix}-overflow`,
        secretHash: VALID_HASH,
        peerId: "peer-over",
        peerName: "Over",
        peerType: "human",
      })) as SignalingError;

      expect(denied.type).toBe("error");
      expect(denied.code).toBe("RATE_LIMITED");
    } finally {
      await closeWs(ws);
      server.stop(true);
    }
  });

  test(`${RATE_LIMIT_VIOLATIONS_BEFORE_DISCONNECT} rate-limit violations trigger WebSocket disconnect (code 1008)`, async () => {
    const server = startTestServer();
    const port = server.port;
    const ws = await connect(port);
    const prefix = "rl-disc";

    try {
      // Fill the join bucket to the limit.
      for (let i = 0; i < RATE_LIMIT_JOINS_PER_MINUTE; i++) {
        await sendAndReceive(ws, {
          type: "join",
          roomId: `${prefix}-${i}`,
          secretHash: VALID_HASH,
          peerId: `peer-${i}`,
          peerName: `Peer ${i}`,
          peerType: "human",
        });
      }

      // Track the close event before triggering violations.
      const closedPromise = waitForClose(ws, 5000);

      // Each over-limit join increments violations.  The server closes the
      // socket once violations >= RATE_LIMIT_VIOLATIONS_BEFORE_DISCONNECT.
      for (let v = 0; v < RATE_LIMIT_VIOLATIONS_BEFORE_DISCONNECT; v++) {
        ws.send(
          JSON.stringify({
            type: "join",
            roomId: `${prefix}-viol-${v}`,
            secretHash: VALID_HASH,
            peerId: `viol-${v}`,
            peerName: `Viol ${v}`,
            peerType: "human",
          }),
        );
      }

      const closeEvent = await closedPromise;
      // code 1008 = Policy Violation (rate limit exceeded).
      // wasClean depends on Bun's WS implementation — don't assert it.
      expect(closeEvent.code).toBe(1008);
    } finally {
      server.stop(true);
    }
  });
});

// ─── P3.5: Health Endpoint ───────────────────────────────────────────────────

describe("P3.5: Health Endpoint", () => {
  let server: Server;
  let port: number;

  beforeAll(() => {
    server = startTestServer();
    port = server.port;
  });

  afterAll(() => {
    server.stop(true);
  });

  test("GET /health returns status ok with rooms, peers, uptime and memoryMB fields", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as HealthResponse;
    expect(body.status).toBe("ok");
    expect(typeof body.rooms).toBe("number");
    expect(typeof body.peers).toBe("number");
    expect(typeof body.uptime).toBe("number");
    expect(typeof body.memoryMB).toBe("number");
    expect(body.rooms).toBeGreaterThanOrEqual(0);
    expect(body.peers).toBeGreaterThanOrEqual(0);
    expect(body.uptime).toBeGreaterThanOrEqual(0);
    expect(body.memoryMB).toBeGreaterThanOrEqual(0);
  });

  test("GET /health reflects connected peers count while clients are active", async () => {
    const roomId = `health-count-${Date.now()}`;
    const wsA = await connect(port);
    const wsB = await connect(port);

    const drainA = collectMessages(wsA, 1);

    await sendAndReceive(wsA, {
      type: "join",
      roomId,
      secretHash: VALID_HASH,
      peerId: "health-a",
      peerName: "Alice",
      peerType: "human",
    });

    // B joins — A gets peer-joined, B gets joined.
    const bJoined = sendAndReceive(wsB, {
      type: "join",
      roomId,
      secretHash: VALID_HASH,
      peerId: "health-b",
      peerName: "Bob",
      peerType: "human",
    });

    await Promise.all([drainA, bJoined]);

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    const body = (await res.json()) as HealthResponse;

    expect(body.rooms).toBeGreaterThanOrEqual(1);
    expect(body.peers).toBeGreaterThanOrEqual(2);

    await closeWs(wsA);
    await closeWs(wsB);
  });
});

// ─── Peer Limit ───────────────────────────────────────────────────────────────

describe("Peer Limit", () => {
  let server: Server;
  let port: number;

  beforeAll(() => {
    server = startTestServer();
    port = server.port;
  });

  afterAll(() => {
    server.stop(true);
  });

  test(`${MAX_PEERS_PER_ROOM + 1}th peer joining a room receives ROOM_FULL error`, async () => {
    const roomId = `peer-limit-${Date.now()}`;
    const clients: WebSocket[] = [];

    try {
      for (let i = 0; i < MAX_PEERS_PER_ROOM; i++) {
        // Use a distinct synthetic IP per client so each has its own rate-limit
        // bucket.  This prevents the join rate limiter from firing before the
        // room-full check can be reached.
        const clientIp = `10.0.0.${i + 1}`;
        const ws = await connect(port, clientIp);
        clients.push(ws);

        // Set up drain listeners on all PREVIOUSLY joined clients BEFORE sending
        // the join message.  This prevents a race where the peer-joined event fires
        // before the listener is attached.
        const drainPromises =
          i > 0
            ? clients.slice(0, i).map((existingWs) => collectMessages(existingWs, 1))
            : [];

        const joinResponse = await sendAndReceive(ws, {
          type: "join",
          roomId,
          secretHash: VALID_HASH,
          peerId: `limit-peer-${i}`,
          peerName: `Peer ${i}`,
          peerType: "human",
        });

        expect(joinResponse["type"]).toBe("joined");

        // Wait for all peer-joined notifications to land on existing clients.
        if (drainPromises.length > 0) {
          await Promise.all(drainPromises);
        }
      }

      // The (MAX_PEERS_PER_ROOM + 1)th peer must be rejected.
      const overflowWs = await connect(port, "10.0.0.99");
      clients.push(overflowWs);

      const response = (await sendAndReceive(overflowWs, {
        type: "join",
        roomId,
        secretHash: VALID_HASH,
        peerId: "overflow-peer",
        peerName: "Overflow",
        peerType: "human",
      })) as SignalingError;

      expect(response.type).toBe("error");
      expect(response.code).toBe("ROOM_FULL");
      expect(response.message).toContain(String(MAX_PEERS_PER_ROOM));
    } finally {
      await Promise.all(clients.map(closeWs));
    }
  });
});

// ─── Public Relay Limit Config ───────────────────────────────────────────────

describe("Public relay limit config", () => {
  test("defaults match the initial hosted fair-use limits", () => {
    expect(DEFAULT_SIGNALING_LIMITS.maxPeersPerRoom).toBe(4);
    expect(DEFAULT_SIGNALING_LIMITS.maxWebSocketMessageBytes).toBe(65_536);
    expect(DEFAULT_SIGNALING_LIMITS.messagesPerMinute).toBe(120);
    expect(DEFAULT_SIGNALING_LIMITS.joinAttemptsPerMinute).toBe(10);
    expect(DEFAULT_SIGNALING_LIMITS.maxUnauthenticatedSocketsPerIp).toBe(5);
    expect(DEFAULT_SIGNALING_LIMITS.maxUnauthenticatedSocketsGlobal).toBe(500);
    expect(DEFAULT_SIGNALING_LIMITS.maxActiveRooms).toBe(200);
    expect(DEFAULT_SIGNALING_LIMITS.idleRoomTtlMs).toBe(15 * 60_000);
    expect(DEFAULT_SIGNALING_LIMITS.maxActivityEntriesPerRoom).toBe(20);
  });

  test("environment overrides accept only positive safe integers", () => {
    const limits = loadSignalingLimits({
      MFLOW_MAX_PEERS_PER_ROOM: "8",
      MFLOW_MAX_WS_MESSAGE_BYTES: "131072",
      MFLOW_MESSAGES_PER_MINUTE: "240",
      MFLOW_JOIN_ATTEMPTS_PER_MINUTE: "0",
      MFLOW_MAX_ACTIVE_ROOMS: "-1",
      MFLOW_IDLE_ROOM_TTL_MS: "nope",
    });

    expect(limits.maxPeersPerRoom).toBe(8);
    expect(limits.maxWebSocketMessageBytes).toBe(131_072);
    expect(limits.messagesPerMinute).toBe(240);
    expect(limits.joinAttemptsPerMinute).toBe(DEFAULT_SIGNALING_LIMITS.joinAttemptsPerMinute);
    expect(limits.maxActiveRooms).toBe(DEFAULT_SIGNALING_LIMITS.maxActiveRooms);
    expect(limits.idleRoomTtlMs).toBe(DEFAULT_SIGNALING_LIMITS.idleRoomTtlMs);
  });

  test("RoomManager enforces max active rooms before creating a new room", async () => {
    const rooms = new RoomManager(makeRoomLimits({ maxActiveRooms: 1 }));
    const first = fakeServerWebSocket("first");
    const second = fakeServerWebSocket("second");

    const joined = rooms.join(first, "room-a", VALID_HASH, "first", "First", "human");
    expect(joined.ok).toBe(true);

    const rejected = rooms.join(second, "room-b", VALID_HASH, "second", "Second", "human");
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.code).toBe("ROOM_FULL");
      expect(rejected.message).toContain("active rooms");
    }
  });

  test("RoomManager cleanup removes idle rooms and closes peers", async () => {
    let closeCount = 0;
    const rooms = new RoomManager(makeRoomLimits({ idleRoomTtlMs: 1 }));
    const ws = {
      ...fakeServerWebSocket("idle-peer"),
      close() {
        closeCount++;
      },
    } as unknown as ServerWebSocket<PeerContext>;

    const result = rooms.join(ws, "idle-room", VALID_HASH, "idle-peer", "Idle", "human");
    expect(result.ok).toBe(true);

    const removed = rooms.cleanupIdleRooms(Date.now() + 2);
    expect(removed).toBe(1);
    expect(closeCount).toBe(1);
    expect(rooms.getRoomCount()).toBe(0);
  });

  test("RoomManager caps activity entries per room", async () => {
    const rooms = new RoomManager(makeRoomLimits({ maxActivityEntriesPerRoom: 2 }));
    const ws = fakeServerWebSocket("activity-peer");
    const result = rooms.join(ws, "activity-room", VALID_HASH, "activity-peer", "Activity", "human");
    expect(result.ok).toBe(true);

    for (const file of ["a.ts", "b.ts", "c.ts"]) {
      rooms.addActivity("activity-room", {
        timestamp: Date.now(),
        peerId: "activity-peer",
        peerName: "Activity",
        peerType: "human",
        action: "synced",
        file,
      });
    }

    const [room] = rooms.getRoomDetailsBySecretHash(VALID_HASH);
    expect(room.activity.map((entry) => entry.file)).toEqual(["b.ts", "c.ts"]);
  });
});

describe("Message size limit", () => {
  test("oversized WebSocket messages return MESSAGE_TOO_LARGE before parsing", async () => {
    const server = startTestServer();
    const port = server.port;
    const ws = await connect(port);

    try {
      const response = (await sendAndReceive(ws, {
        type: "join",
        roomId: "x".repeat(DEFAULT_SIGNALING_LIMITS.maxWebSocketMessageBytes),
      })) as SignalingError;

      expect(response.type).toBe("error");
      expect(response.code).toBe("MESSAGE_TOO_LARGE");
      expect(response.message).toContain(String(DEFAULT_SIGNALING_LIMITS.maxWebSocketMessageBytes));
    } finally {
      await closeWs(ws);
      server.stop(true);
    }
  });
});
