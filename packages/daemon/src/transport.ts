import type {
  ActivityAction,
  AwarenessData,
  ConnectionState,
  ITransport,
  PeerInfo,
  PeerType,
} from "../../shared/src/index.js";

export interface WeriftTransportOptions {
  peerId: string;
  peerName: string;
  peerType: PeerType;
  signalingUrl: string;
  stunServers: string[];
  reconnectMaxDelayMs: number;
}

/**
 * P2P transport placeholder.
 *
 * The public npm package ships relay transport only until the upstream WebRTC
 * stack removes its vulnerable `ip` dependency. Keeping this stub preserves
 * imports for experimental callers without pulling the vulnerable dependency
 * into normal installs.
 */
export class WeriftTransport implements ITransport {
  readonly #peerInfo: PeerInfo;

  constructor(options: WeriftTransportOptions) {
    this.#peerInfo = {
      peerId: options.peerId,
      peerName: options.peerName,
      peerType: options.peerType,
      joinedAt: Date.now(),
    };
  }

  async connect(): Promise<void> {
    throw new Error("P2P transport is disabled in this release; use relay transport.");
  }

  async disconnect(): Promise<void> {
    return Promise.resolve();
  }

  sendUpdate(): void {}

  onUpdate(): void {}

  sendAwareness(): void {}

  onAwareness(): void {}

  sendActivity(_action: ActivityAction, _file: string): void {}

  getPeers(): PeerInfo[] {
    return [this.#peerInfo];
  }

  getConnectionState(): ConnectionState {
    return "disconnected";
  }
}
