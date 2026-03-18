import type { CipherFrame, DerivedKeys } from "./types.js";
import {
  HKDF_ENC_INFO,
  NONCE_PEER_PREFIX_BYTES,
  NONCE_TOTAL_BYTES,
  AES_KEY_BITS,
} from "./constants.js";

const encoder = new TextEncoder();

// ─── Hashing ──────────────────────────────────────────────────

/**
 * Compute SHA-256 and return the hex-encoded digest.
 */
export async function sha256(data: string | Uint8Array): Promise<string> {
  const input = typeof data === "string" ? encoder.encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", toBuffer(input));
  return bufToHex(new Uint8Array(digest));
}

/**
 * Return the first `NONCE_PEER_PREFIX_BYTES` bytes of SHA-256(peerId).
 * Used as the peer-specific portion of the AES-GCM nonce.
 */
export async function peerIdPrefix(peerId: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(peerId));
  return new Uint8Array(digest, 0, NONCE_PEER_PREFIX_BYTES);
}

// ─── Key Derivation ─────────────────────────────────────────

/**
 * Derive an authentication hash and an AES-256-GCM encryption key from a
 * shared secret.
 *
 * - `authHash`: SHA-256 hex of the secret (sent to signaling for room auth).
 * - `encKey`: HKDF(secret, "mflow-enc", 256) imported as an AES-GCM CryptoKey.
 */
export async function deriveKeys(secret: string, roomId?: string): Promise<DerivedKeys> {
  const authHash = await sha256(secret);

  // Import the raw secret as HKDF key material
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    "HKDF",
    false,
    ["deriveKey"],
  );

  // Use SHA-256(roomId) as HKDF salt to ensure different rooms derive different keys.
  // Falls back to empty salt for backward compatibility when roomId is not provided.
  let salt: Uint8Array<ArrayBuffer>;
  if (roomId) {
    const saltDigest = await crypto.subtle.digest("SHA-256", encoder.encode(roomId));
    salt = new Uint8Array(saltDigest) as Uint8Array<ArrayBuffer>;
  } else {
    salt = new Uint8Array(0) as Uint8Array<ArrayBuffer>;
  }

  // Derive AES-256-GCM key via HKDF-SHA256
  const encKey = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info: encoder.encode(HKDF_ENC_INFO),
    },
    keyMaterial,
    { name: "AES-GCM", length: AES_KEY_BITS },
    false, // non-extractable
    ["encrypt", "decrypt"],
  );

  return { authHash, encKey };
}

// ─── Encrypt / Decrypt ──────────────────────────────────────

/**
 * Build a 96-bit (12-byte) nonce from a peer prefix and a big-endian counter.
 */
function buildNonce(prefix: Uint8Array, counter: bigint): Uint8Array {
  const nonce = new Uint8Array(NONCE_TOTAL_BYTES);
  nonce.set(prefix, 0);

  // Write counter as 8-byte big-endian into bytes [4..12)
  const view = new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength);
  view.setBigUint64(NONCE_PEER_PREFIX_BYTES, counter, false);

  return nonce;
}

/**
 * Encrypt plaintext with AES-256-GCM.
 *
 * @param key      AES-GCM CryptoKey from `deriveKeys`.
 * @param plaintext Raw bytes to encrypt.
 * @param peerId   Sender peer ID (used for nonce prefix).
 * @param counter  Monotonic counter for this peer (used for nonce suffix).
 * @param aad      Additional authenticated data (roomId + fileId concatenation).
 * @returns A `CipherFrame` containing the nonce and ciphertext (with appended GCM tag).
 */
export async function encrypt(
  key: CryptoKey,
  plaintext: Uint8Array,
  peerId: string,
  counter: bigint,
  aad: Uint8Array,
): Promise<CipherFrame> {
  const prefix = await peerIdPrefix(peerId);
  const nonce = buildNonce(prefix, counter);

  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: toBuffer(nonce), additionalData: toBuffer(aad) },
      key,
      toBuffer(plaintext),
    ),
  );

  return { nonce, ciphertext };
}

/**
 * Decrypt a `CipherFrame` produced by `encrypt`.
 *
 * @param key   AES-GCM CryptoKey from `deriveKeys`.
 * @param frame The cipher frame (nonce + ciphertext with GCM tag).
 * @param aad   The same additional authenticated data used during encryption.
 * @returns The decrypted plaintext bytes.
 */
export async function decrypt(
  key: CryptoKey,
  frame: CipherFrame,
  aad: Uint8Array,
): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: toBuffer(frame.nonce),
        additionalData: toBuffer(aad),
      },
      key,
      toBuffer(frame.ciphertext),
    ),
  );
}

// ─── Nonce Counter ──────────────────────────────────────────

/**
 * Per-peer monotonic counter tracker.
 *
 * - `increment(peerId)` returns the next counter value for the local peer
 *   (used when encrypting outbound frames).
 * - `validate(peerId, counter)` checks that an inbound counter is strictly
 *   increasing for the given peer, preventing replay attacks.
 */
export class NonceCounter {
  private readonly counters = new Map<string, bigint>();

  /**
   * Return the next counter value for `peerId` and advance the internal state.
   * Starts at 0 for a previously unseen peer.
   */
  increment(peerId: string): bigint {
    const current = this.counters.get(peerId) ?? -1n;
    const next = current + 1n;
    this.counters.set(peerId, next);
    return next;
  }

  /**
   * Validate that `counter` is strictly greater than the last seen value for
   * `peerId`. If valid, updates the internal state and returns `true`.
   * Returns `false` (and does NOT update state) if the counter is stale or
   * replayed.
   */
  validate(peerId: string, counter: bigint): boolean {
    const last = this.counters.get(peerId) ?? -1n;
    if (counter <= last) {
      return false;
    }
    this.counters.set(peerId, counter);
    return true;
  }
}

// ─── Helpers ────────────────────────────────────────────────

/**
 * Coerce a Uint8Array to one backed by a plain ArrayBuffer.
 * Required for TS 5.9+ where `Uint8Array<ArrayBufferLike>` is not assignable
 * to WebCrypto's `BufferSource` (`ArrayBufferView<ArrayBuffer>`).
 */
function toBuffer(data: Uint8Array): Uint8Array<ArrayBuffer> {
  const buf = new ArrayBuffer(data.byteLength);
  const view = new Uint8Array(buf);
  view.set(data);
  return view;
}

function bufToHex(buf: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < buf.length; i++) {
    hex += buf[i].toString(16).padStart(2, "0");
  }
  return hex;
}
