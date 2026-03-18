// ─── Peer & Room ─────────────────────────────────────────────

export type PeerType = "agent" | "human";
export type ConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected";
export type ConnectionQuality = "good" | "degraded" | "poor";

export interface PeerInfo {
  peerId: string;
  peerName: string;
  peerType: PeerType;
  joinedAt: number;
}

export interface AwarenessData {
  peerId: string;
  peerName: string;
  peerType: PeerType;
  currentFile: string | null;
  editingFiles: string[];
  connectionQuality: ConnectionQuality;
  timestamp: number;
}

export interface RoomInfo {
  id: string;
  peers: PeerInfo[];
  createdAt: number;
}

// ─── Daemon ──────────────────────────────────────────────────

export type DaemonState =
  | "starting"
  | "scanning"
  | "connecting"
  | "syncing"
  | "paused"
  | "git_paused"
  | "reconnecting"
  | "stopping";

export interface DaemonStatus {
  state: DaemonState;
  roomId: string | null;
  peers: PeerInfo[];
  trackedFiles: number;
  activeYDocs: number;
  opsPerSecond: number;
  uptime: number;
  memoryUsageMB: number;
}

// ─── Manifest ────────────────────────────────────────────────
// TrackedFile (with Y.Doc/Y.Text) lives in @mflow/daemon — it depends on yjs.

export interface ManifestEntry {
  exists: boolean;
  contentHash: string;
  mtime: number;
  size: number;
}

// ─── Write-Loop Suppression ──────────────────────────────────

export interface WriteToken {
  hash: string;
  seq: number;
  timestamp: number;
}

// ─── Transport ───────────────────────────────────────────────

export interface ITransport {
  connect(roomId: string, secret: string): Promise<void>;
  disconnect(): Promise<void>;

  sendUpdate(fileId: string, update: Uint8Array): void;
  onUpdate(
    callback: (fileId: string, update: Uint8Array, peerId: string) => void
  ): void;

  sendAwareness(data: AwarenessData): void;
  onAwareness(
    callback: (peerId: string, data: AwarenessData) => void
  ): void;

  getPeers(): PeerInfo[];
  getConnectionState(): ConnectionState;
}

// ─── IPC Protocol (CLI ↔ Daemon) ─────────────────────────────

export type IPCRequest =
  | { type: "status" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "stop" }
  | { type: "ignore"; pattern: string }
  | { type: "peers" }
  | { type: "health" };

export type IPCResponse =
  | { type: "status"; data: DaemonStatus }
  | { type: "peers"; data: PeerInfo[] }
  | { type: "ok" }
  | { type: "error"; message: string };

// ─── Encryption ──────────────────────────────────────────────

export interface CipherFrame {
  nonce: Uint8Array; // 12 bytes: peerId prefix (4) + counter (8)
  ciphertext: Uint8Array; // encrypted payload + GCM tag
}

export interface DerivedKeys {
  authHash: string; // SHA-256(secret) — sent to signaling
  encKey: CryptoKey; // HKDF(secret, "mflow-enc") — AES-256-GCM
}

// ─── Config ──────────────────────────────────────────────────

export interface MflowConfig {
  daemon: {
    name: string;
    type: PeerType | "auto";
  };
  sync: {
    signaling: string;
    room: string;
    secret: string;
    debounce_ms: number;
    max_file_size_bytes: number;
    max_tracked_files: number;
    unload_after_minutes: number;
    ignore: {
      patterns: string[];
    };
  };
  awareness: {
    broadcast_interval_ms: number;
    share_current_file: boolean;
  };
  transport: {
    stun_servers: string[];
    reconnect_max_delay_ms: number;
  };
}

// ─── File Activity Indicators ────────────────────────────────

export type FileStatus = "synced" | "editing" | "warning";

export interface FileActivity {
  path: string;
  status: FileStatus;
  editedBy: string[];
}
