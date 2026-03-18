import { EventEmitter } from "node:events";
import type { AwarenessData, PeerType, ConnectionQuality, ITransport } from "@mflow/shared";
import { AWARENESS_BROADCAST_MS } from "@mflow/shared";

// ─── Types ──────────────────────────────────────────────────

export interface AwarenessManagerEvents {
  "peer-updated": (peerId: string, data: AwarenessData) => void;
  "peer-removed": (peerId: string) => void;
  "concurrent-edit": (path: string, peerIds: string[]) => void;
}

export interface AwarenessManagerOptions {
  peerId: string;
  peerName: string;
  peerType: PeerType;
  broadcastIntervalMs?: number;
  shareCurrentFile?: boolean;
}

// ─── AwarenessManager ───────────────────────────────────────

/**
 * Manages peer awareness data — who is editing what file, connection quality, etc.
 *
 * Broadcasts local awareness state at regular intervals and tracks remote
 * peer states. Detects concurrent edits on the same file.
 */
export class AwarenessManager extends EventEmitter {
  private readonly peers = new Map<string, AwarenessData>();
  private readonly localPeerId: string;
  private readonly peerName: string;
  private readonly peerType: PeerType;
  private readonly broadcastIntervalMs: number;
  private readonly shareCurrentFile: boolean;

  private currentFile: string | null = null;
  private editingFiles: string[] = [];
  private connectionQuality: ConnectionQuality = "good";
  private broadcastTimer: ReturnType<typeof setInterval> | null = null;
  private transport: ITransport | null = null;

  constructor(options: AwarenessManagerOptions) {
    super();
    this.localPeerId = options.peerId;
    this.peerName = options.peerName;
    this.peerType = options.peerType;
    this.broadcastIntervalMs = options.broadcastIntervalMs ?? AWARENESS_BROADCAST_MS;
    this.shareCurrentFile = options.shareCurrentFile ?? true;
  }

  // ─── Transport Binding ──────────────────────────────────

  /**
   * Bind to a transport for sending/receiving awareness data.
   */
  bind(transport: ITransport): void {
    this.transport = transport;

    transport.onAwareness((peerId, data) => {
      this.handleRemoteAwareness(peerId, data);
    });
  }

  // ─── Local State ────────────────────────────────────────

  /**
   * Update the currently active file.
   */
  setCurrentFile(path: string | null): void {
    this.currentFile = path;
    void this.broadcastNow();
  }

  /**
   * Update the list of files with active Y.Docs.
   */
  setEditingFiles(paths: string[]): void {
    this.editingFiles = paths;
  }

  /**
   * Update connection quality assessment.
   */
  setConnectionQuality(quality: ConnectionQuality): void {
    this.connectionQuality = quality;
  }

  /**
   * Build the local awareness data snapshot.
   */
  getLocalState(): AwarenessData {
    return {
      peerId: this.localPeerId,
      peerName: this.peerName,
      peerType: this.peerType,
      currentFile: this.shareCurrentFile ? this.currentFile : null,
      editingFiles: this.editingFiles,
      connectionQuality: this.connectionQuality,
      timestamp: Date.now(),
    };
  }

  // ─── Remote State ───────────────────────────────────────

  /**
   * Get awareness data for a specific peer.
   */
  getPeerState(peerId: string): AwarenessData | undefined {
    return this.peers.get(peerId);
  }

  /**
   * Get all known peer awareness states.
   */
  getAllPeerStates(): Map<string, AwarenessData> {
    return new Map(this.peers);
  }

  /**
   * Remove a peer's awareness state (e.g., on disconnect).
   */
  removePeer(peerId: string): void {
    this.peers.delete(peerId);
    this.emit("peer-removed", peerId);
  }

  // ─── Concurrent Edit Detection ──────────────────────────

  /**
   * Get peers currently editing a specific file.
   */
  getFileEditors(path: string): string[] {
    const editors: string[] = [];
    for (const [peerId, data] of this.peers) {
      if (data.currentFile === path) {
        editors.push(peerId);
      }
    }
    return editors;
  }

  /**
   * Get all files being concurrently edited by 2+ peers.
   */
  getConcurrentEdits(): Map<string, string[]> {
    const fileEditors = new Map<string, string[]>();

    // Include local peer
    if (this.currentFile) {
      fileEditors.set(this.currentFile, [this.localPeerId]);
    }

    // Add remote peers
    for (const [peerId, data] of this.peers) {
      if (data.currentFile) {
        const editors = fileEditors.get(data.currentFile) ?? [];
        editors.push(peerId);
        fileEditors.set(data.currentFile, editors);
      }
    }

    // Filter to files with 2+ editors
    const concurrent = new Map<string, string[]>();
    for (const [path, editors] of fileEditors) {
      if (editors.length >= 2) {
        concurrent.set(path, editors);
      }
    }

    return concurrent;
  }

  // ─── Broadcasting ───────────────────────────────────────

  /**
   * Start periodic awareness broadcasting.
   */
  startBroadcasting(): void {
    if (this.broadcastTimer) return;

    this.broadcastTimer = setInterval(() => {
      void this.broadcastNow();
    }, this.broadcastIntervalMs);

    // Initial broadcast
    void this.broadcastNow();
  }

  /**
   * Stop periodic broadcasting.
   */
  stopBroadcasting(): void {
    if (this.broadcastTimer) {
      clearInterval(this.broadcastTimer);
      this.broadcastTimer = null;
    }
  }

  /**
   * Send awareness state immediately.
   */
  private async broadcastNow(): Promise<void> {
    if (!this.transport) return;

    const state = this.getLocalState();
    this.transport.sendAwareness(state);
  }

  // ─── Incoming ───────────────────────────────────────────

  /**
   * Handle awareness data received from a remote peer.
   */
  private handleRemoteAwareness(peerId: string, data: AwarenessData): void {
    const previous = this.peers.get(peerId);
    this.peers.set(peerId, data);
    this.emit("peer-updated", peerId, data);

    // Check for new concurrent edits
    if (data.currentFile) {
      const editors = this.getFileEditors(data.currentFile);
      // Include self if editing the same file
      if (this.currentFile === data.currentFile) {
        editors.push(this.localPeerId);
      }
      if (editors.length >= 2) {
        this.emit("concurrent-edit", data.currentFile, editors);
      }
    }
  }

  // ─── Lifecycle ──────────────────────────────────────────

  /**
   * Clean up all state and timers.
   */
  dispose(): void {
    this.stopBroadcasting();
    this.peers.clear();
    this.transport = null;
    this.removeAllListeners();
  }
}
