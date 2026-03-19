import type { ServerWebSocket } from "bun";
import type { PeerInfo, SignalingErrorCode } from "@mflow/shared";
import { MAX_PEERS_PER_ROOM } from "@mflow/shared";

// ─── Types ──────────────────────────────────────────────────

export interface Room {
  id: string;
  secretHash: string;
  peers: Map<string, ServerWebSocket<PeerContext>>;
  createdAt: number;
}

export interface PeerContext {
  peerId: string;
  peerName: string;
  peerType: "agent" | "human";
  roomId: string | null;
  ip: string;
}

// ─── Room Manager ───────────────────────────────────────────

export class RoomManager {
  private readonly rooms = new Map<string, Room>();

  getRoomCount(): number {
    return this.rooms.size;
  }

  getTotalPeerCount(): number {
    let count = 0;
    for (const room of this.rooms.values()) {
      count += room.peers.size;
    }
    return count;
  }

  /**
   * Join a peer to a room. Creates the room if it doesn't exist.
   * Returns the list of existing peers on success, or an error on failure.
   */
  join(
    ws: ServerWebSocket<PeerContext>,
    roomId: string,
    secretHash: string,
    peerId: string,
    peerName: string,
    peerType: "agent" | "human",
  ): { ok: true; peers: PeerInfo[] } | { ok: false; code: SignalingErrorCode; message: string } {
    let room = this.rooms.get(roomId);

    if (room) {
      // Verify secret hash — generic message to avoid leaking room existence
      if (room.secretHash !== secretHash) {
        return { ok: false, code: "AUTH_FAILED", message: "Unable to join room" };
      }

      // Reject if peerId is already taken by a different WebSocket
      const existingWs = room.peers.get(peerId);
      if (existingWs && existingWs !== ws) {
        return { ok: false, code: "PEER_ID_TAKEN", message: "Peer ID is already in use in this room" };
      }

      // Check peer limit
      if (room.peers.size >= MAX_PEERS_PER_ROOM) {
        return {
          ok: false,
          code: "ROOM_FULL",
          message: `Room is full (max ${MAX_PEERS_PER_ROOM} peers)`,
        };
      }
    } else {
      // Create new room — first peer sets the secret hash
      room = {
        id: roomId,
        secretHash,
        peers: new Map(),
        createdAt: Date.now(),
      };
      this.rooms.set(roomId, room);
    }

    // Collect existing peers before adding new one
    const existingPeers: PeerInfo[] = [];
    for (const [id, peerWs] of room.peers) {
      const ctx = peerWs.data;
      existingPeers.push({
        peerId: id,
        peerName: ctx.peerName,
        peerType: ctx.peerType,
        joinedAt: 0, // Not tracked in Room, set by caller if needed
      });
    }

    // Add the new peer
    room.peers.set(peerId, ws);
    ws.data.roomId = roomId;
    ws.data.peerId = peerId;
    ws.data.peerName = peerName;
    ws.data.peerType = peerType;

    return { ok: true, peers: existingPeers };
  }

  /**
   * Remove a peer from their room. Cleans up empty rooms.
   * Returns the room's remaining peers to notify, or null if no room.
   */
  leave(ws: ServerWebSocket<PeerContext>): { roomId: string; peerId: string; remainingPeers: ServerWebSocket<PeerContext>[] } | null {
    const { roomId, peerId } = ws.data;
    if (!roomId) return null;

    const room = this.rooms.get(roomId);
    if (!room) return null;

    room.peers.delete(peerId);
    ws.data.roomId = null;

    const remainingPeers = Array.from(room.peers.values());

    // Clean up empty rooms
    if (room.peers.size === 0) {
      this.rooms.delete(roomId);
    }

    return { roomId, peerId, remainingPeers };
  }

  /**
   * Find a peer's WebSocket by peerId within a room.
   */
  findPeer(roomId: string, peerId: string): ServerWebSocket<PeerContext> | undefined {
    return this.rooms.get(roomId)?.peers.get(peerId);
  }

  /**
   * Get all peer WebSockets in a room.
   */
  getRoomPeers(roomId: string): ServerWebSocket<PeerContext>[] {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    return Array.from(room.peers.values());
  }
}
