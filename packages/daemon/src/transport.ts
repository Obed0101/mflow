import { RTCPeerConnection, RTCIceCandidate } from "werift";
import type {
  ITransport,
  AwarenessData,
  PeerInfo,
  PeerType,
  ConnectionState,
  CipherFrame,
} from "../../shared/src/index.js";
import type {
  SignalingMessage,
  RTCSignalData,
} from "../../shared/src/index.js";
import {
  deriveKeys,
  encrypt,
  decrypt,
  NonceCounter,
  peerIdPrefix,
} from "../../shared/src/index.js";
import {
  NONCE_TOTAL_BYTES,
  NONCE_PEER_PREFIX_BYTES,
  RECONNECT_MAX_DELAY_MS,
} from "../../shared/src/index.js";

const MIN_FRAME_SIZE = 15; // 1 type + 2 fileIdLen + 12 nonce minimum

// ─── Constants ────────────────────────────────────────────────

const FRAME_TYPE_YJS_UPDATE = 0x01;
const FRAME_TYPE_AWARENESS = 0x02;
const DATA_CHANNEL_LABEL = "mflow";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ─── Types ────────────────────────────────────────────────────

export interface WeriftTransportOptions {
  peerId: string;
  peerName: string;
  peerType: PeerType;
  signalingUrl: string;
  stunServers: string[];
  reconnectMaxDelayMs: number;
}

interface PeerConnection {
  pc: RTCPeerConnection;
  dc: ReturnType<RTCPeerConnection["createDataChannel"]> | null;
  peerInfo: PeerInfo;
  ready: boolean;
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

// ─── WeriftTransport ─────────────────────────────────────────

/**
 * WebRTC transport layer using werift (pure-TypeScript WebRTC).
 *
 * Full mesh topology: every peer connects to every other peer.
 * All data channel payloads are encrypted with AES-256-GCM.
 */
export class WeriftTransport implements ITransport {
  // Options
  private readonly peerId: string;
  private readonly peerName: string;
  private readonly peerType: PeerType;
  private readonly signalingUrl: string;
  private readonly stunServers: string[];
  private readonly reconnectMaxDelayMs: number;

  // Internal state
  private ws: WebSocket | null = null;
  private peers: Map<string, PeerConnection> = new Map();
  private connectionState: ConnectionState = "disconnected";
  private encKey: CryptoKey | null = null;
  private roomId = "";
  private authHash = "";
  private secret = "";
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

