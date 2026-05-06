export interface SignalingLimits {
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

export const DEFAULT_SIGNALING_LIMITS: SignalingLimits = {
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

const ENV_KEYS: Record<keyof SignalingLimits, string> = {
  maxPeersPerRoom: "MFLOW_MAX_PEERS_PER_ROOM",
  maxWebSocketMessageBytes: "MFLOW_MAX_WS_MESSAGE_BYTES",
  joinAttemptsPerMinute: "MFLOW_JOIN_ATTEMPTS_PER_MINUTE",
  messagesPerMinute: "MFLOW_MESSAGES_PER_MINUTE",
  rateLimitViolationsBeforeDisconnect: "MFLOW_RATE_LIMIT_VIOLATIONS_BEFORE_DISCONNECT",
  unauthenticatedTimeoutMs: "MFLOW_UNAUTHENTICATED_TIMEOUT_MS",
  maxUnauthenticatedSocketsPerIp: "MFLOW_MAX_UNAUTHENTICATED_SOCKETS_PER_IP",
  maxUnauthenticatedSocketsGlobal: "MFLOW_MAX_UNAUTHENTICATED_SOCKETS_GLOBAL",
  maxActiveRooms: "MFLOW_MAX_ACTIVE_ROOMS",
  idleRoomTtlMs: "MFLOW_IDLE_ROOM_TTL_MS",
  maxActivityEntriesPerRoom: "MFLOW_MAX_ACTIVITY_ENTRIES_PER_ROOM",
};

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function loadSignalingLimits(env: Record<string, string | undefined> = process.env): SignalingLimits {
  return {
    maxPeersPerRoom: parsePositiveInteger(env[ENV_KEYS.maxPeersPerRoom], DEFAULT_SIGNALING_LIMITS.maxPeersPerRoom),
    maxWebSocketMessageBytes: parsePositiveInteger(env[ENV_KEYS.maxWebSocketMessageBytes], DEFAULT_SIGNALING_LIMITS.maxWebSocketMessageBytes),
    joinAttemptsPerMinute: parsePositiveInteger(env[ENV_KEYS.joinAttemptsPerMinute], DEFAULT_SIGNALING_LIMITS.joinAttemptsPerMinute),
    messagesPerMinute: parsePositiveInteger(env[ENV_KEYS.messagesPerMinute], DEFAULT_SIGNALING_LIMITS.messagesPerMinute),
    rateLimitViolationsBeforeDisconnect: parsePositiveInteger(env[ENV_KEYS.rateLimitViolationsBeforeDisconnect], DEFAULT_SIGNALING_LIMITS.rateLimitViolationsBeforeDisconnect),
    unauthenticatedTimeoutMs: parsePositiveInteger(env[ENV_KEYS.unauthenticatedTimeoutMs], DEFAULT_SIGNALING_LIMITS.unauthenticatedTimeoutMs),
    maxUnauthenticatedSocketsPerIp: parsePositiveInteger(env[ENV_KEYS.maxUnauthenticatedSocketsPerIp], DEFAULT_SIGNALING_LIMITS.maxUnauthenticatedSocketsPerIp),
    maxUnauthenticatedSocketsGlobal: parsePositiveInteger(env[ENV_KEYS.maxUnauthenticatedSocketsGlobal], DEFAULT_SIGNALING_LIMITS.maxUnauthenticatedSocketsGlobal),
    maxActiveRooms: parsePositiveInteger(env[ENV_KEYS.maxActiveRooms], DEFAULT_SIGNALING_LIMITS.maxActiveRooms),
    idleRoomTtlMs: parsePositiveInteger(env[ENV_KEYS.idleRoomTtlMs], DEFAULT_SIGNALING_LIMITS.idleRoomTtlMs),
    maxActivityEntriesPerRoom: parsePositiveInteger(env[ENV_KEYS.maxActivityEntriesPerRoom], DEFAULT_SIGNALING_LIMITS.maxActivityEntriesPerRoom),
  };
}
