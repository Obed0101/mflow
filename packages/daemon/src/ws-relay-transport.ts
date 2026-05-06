import type {
  ITransport,
  AwarenessData,
  PeerInfo,
  PeerType,
  ConnectionState,
  CipherFrame,
  SignalingMessage,
} from "@mflow/shared";
import {
  deriveKeys,
  encrypt,
  decrypt,
  NonceCounter,
  peerIdPrefix,
} from "@mflow/shared";
import {
  NONCE_TOTAL_BYTES,
  NONCE_PEER_PREFIX_BYTES,
  RECONNECT_MAX_DELAY_MS,
} from "@mflow/shared";

const MIN_FRAME_SIZE = 15; // 1 type + 2 fileIdLen + 12 nonce minimum

// ─── Constants ────────────────────────────────────────────────

const FRAME_TYPE_YJS_UPDATE = 0x01;
const FRAME_TYPE_AWARENESS = 0x02;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ─── Types ────────────────────────────────────────────────────

export interface WSRelayTransportOptions {
  peerId: string;
  peerName: string;
  peerType: PeerType;
  signalingUrl: string;
  reconnectMaxDelayMs: number;
}

// ─── Binary Frame Protocol ───────────────────────────────────
//
// [1 byte type] [2 bytes fileId length] [fileId bytes] [12 bytes nonce] [remaining: ciphertext]
//
// Type: 0x01 = yjs-update, 0x02 = awareness
// For awareness, fileId = empty string

function encodeFrame(
  type: number,
  fileId: string,
  frame: CipherFrame,
): Uint8Array {
  const fileIdBytes = encoder.encode(fileId);
  const totalLen =
    1 + 2 + fileIdBytes.byteLength + NONCE_TOTAL_BYTES + frame.ciphertext.byteLength;
  const buf = new Uint8Array(totalLen);
  let offset = 0;

  // Type byte
  buf[offset++] = type;

  // FileId length (2 bytes big-endian)
  buf[offset++] = (fileIdBytes.byteLength >> 8) & 0xff;
  buf[offset++] = fileIdBytes.byteLength & 0xff;

  // FileId bytes
  buf.set(fileIdBytes, offset);
  offset += fileIdBytes.byteLength;

  // Nonce (12 bytes)
  buf.set(frame.nonce, offset);
  offset += NONCE_TOTAL_BYTES;

  // Ciphertext (remaining)
  buf.set(frame.ciphertext, offset);

  return buf;
}

function decodeFrame(data: Uint8Array): {
  type: number;
  fileId: string;
  frame: CipherFrame;
} {
  let offset = 0;

  // Type byte
  const type = data[offset++];

  // FileId length (2 bytes big-endian)
  const fileIdLen = (data[offset] << 8) | data[offset + 1];
  offset += 2;

  // FIX 3: Validate fileIdLen bounds before slicing
  if (offset + fileIdLen > data.length) throw new Error("truncated frame: fileId");

  // FileId bytes
  const fileId = decoder.decode(data.subarray(offset, offset + fileIdLen));
  offset += fileIdLen;

  // FIX 3: Validate nonce fits
  if (offset + NONCE_TOTAL_BYTES > data.length) throw new Error("truncated frame: nonce");

  // Nonce (12 bytes)
  const nonce = data.slice(offset, offset + NONCE_TOTAL_BYTES);
  offset += NONCE_TOTAL_BYTES;

  // Ciphertext (remaining)
  const ciphertext = data.slice(offset);

  return { type, fileId, frame: { nonce, ciphertext } };
}

/**
 * Extract the counter value from a 12-byte nonce.
 * Bytes [NONCE_PEER_PREFIX_BYTES..12) are a big-endian uint64 counter.
 */
function extractCounter(nonce: Uint8Array): bigint {
  const view = new DataView(
    nonce.buffer,
    nonce.byteOffset + NONCE_PEER_PREFIX_BYTES,
    8,
  );
  return view.getBigUint64(0, false);
}

// ─── Base64 Helpers ─────────────────────────────────────────

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ─── WSRelayTransport ───────────────────────────────────────

/**
 * WebSocket relay transport that implements ITransport by sending
 * encrypted messages through the signaling server.
 *
 * All payloads are E2E encrypted (AES-256-GCM). The server is a
 * dumb pipe that never sees plaintext. Messages are base64-encoded
 * because the signaling protocol uses JSON text frames.
 */
