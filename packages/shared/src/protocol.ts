import type { PeerInfo } from "./types.js";

// ─── Signaling Protocol Messages ─────────────────────────────

export type SignalingMessage =
  | SignalingJoin
  | SignalingJoined
  | SignalingPeerJoined
  | SignalingPeerLeft
  | SignalingSignal
  | SignalingRelay
  | SignalingError;

export interface SignalingJoin {
  type: "join";
  roomId: string;
  secretHash: string;
  peerId: string;
  peerName: string;
  peerType: "agent" | "human";
}

export interface SignalingJoined {
  type: "joined";
  roomId: string;
  peers: PeerInfo[];
}

export interface SignalingPeerJoined {
  type: "peer-joined";
  peer: PeerInfo;
}

export interface SignalingPeerLeft {
  type: "peer-left";
  peerId: string;
}

export interface SignalingSignal {
  type: "signal";
  to: string;
  from: string;
  data: RTCSignalData;
}

export interface SignalingRelay {
  type: "relay";
  to: string;
  from: string;
  data: string; // base64-encoded encrypted binary frame
}

export interface SignalingError {
  type: "error";
  code: SignalingErrorCode;
  message: string;
}

export type SignalingErrorCode =
  | "AUTH_FAILED"
  | "ROOM_FULL"
  | "RATE_LIMITED"
  | "INVALID_MESSAGE"
  | "PEER_NOT_FOUND"
  | "PEER_ID_TAKEN"
  | "INTERNAL_ERROR";

// ─── WebRTC Signal Data ──────────────────────────────────────

export interface RTCSignalData {
  sdp?: string;
  candidate?: RTCIceCandidateData;
  type: "offer" | "answer" | "candidate";
}

export interface RTCIceCandidateData {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}

// ─── Data Channel Messages ───────────────────────────────────

export type DataChannelMessage =
  | DCYjsUpdate
  | DCAwareness
  | DCManifestSync;

export interface DCYjsUpdate {
  type: "yjs-update";
  fileId: string;
  update: Uint8Array;
}

export interface DCAwareness {
  type: "awareness";
  data: Uint8Array; // Y.js awareness encoded state
}

export interface DCManifestSync {
  type: "manifest-sync";
  stateVector: Uint8Array;
}

// ─── Health Endpoint Response ────────────────────────────────

export interface HealthResponse {
  status: "ok";
  rooms: number;
  peers: number;
  uptime: number;
  memoryMB: number;
}
