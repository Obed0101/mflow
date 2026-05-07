import type { ServerWebSocket } from "bun";
import type { SignalingSignal, SignalingRelay } from "../../shared/src/index.js";
import type { PeerContext, RoomManager } from "./rooms.js";

// ─── Relay ──────────────────────────────────────────────────

/**
 * Relay a WebRTC signal (SDP offer/answer or ICE candidate) to the target peer.
 * Returns an error code if the target peer is not found.
 */
export function relaySignal(
  rooms: RoomManager,
  ws: ServerWebSocket<PeerContext>,
  msg: SignalingSignal,
): { ok: true } | { ok: false; code: "PEER_NOT_FOUND"; message: string } {
  const { roomId } = ws.data;
  if (!roomId) {
    return { ok: false, code: "PEER_NOT_FOUND", message: "Not in a room" };
  }

  const targetWs = rooms.findPeer(roomId, msg.to);
  if (!targetWs) {
    return {
      ok: false,
      code: "PEER_NOT_FOUND",
      message: `Peer ${msg.to} not found in room`,
    };
  }

  // Relay the signal to the target peer — rewrite `from` to ensure authenticity
  targetWs.send(
    JSON.stringify({
      type: "signal",
      to: msg.to,
      from: ws.data.peerId,
      data: msg.data,
    }),
  );

  return { ok: true };
}

/**
 * Relay opaque encrypted data between peers.
 * If `to` is "*", broadcasts to all other peers in the room (not the sender).
 * Otherwise, forwards to the specific target peer.
 */
export function relayData(
  rooms: RoomManager,
  ws: ServerWebSocket<PeerContext>,
  msg: SignalingRelay,
): { ok: true } | { ok: false; code: "PEER_NOT_FOUND"; message: string } {
  const { roomId } = ws.data;
  if (!roomId) {
    return { ok: false, code: "PEER_NOT_FOUND", message: "Not in a room" };
  }

  const envelope = JSON.stringify({
    type: "relay",
    to: msg.to,
    from: ws.data.peerId,
    data: msg.data,
  });

  if (msg.to === "*") {
    // Broadcast to all peers in the room except the sender
    const peers = rooms.getRoomPeers(roomId);
    for (const peerWs of peers) {
      if (peerWs.data.peerId !== ws.data.peerId) {
        peerWs.send(envelope);
      }
    }
    return { ok: true };
  }

  // Unicast to a specific peer
  const targetWs = rooms.findPeer(roomId, msg.to);
  if (!targetWs) {
    return {
      ok: false,
      code: "PEER_NOT_FOUND",
      message: `Peer ${msg.to} not found in room`,
    };
  }

  targetWs.send(envelope);
  return { ok: true };
}