export class WSRelayTransport implements ITransport {
  // Options
  private readonly peerId: string;
  private readonly peerName: string;
  private readonly peerType: PeerType;
  private readonly signalingUrl: string;
  private readonly reconnectMaxDelayMs: number;

  // Internal state
  private ws: WebSocket | null = null;
  private peers: Map<string, PeerInfo> = new Map();
  private connectionState: ConnectionState = "disconnected";
  private encKey: CryptoKey | null = null;
  private roomId = "";
  private authHash = "";
  private nonceCounter = new NonceCounter();

  // Callbacks
  private updateCallbacks: Array<
    (fileId: string, update: Uint8Array, peerId: string) => void
  > = [];
  private awarenessCallbacks: Array<
    (peerId: string, data: AwarenessData) => void
  > = [];

  // Reconnection
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  // Secret stored for reconnect
  private secret = "";

  constructor(options: WSRelayTransportOptions) {
    this.peerId = options.peerId;
    this.peerName = options.peerName;
    this.peerType = options.peerType;
    this.signalingUrl = options.signalingUrl;
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs;
  }

  // ─── ITransport Implementation ───────────────────────────

  async connect(roomId: string, secret: string): Promise<void> {
    this.roomId = roomId;
    this.secret = secret;
    this.disposed = false;

    // Derive encryption keys from shared secret + roomId salt
    const keys = await deriveKeys(secret, roomId);
    this.encKey = keys.encKey;
    this.authHash = keys.authHash;

    this.setConnectionState("connecting");
    this.connectWebSocket();
  }

  async disconnect(): Promise<void> {
    this.disposed = true;
    this.clearReconnectTimer();
    this.peers.clear();

    // Close WebSocket
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.encKey = null;
    this.nonceCounter = new NonceCounter();
    this.setConnectionState("disconnected");
  }

  sendUpdate(fileId: string, update: Uint8Array): void {
    if (!this.encKey) return;

    // AAD includes sender peerId for sender binding
    const aad = encoder.encode(`${this.roomId}:${fileId}:${this.peerId}`);
    const counter = this.nonceCounter.increment(this.peerId);

    void encrypt(this.encKey, update, this.peerId, counter, aad).then(
      (frame) => {
        const encoded = encodeFrame(FRAME_TYPE_YJS_UPDATE, fileId, frame);
        this.sendRelay("*", encoded);
      },
    );
  }

  onUpdate(
    callback: (fileId: string, update: Uint8Array, peerId: string) => void,
  ): void {
    this.updateCallbacks.push(callback);
  }

  sendAwareness(data: AwarenessData): void {
    if (!this.encKey) return;

    const serialized = encoder.encode(JSON.stringify(data));
    // AAD includes sender peerId for sender binding
    const aad = encoder.encode(`${this.roomId}::${this.peerId}`);
    const counter = this.nonceCounter.increment(this.peerId);

    void encrypt(this.encKey, serialized, this.peerId, counter, aad).then(
      (frame) => {
        const encoded = encodeFrame(FRAME_TYPE_AWARENESS, "", frame);
        this.sendRelay("*", encoded);
      },
    );
  }

  onAwareness(
    callback: (peerId: string, data: AwarenessData) => void,
  ): void {
    this.awarenessCallbacks.push(callback);
  }

  getPeers(): PeerInfo[] {
    return Array.from(this.peers.values());
  }

  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  // ─── WebSocket Signaling ─────────────────────────────────

