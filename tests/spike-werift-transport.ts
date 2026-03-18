#!/usr/bin/env bun
/**
 * Diagnostic test: WeriftTransport through signaling server.
 *
 * Tests the full flow with detailed state logging:
 * 1. Start signaling server
 * 2. Create 2 WeriftTransport instances
 * 3. Connect both to same room
 * 4. Monitor WebRTC connection states
 * 5. Send a Y.js update from A -> B
 * 6. Report exactly where it breaks
 */

import { RTCPeerConnection } from "werift";
import { WeriftTransport } from "../packages/daemon/src/transport.js";
import { server } from "../packages/signaling/src/index.js";

const SIGNALING_PORT = server.port;
const SIGNALING_URL = `ws://localhost:${SIGNALING_PORT}`;
const ROOM = "diag-test";
const SECRET = "test-secret-123";

console.log(`=== WeriftTransport Diagnostic ===`);
console.log(`Signaling: ${SIGNALING_URL}`);
console.log();

// Monkey-patch WeriftTransport to add logging
function patchTransport(t: any, name: string) {
  const origHandleSignaling = t.handleSignalingMessage.bind(t);
  t.handleSignalingMessage = (msg: any) => {
    console.log(`[${name}] << signaling: ${msg.type}${msg.type === "signal" ? ` (${msg.data?.type} from ${msg.from})` : ""}${msg.type === "joined" ? ` (${msg.peers?.length} peers)` : ""}`);
    return origHandleSignaling(msg);
  };

  const origSendSignal = t.sendSignal.bind(t);
  t.sendSignal = (to: string, data: any) => {
    console.log(`[${name}] >> signal: ${data.type} to ${to}${data.sdp ? ` (sdp len=${data.sdp.length})` : ""}${data.candidate ? ` (${data.candidate.candidate?.substring(0, 60)}...)` : ""}`);
    return origSendSignal(to, data);
  };

  const origCreatePC = t.createPeerConnection.bind(t);
  t.createPeerConnection = async (peerInfo: any, createOffer: boolean) => {
    console.log(`[${name}] createPeerConnection(${peerInfo.peerId}, offer=${createOffer})`);
    await origCreatePC(peerInfo, createOffer);
    const conn = t.peers.get(peerInfo.peerId);
    if (conn) {
      console.log(`[${name}] PeerConnection created. DC: ${conn.dc ? "yes" : "no"}, ready: ${conn.ready}`);
      conn.pc.connectionStateChange.subscribe((state: string) => {
        console.log(`[${name}] WebRTC connectionState: ${state}`);
      });
      if (conn.dc) {
        conn.dc.stateChanged.subscribe((state: string) => {
          console.log(`[${name}] DataChannel state: ${state}`);
        });
      }
    }
  };
}

// Create 2 transports with different peer IDs
const transportA = new WeriftTransport({
  peerId: "peer-aaa",
  peerName: "transport-A",
  peerType: "agent",
  signalingUrl: SIGNALING_URL,
  stunServers: ["stun:stun.l.google.com:19302"],
  reconnectMaxDelayMs: 5000,
});

const transportB = new WeriftTransport({
  peerId: "peer-bbb",
  peerName: "transport-B",
  peerType: "agent",
  signalingUrl: SIGNALING_URL,
  stunServers: ["stun:stun.l.google.com:19302"],
  reconnectMaxDelayMs: 5000,
});

// Patch for logging
patchTransport(transportA, "A");
patchTransport(transportB, "B");

// Track what B receives
let receivedUpdate: { fileId: string; data: string; peerId: string } | null = null;

transportB.onUpdate((fileId, update, peerId) => {
  receivedUpdate = {
    fileId,
    data: Buffer.from(update).toString("utf-8"),
    peerId,
  };
  console.log(`\n[B] *** RECEIVED UPDATE: fileId=${fileId}, data="${receivedUpdate.data}", from=${peerId} ***\n`);
});

// Connect A first
console.log("[1] Connecting transport A...");
await transportA.connect(ROOM, SECRET);
console.log(`[1] Transport A state: ${transportA.getConnectionState()}`);

// Wait a bit, then connect B
await sleep(500);

console.log("\n[2] Connecting transport B...");
await transportB.connect(ROOM, SECRET);
console.log(`[2] Transport B state: ${transportB.getConnectionState()}`);

// Wait for WebRTC to establish
console.log("\n[3] Waiting for WebRTC connection (15s max)...");

for (let i = 0; i < 150; i++) {
  await sleep(100);
  if (i % 20 === 0 && i > 0) {
    const peersA = transportA.getPeers();
    const peersB = transportB.getPeers();
    console.log(`\n  --- ${i/10}s --- A peers: ${peersA.length}, B peers: ${peersB.length}`);
    // Check internal WebRTC state
    const tA = transportA as any;
    const tB = transportB as any;
    for (const [id, peer] of tA.peers) {
      console.log(`  A->peer(${id}): ready=${peer.ready}, dc=${peer.dc?.readyState ?? "null"}, conn=${peer.pc.connectionState}`);
    }
    for (const [id, peer] of tB.peers) {
      console.log(`  B->peer(${id}): ready=${peer.ready}, dc=${peer.dc?.readyState ?? "null"}, conn=${peer.pc.connectionState}`);
    }
  }
}

// Check health endpoint
const health = await fetch(`http://localhost:${SIGNALING_PORT}/health`).then(r => r.json());
console.log(`\n[4] Server health: ${JSON.stringify(health)}`);

// Try sending an update
console.log("[5] Sending Y.js update from A...");
const testUpdate = new TextEncoder().encode("test-yjs-update-data");
transportA.sendUpdate("test-file.txt", testUpdate);

// Wait for delivery
console.log("[6] Waiting for B to receive (5s)...");
for (let i = 0; i < 50; i++) {
  await sleep(100);
  if (receivedUpdate) break;
}

console.log("\n=== RESULTS ===");
console.log(`Transport A state: ${transportA.getConnectionState()}`);
console.log(`Transport B state: ${transportB.getConnectionState()}`);

// Detailed peer connection state
const tA = transportA as any;
const tB = transportB as any;
for (const [id, peer] of tA.peers) {
  console.log(`A->peer(${id}): ready=${peer.ready}, dc.readyState=${peer.dc?.readyState ?? "null"}, connState=${peer.pc.connectionState}`);
}
for (const [id, peer] of tB.peers) {
  console.log(`B->peer(${id}): ready=${peer.ready}, dc.readyState=${peer.dc?.readyState ?? "null"}, connState=${peer.pc.connectionState}`);
}

console.log(`Update received by B: ${receivedUpdate ? "YES" : "NO"}`);
if (receivedUpdate) {
  console.log(`  fileId: ${receivedUpdate.fileId}`);
  console.log(`  data: ${receivedUpdate.data}`);
  console.log("\n*** WERIFT TRANSPORT WORKS! ***");
} else {
  console.log("\n*** WERIFT TRANSPORT FAILED ***");
}

// Cleanup
await transportA.disconnect();
await transportB.disconnect();
server.stop(true);
process.exit(receivedUpdate ? 0 : 1);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
