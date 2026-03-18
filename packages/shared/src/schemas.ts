import { z } from "zod";
import {
  DEFAULT_SIGNALING_URL,
  DEFAULT_STUN_SERVERS,
  DEFAULT_IGNORE_PATTERNS,
  DEFAULT_DEBOUNCE_MS,
  MAX_FILE_SIZE_BYTES,
  MAX_TRACKED_FILES,
  YDOC_UNLOAD_MINUTES,
  AWARENESS_BROADCAST_MS,
  RECONNECT_MAX_DELAY_MS,
} from "./constants.js";

// ─── Config Schema ───────────────────────────────────────────

export const MflowConfigSchema = z.object({
  daemon: z
    .object({
      name: z.string().default(""),
      type: z.enum(["agent", "human", "auto"]).default("auto"),
    })
    .default({}),
  sync: z
    .object({
      signaling: z.string().url().default(DEFAULT_SIGNALING_URL),
      room: z.string().default(""),
      secret: z.string().default(""),
      debounce_ms: z.number().int().positive().default(DEFAULT_DEBOUNCE_MS),
      max_file_size_bytes: z
        .number()
        .int()
        .positive()
        .default(MAX_FILE_SIZE_BYTES),
      max_tracked_files: z
        .number()
        .int()
        .positive()
        .default(MAX_TRACKED_FILES),
      unload_after_minutes: z
        .number()
        .int()
        .positive()
        .default(YDOC_UNLOAD_MINUTES),
      ignore: z
        .object({
          patterns: z.array(z.string()).default(DEFAULT_IGNORE_PATTERNS),
        })
        .default({}),
    })
    .default({}),
  awareness: z
    .object({
      broadcast_interval_ms: z
        .number()
        .int()
        .positive()
        .default(AWARENESS_BROADCAST_MS),
      share_current_file: z.boolean().default(true),
    })
    .default({}),
  transport: z
    .object({
      stun_servers: z.array(z.string()).default(DEFAULT_STUN_SERVERS),
      reconnect_max_delay_ms: z
        .number()
        .int()
        .positive()
        .default(RECONNECT_MAX_DELAY_MS),
    })
    .default({}),
});

// ─── Signaling Message Schemas ───────────────────────────────

export const SignalingJoinSchema = z.object({
  type: z.literal("join"),
  roomId: z.string().min(1).max(256),
  secretHash: z.string().length(64), // SHA-256 hex
  peerId: z.string().min(1).max(128),
  peerName: z.string().min(1).max(128),
  peerType: z.enum(["agent", "human"]),
});

export const SignalingSignalSchema = z.object({
  type: z.literal("signal"),
  to: z.string().min(1),
  from: z.string().min(1),
  data: z.object({
    type: z.enum(["offer", "answer", "candidate"]),
    sdp: z.string().optional(),
    candidate: z
      .object({
        candidate: z.string(),
        sdpMid: z.string().nullable(),
        sdpMLineIndex: z.number().nullable(),
      })
      .optional(),
  }),
});

export const SignalingMessageSchema = z.discriminatedUnion("type", [
  SignalingJoinSchema,
  SignalingSignalSchema,
  z.object({ type: z.literal("peer-joined"), peer: z.any() }),
  z.object({ type: z.literal("peer-left"), peerId: z.string() }),
  z.object({
    type: z.literal("joined"),
    roomId: z.string(),
    peers: z.array(z.any()),
  }),
  z.object({
    type: z.literal("error"),
    code: z.string(),
    message: z.string(),
  }),
]);

// ─── IPC Schemas ─────────────────────────────────────────────

export const IPCRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("status") }),
  z.object({ type: z.literal("pause") }),
  z.object({ type: z.literal("resume") }),
  z.object({ type: z.literal("stop") }),
  z.object({ type: z.literal("ignore"), pattern: z.string().min(1) }),
  z.object({ type: z.literal("peers") }),
  z.object({ type: z.literal("health") }),
]);