  private connectWebSocket(): void {
    if (this.disposed) return;

    const ws = new WebSocket(this.signalingUrl);
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.reconnectAttempt = 0;

      // Join the room
      const joinMsg: SignalingMessage = {
        type: "join",
        roomId: this.roomId,
        secretHash: this.authHash,
        peerId: this.peerId,
        peerName: this.peerName,
        peerType: this.peerType,
      };
      ws.send(JSON.stringify(joinMsg));
    });

    ws.addEventListener("message", (event: MessageEvent) => {
      const data =
        typeof event.data === "string"
          ? event.data
          : String(event.data);
      let msg: SignalingMessage;
      try {
        msg = JSON.parse(data) as SignalingMessage;
      } catch {
        return;
      }
      this.handleSignalingMessage(msg);
    });

    ws.addEventListener("close", () => {
      this.ws = null;
      if (!this.disposed) {
        if (
          this.connectionState === "connected" ||
          this.connectionState === "connecting"
        ) {
          this.setConnectionState("reconnecting");
        }
        this.scheduleReconnect();
      }
    });

    ws.addEventListener("error", () => {
      // The close event will fire after error — reconnect handled there
    });
  }

  private handleSignalingMessage(msg: SignalingMessage): void {
    switch (msg.type) {
      case "joined":
        this.handleJoined(msg.peers);
        break;
      case "peer-joined":
        this.handlePeerJoined(msg.peer);
        break;
      case "peer-left":
        this.handlePeerLeft(msg.peerId);
        break;
      case "relay":
        void this.handleRelayMessage(msg.from, msg.data);
        break;
      case "error":
        // Signaling errors — do not attempt reconnect for auth failures
        if (msg.code === "AUTH_FAILED" || msg.code === "ROOM_FULL") {
          this.disposed = true;
          this.setConnectionState("disconnected");
        }
        break;
    }
  }

  private handleJoined(existingPeers: PeerInfo[]): void {
    this.setConnectionState("connected");

    // Track existing peers
    for (const peer of existingPeers) {
      if (peer.peerId === this.peerId) continue;
      this.peers.set(peer.peerId, peer);
    }
  }

  private handlePeerJoined(peer: PeerInfo): void {
    if (peer.peerId === this.peerId) return;
    this.peers.set(peer.peerId, peer);
  }

  private handlePeerLeft(peerId: string): void {
    this.peers.delete(peerId);
  }

  // ─── Relay Message Handling ──────────────────────────────

  private async handleRelayMessage(
    fromPeerId: string,
    b64Data: string,
  ): Promise<void> {
    if (!this.encKey) return;

    try {
      let raw: Uint8Array;
      try {
        raw = base64ToUint8(b64Data);
      } catch {
        return; // Invalid base64 — discard
      }

      // FIX 3: Validate minimum frame size before decoding
      if (raw.length < MIN_FRAME_SIZE) return;

      const { type, fileId, frame } = decodeFrame(raw);

      // FIX 2: Verify nonce prefix matches claimed sender
      const expectedPrefix = await peerIdPrefix(fromPeerId);
      const actualPrefix = frame.nonce.slice(0, NONCE_PEER_PREFIX_BYTES);
      if (!expectedPrefix.every((b, i) => b === actualPrefix[i])) {
        return; // Nonce prefix mismatch — possible forgery
      }

      // Validate nonce counter for replay protection
      const counter = extractCounter(frame.nonce);
      if (!this.nonceCounter.validate(fromPeerId, counter)) {
        return; // Replay or out-of-order — discard
      }

      // FIX 2: Include fromPeerId in AAD for sender binding
      const aad = encoder.encode(`${this.roomId}:${fileId}:${fromPeerId}`);

      let plaintext: Uint8Array;
      try {
        plaintext = await decrypt(this.encKey, frame, aad);
      } catch {
        return; // Decryption failed — tampered or wrong key
      }

      switch (type) {
        case FRAME_TYPE_YJS_UPDATE:
          for (const cb of this.updateCallbacks) {
            cb(fileId, plaintext, fromPeerId);
          }
          break;

        case FRAME_TYPE_AWARENESS: {
          let decoded: AwarenessData;
          try {
            decoded = JSON.parse(decoder.decode(plaintext)) as AwarenessData;
          } catch {
            return; // Malformed awareness JSON — discard
          }
          for (const cb of this.awarenessCallbacks) {
            cb(fromPeerId, decoded);
          }
          break;
        }
      }
    } catch {
      // FIX 3: Catch-all for malformed frames — never crash the daemon
      return;
    }
  }

  sendActivity(action: import("@mflow/shared").ActivityAction, file: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "activity", action, file }));
  }

  // ─── Helpers ────────────────────────────────────────────

  private sendRelay(to: string, data: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const msg = JSON.stringify({
      type: "relay",
      to,
      from: this.peerId,
      data: uint8ToBase64(data),
    });
    this.ws.send(msg);
  }

  private setConnectionState(state: ConnectionState): void {
    this.connectionState = state;
  }

  // ─── Reconnection ──────────────────────────────────────

  private scheduleReconnect(): void {
    if (this.disposed) return;

    this.clearReconnectTimer();

    // Exponential backoff: 1s, 2s, 4s, 8s, ... capped at reconnectMaxDelayMs
    const baseDelay = 1000;
    const delay = Math.min(
      baseDelay * Math.pow(2, this.reconnectAttempt),
      this.reconnectMaxDelayMs,
    );
    this.reconnectAttempt++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.disposed) {
        this.connectWebSocket();
      }
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