  constructor(options: WeriftTransportOptions) {
    this.peerId = options.peerId;
    this.peerName = options.peerName;
    this.peerType = options.peerType;
    this.signalingUrl = options.signalingUrl;
    this.stunServers = options.stunServers;
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

    // Close all peer connections
    for (const [peerId, peer] of this.peers) {
      await this.closePeerConnection(peerId, peer);
    }
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
        this.broadcastToDataChannels(encoded);
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
        this.broadcastToDataChannels(encoded);
      },
    );
  }

  onAwareness(
    callback: (peerId: string, data: AwarenessData) => void,
  ): void {
    this.awarenessCallbacks.push(callback);
  }

  getPeers(): PeerInfo[] {
    const result: PeerInfo[] = [];
    for (const peer of this.peers.values()) {
      result.push(peer.peerInfo);
    }
    return result;
  }

  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  sendActivity(action: import("../../shared/src/index.js").ActivityAction, file: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "activity", action, file }));
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
        // WebRTC connections survive signaling loss; only set reconnecting
        // if we were in a connected state
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
      case "signal":
        void this.handleSignal(msg.from, msg.data);
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

    // Create WebRTC connections to all existing peers
    for (const peer of existingPeers) {
      if (peer.peerId === this.peerId) continue;
      void this.createPeerConnection(peer, this.shouldCreateOffer(peer.peerId));
    }
  }

  private handlePeerJoined(peer: PeerInfo): void {
    if (peer.peerId === this.peerId) return;
    void this.createPeerConnection(peer, this.shouldCreateOffer(peer.peerId));
  }

  private handlePeerLeft(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (peer) {
      void this.closePeerConnection(peerId, peer);
      this.peers.delete(peerId);
    }
  }

  private async handleSignal(
    fromPeerId: string,
    signal: RTCSignalData,
  ): Promise<void> {
    let peerConn = this.peers.get(fromPeerId);

    // If we receive an offer from an unknown peer, create a connection for them
    if (!peerConn && signal.type === "offer") {
      const peerInfo: PeerInfo = {
        peerId: fromPeerId,
        peerName: "",
        peerType: "agent",
        joinedAt: Date.now(),
      };
      await this.createPeerConnection(peerInfo, false);
      peerConn = this.peers.get(fromPeerId);
    }

    if (!peerConn) return;

    const { pc } = peerConn;

    try {
      switch (signal.type) {
        case "offer":
          if (!signal.sdp) break;
          await pc.setRemoteDescription({
            type: "offer",
            sdp: signal.sdp,
          });
          {
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            this.sendSignal(fromPeerId, {
              type: "answer",
              sdp: answer.sdp,
            });
          }
          break;

        case "answer":
          if (!signal.sdp) break;
          await pc.setRemoteDescription({
            type: "answer",
            sdp: signal.sdp,
          });
          break;

        case "candidate":
          if (signal.candidate) {
            // werift accepts RTCIceCandidateInit objects directly
            await pc.addIceCandidate(signal.candidate as unknown as RTCIceCandidate);
          }
          break;
      }
    } catch {
      // Silently ignore WebRTC errors (malformed SDP, invalid candidates, state errors).
      // The connection will retry or fall through to reconnect logic.
    }
  }

  // ─── WebRTC Peer Connections ────────────────────────────

  /**
   * Determine who creates the offer.
   * The peer with the lexicographically smaller peerId creates the offer.
   */
  private shouldCreateOffer(remotePeerId: string): boolean {
    return this.peerId < remotePeerId;
  }

  private async createPeerConnection(
    peerInfo: PeerInfo,
    createOffer: boolean,
  ): Promise<void> {
    // Don't recreate if we already have a connection
    if (this.peers.has(peerInfo.peerId)) return;

    const iceServers = this.stunServers.map((url) => ({ urls: url }));

    const pc = new RTCPeerConnection({
      iceServers,
    });

    const conn: PeerConnection = {
      pc,
      dc: null,
      peerInfo,
      ready: false,
    };

    this.peers.set(peerInfo.peerId, conn);

    // Handle ICE candidates
    pc.onIceCandidate.subscribe((candidate) => {
      // werift fires undefined at end-of-candidates — skip it
      if (!candidate) return;

      // werift ICE candidates are already plain objects with candidate/sdpMid/sdpMLineIndex
      const c = candidate as unknown as { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null };
      if (!c.candidate) return;

      this.sendSignal(peerInfo.peerId, {
        type: "candidate",
        candidate: {
          candidate: c.candidate,
          sdpMid: c.sdpMid ?? null,
          sdpMLineIndex: c.sdpMLineIndex ?? null,
        },
      });
    });

    // Handle connection state changes
    pc.connectionStateChange.subscribe((state) => {
      if (state === "connected") {
        conn.ready = true;
      } else if (state === "disconnected" || state === "failed" || state === "closed") {
        conn.ready = false;
        if (state === "failed" && !this.disposed) {
          // Attempt reconnection for failed connections
          this.peers.delete(peerInfo.peerId);
          void pc.close();
          void this.createPeerConnection(peerInfo, this.shouldCreateOffer(peerInfo.peerId));
        }
      }
    });

    // Handle incoming data channels (remote peer created it)
    pc.onDataChannel.subscribe((dc) => {
      if (dc.label === DATA_CHANNEL_LABEL) {
        conn.dc = dc;
        this.setupDataChannel(dc, peerInfo.peerId);
      }
    });

    if (createOffer) {
      // We create the data channel and offer
      const dc = pc.createDataChannel(DATA_CHANNEL_LABEL, {
        ordered: true,
      });
      conn.dc = dc;
      this.setupDataChannel(dc, peerInfo.peerId);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.sendSignal(peerInfo.peerId, {
        type: "offer",
        sdp: offer.sdp,
      });
    }
  }

  private setupDataChannel(
    dc: ReturnType<RTCPeerConnection["createDataChannel"]>,
    remotePeerId: string,
  ): void {
    dc.onMessage.subscribe((data) => {
      // werift delivers Buffer or string
      const bytes =
        data instanceof Buffer
          ? new Uint8Array(data)
          : typeof data === "string"
            ? encoder.encode(data)
            : new Uint8Array(data);

      void this.handleDataChannelMessage(bytes, remotePeerId);
    });
  }

  private async handleDataChannelMessage(
    raw: Uint8Array,
    remotePeerId: string,
  ): Promise<void> {
    if (!this.encKey) return;

    try {
      // FIX 3: Validate minimum frame size before decoding
      if (raw.length < MIN_FRAME_SIZE) return;

      const { type, fileId, frame } = decodeFrame(raw);

      // FIX 2: Verify nonce prefix matches claimed sender
      const expectedPrefix = await peerIdPrefix(remotePeerId);
      const actualPrefix = frame.nonce.slice(0, NONCE_PEER_PREFIX_BYTES);
      if (!expectedPrefix.every((b, i) => b === actualPrefix[i])) {
        return; // Nonce prefix mismatch — possible forgery
      }

      // Validate nonce counter for replay protection
      const counter = extractCounter(frame.nonce);
      if (!this.nonceCounter.validate(remotePeerId, counter)) {
        return; // Replay or out-of-order — discard
      }

      // FIX 2: Include remotePeerId in AAD for sender binding
      const aad = encoder.encode(`${this.roomId}:${fileId}:${remotePeerId}`);

      let plaintext: Uint8Array;
      try {
        plaintext = await decrypt(this.encKey, frame, aad);
      } catch {
        return; // Decryption failed — tampered or wrong key
      }

      switch (type) {
        case FRAME_TYPE_YJS_UPDATE:
          for (const cb of this.updateCallbacks) {
            cb(fileId, plaintext, remotePeerId);
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
            cb(remotePeerId, decoded);
          }
          break;
        }
      }
    } catch {
      // FIX 3: Catch-all for malformed frames — never crash the daemon
      return;
    }
  }

  // ─── Helpers ────────────────────────────────────────────

  private broadcastToDataChannels(data: Uint8Array): void {
    const buf = Buffer.from(data);
    for (const peer of this.peers.values()) {
      if (peer.dc && peer.ready && peer.dc.readyState === "open") {
        peer.dc.send(buf);
      }
    }
  }

  private sendSignal(to: string, data: RTCSignalData): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const msg: SignalingMessage = {
      type: "signal",
      to,
      from: this.peerId,
      data,
    };
    this.ws.send(JSON.stringify(msg));
  }

  private async closePeerConnection(
    _peerId: string,
    peer: PeerConnection,
  ): Promise<void> {
    peer.ready = false;
    if (peer.dc) {
      peer.dc.close();
    }
    await peer.pc.close();
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
