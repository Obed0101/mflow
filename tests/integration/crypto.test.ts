/**
 * T6.5: Integration test — E2E Encryption + Nonce Replay Protection
 *
 * Covers:
 * - P5.4: All CRDT payloads encrypted with AES-256-GCM derived from room secret
 * - Nonce replay protection: replayed messages are rejected by NonceCounter
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  sha256,
  peerIdPrefix,
  deriveKeys,
  encrypt,
  decrypt,
  NonceCounter,
} from "@mflow/shared";

// ─── Key Derivation ────────────────────────────────────────────────────────────

describe("T6.5: Encryption & Nonce Replay Protection", () => {
  describe("Key Derivation", () => {
    test("deriveKeys produces consistent authHash for same secret", async () => {
      const keys1 = await deriveKeys("test-secret");
      const keys2 = await deriveKeys("test-secret");
      expect(keys1.authHash).toBe(keys2.authHash);
    });

    test("deriveKeys produces different authHash for different secrets", async () => {
      const keys1 = await deriveKeys("secret-a");
      const keys2 = await deriveKeys("secret-b");
      expect(keys1.authHash).not.toBe(keys2.authHash);
    });

    test("authHash is 64-char hex (SHA-256)", async () => {
      const keys = await deriveKeys("any-secret");
      expect(keys.authHash).toHaveLength(64);
      expect(keys.authHash).toMatch(/^[0-9a-f]{64}$/);
    });

    test("encKey is a non-extractable AES-GCM CryptoKey", async () => {
      const { encKey } = await deriveKeys("room-secret");
      expect(encKey.type).toBe("secret");
      expect(encKey.algorithm.name).toBe("AES-GCM");
      expect(encKey.extractable).toBe(false);
      expect(encKey.usages).toContain("encrypt");
      expect(encKey.usages).toContain("decrypt");
    });
  });

  // ─── Encrypt / Decrypt Round-Trip ─────────────────────────────────────────

  describe("Encrypt / Decrypt Round-Trip", () => {
    test("encrypt then decrypt recovers original plaintext", async () => {
      const { encKey } = await deriveKeys("room-secret");
      const plaintext = new TextEncoder().encode("hello world");
      const aad = new TextEncoder().encode("room1:file.ts");

      const frame = await encrypt(encKey, plaintext, "peer-1", 0n, aad);
      const decrypted = await decrypt(encKey, frame, aad);

      expect(new TextDecoder().decode(decrypted)).toBe("hello world");
    });

    test("nonce is 12 bytes", async () => {
      const { encKey } = await deriveKeys("secret");
      const frame = await encrypt(
        encKey,
        new Uint8Array([1, 2, 3]),
        "p",
        0n,
        new Uint8Array(0),
      );
      expect(frame.nonce.byteLength).toBe(12);
    });

    test("different counters produce different nonces", async () => {
      const { encKey } = await deriveKeys("secret");
      const pt = new Uint8Array([1]);
      const aad = new Uint8Array(0);
      const f1 = await encrypt(encKey, pt, "peer", 0n, aad);
      const f2 = await encrypt(encKey, pt, "peer", 1n, aad);
      expect(f1.nonce).not.toEqual(f2.nonce);
    });

    test("different peers produce different nonces for the same counter", async () => {
      const { encKey } = await deriveKeys("secret");
      const pt = new Uint8Array([42]);
      const aad = new Uint8Array(0);
      const f1 = await encrypt(encKey, pt, "peer-alpha", 0n, aad);
      const f2 = await encrypt(encKey, pt, "peer-beta", 0n, aad);
      expect(f1.nonce).not.toEqual(f2.nonce);
    });

    test("wrong key fails to decrypt", async () => {
      const keys1 = await deriveKeys("secret-1");
      const keys2 = await deriveKeys("secret-2");
      const aad = new TextEncoder().encode("room:file");

      const frame = await encrypt(
        keys1.encKey,
        new TextEncoder().encode("data"),
        "p",
        0n,
        aad,
      );

      await expect(decrypt(keys2.encKey, frame, aad)).rejects.toThrow();
    });

    test("tampered ciphertext fails to decrypt (GCM tag verification)", async () => {
      const { encKey } = await deriveKeys("secret");
      const aad = new TextEncoder().encode("room:file");
      const frame = await encrypt(
        encKey,
        new TextEncoder().encode("data"),
        "p",
        0n,
        aad,
      );

      // Flip the first byte of ciphertext — GCM authentication tag must reject this
      frame.ciphertext[0] ^= 0xff;

      await expect(decrypt(encKey, frame, aad)).rejects.toThrow();
    });

    test("wrong AAD fails to decrypt", async () => {
      const { encKey } = await deriveKeys("secret");
      const aad1 = new TextEncoder().encode("room:file1");
      const aad2 = new TextEncoder().encode("room:file2");

      const frame = await encrypt(
        encKey,
        new TextEncoder().encode("data"),
        "p",
        0n,
        aad1,
      );

      await expect(decrypt(encKey, frame, aad2)).rejects.toThrow();
    });

    test("ciphertext does not contain plaintext in readable form", async () => {
      const { encKey } = await deriveKeys("secret");
      const plaintext = new TextEncoder().encode("SENSITIVE_DATA_HERE");
      const aad = new TextEncoder().encode("r:f");

      const frame = await encrypt(encKey, plaintext, "p", 0n, aad);

      // Decode ciphertext leniently and verify plaintext is absent
      const ctStr = new TextDecoder("utf-8", { fatal: false }).decode(
        frame.ciphertext,
      );
      expect(ctStr).not.toContain("SENSITIVE_DATA_HERE");
    });

    test("round-trip preserves empty plaintext", async () => {
      const { encKey } = await deriveKeys("secret");
      const aad = new TextEncoder().encode("room:file");
      const plaintext = new Uint8Array(0);

      const frame = await encrypt(encKey, plaintext, "peer", 0n, aad);
      const decrypted = await decrypt(encKey, frame, aad);

      expect(decrypted.byteLength).toBe(0);
    });

    test("round-trip preserves large plaintext (64 KB)", async () => {
      const { encKey } = await deriveKeys("secret");
      const aad = new TextEncoder().encode("room:bigfile.ts");
      const plaintext = new Uint8Array(65_536).fill(0xab);

      const frame = await encrypt(encKey, plaintext, "peer-x", 5n, aad);
      const decrypted = await decrypt(encKey, frame, aad);

      expect(decrypted).toEqual(plaintext);
    });

    test("same plaintext encrypted twice produces different ciphertext (different nonces)", async () => {
      const { encKey } = await deriveKeys("secret");
      const aad = new TextEncoder().encode("room:file");
      const plaintext = new TextEncoder().encode("identical payload");

      const f1 = await encrypt(encKey, plaintext, "peer", 0n, aad);
      const f2 = await encrypt(encKey, plaintext, "peer", 1n, aad);

      // Ciphertexts differ because nonces differ
      expect(f1.ciphertext).not.toEqual(f2.ciphertext);
    });
  });

  // ─── Nonce Counter ─────────────────────────────────────────────────────────

  describe("Nonce Counter", () => {
    let nc: NonceCounter;

    beforeEach(() => {
      nc = new NonceCounter();
    });

    test("increment starts at 0 and increases monotonically", () => {
      expect(nc.increment("peer1")).toBe(0n);
      expect(nc.increment("peer1")).toBe(1n);
      expect(nc.increment("peer1")).toBe(2n);
    });

    test("different peers have independent counters", () => {
      expect(nc.increment("peer1")).toBe(0n);
      expect(nc.increment("peer2")).toBe(0n);
      expect(nc.increment("peer1")).toBe(1n);
    });

    test("validate accepts strictly increasing counters", () => {
      expect(nc.validate("peer1", 0n)).toBe(true);
      expect(nc.validate("peer1", 1n)).toBe(true);
      // Gaps are accepted — counter only needs to be strictly greater
      expect(nc.validate("peer1", 5n)).toBe(true);
    });

    test("validate rejects replayed counter (same value)", () => {
      nc.validate("peer1", 5n);
      expect(nc.validate("peer1", 5n)).toBe(false);
    });

    test("validate rejects counter lower than last seen", () => {
      nc.validate("peer1", 5n);
      expect(nc.validate("peer1", 3n)).toBe(false);
    });

    test("validate rejects counter = 0 after seeing counter = 0", () => {
      expect(nc.validate("peer1", 0n)).toBe(true);
      expect(nc.validate("peer1", 0n)).toBe(false);
    });

    test("replay rejection does not update internal state", () => {
      nc.validate("peer1", 10n);
      nc.validate("peer1", 5n); // rejected
      // Next valid counter must still be > 10, not > 5
      expect(nc.validate("peer1", 8n)).toBe(false);
      expect(nc.validate("peer1", 11n)).toBe(true);
    });

    test("validate for a new peer accepts counter 0 on first call", () => {
      expect(nc.validate("brand-new-peer", 0n)).toBe(true);
    });

    test("separate NonceCounter instances are independent", () => {
      const nc2 = new NonceCounter();
      nc.validate("peer1", 100n);
      // nc2 has never seen peer1, so counter 0 must be accepted
      expect(nc2.validate("peer1", 0n)).toBe(true);
    });

    test("increment and validate interoperate correctly", () => {
      // Simulate a sender/receiver pair using the same counter
      const sender = new NonceCounter();
      const receiver = new NonceCounter();

      const c0 = sender.increment("p");
      const c1 = sender.increment("p");
      const c2 = sender.increment("p");

      expect(receiver.validate("p", c0)).toBe(true);
      expect(receiver.validate("p", c1)).toBe(true);
      expect(receiver.validate("p", c2)).toBe(true);

      // Replay attack: retransmit c1 — receiver must reject it
      expect(receiver.validate("p", c1)).toBe(false);
    });
  });

  // ─── SHA-256 ───────────────────────────────────────────────────────────────

  describe("SHA-256", () => {
    test("produces consistent 64-char hex output", async () => {
      const h1 = await sha256("test");
      const h2 = await sha256("test");
      expect(h1).toBe(h2);
      expect(h1).toHaveLength(64);
    });

    test("output matches only lowercase hex characters", async () => {
      const h = await sha256("any input");
      expect(h).toMatch(/^[0-9a-f]{64}$/);
    });

    test("different inputs produce different hashes", async () => {
      const h1 = await sha256("input-a");
      const h2 = await sha256("input-b");
      expect(h1).not.toBe(h2);
    });

    test("accepts Uint8Array input", async () => {
      const h = await sha256(new Uint8Array([1, 2, 3]));
      expect(h).toHaveLength(64);
      expect(h).toMatch(/^[0-9a-f]{64}$/);
    });

    test("string and equivalent Uint8Array produce the same hash", async () => {
      const str = "hello";
      const bytes = new TextEncoder().encode(str);
      const hStr = await sha256(str);
      const hBytes = await sha256(bytes);
      expect(hStr).toBe(hBytes);
    });

    test("empty string produces a known 64-char hash", async () => {
      const h = await sha256("");
      // SHA-256 of empty string is deterministic
      expect(h).toHaveLength(64);
      expect(h).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  // ─── Peer ID Prefix ────────────────────────────────────────────────────────

  describe("Peer ID Prefix", () => {
    test("returns exactly 4 bytes", async () => {
      const prefix = await peerIdPrefix("some-peer-id");
      expect(prefix.byteLength).toBe(4);
    });

    test("same peerId produces identical prefix", async () => {
      const p1 = await peerIdPrefix("peer-x");
      const p2 = await peerIdPrefix("peer-x");
      expect(p1).toEqual(p2);
    });

    test("different peerIds produce different prefixes (collision resistance)", async () => {
      const p1 = await peerIdPrefix("peer-alpha");
      const p2 = await peerIdPrefix("peer-beta");
      // This is probabilistically certain for non-identical inputs
      expect(p1).not.toEqual(p2);
    });

    test("prefix is a leading slice of SHA-256(peerId)", async () => {
      const peerId = "test-peer";
      const fullHash = await sha256(peerId);
      const prefix = await peerIdPrefix(peerId);

      // Convert first 4 bytes of full hash to hex for comparison
      const expectedHex = fullHash.slice(0, 8); // 4 bytes = 8 hex chars
      const actualHex = Array.from(prefix)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      expect(actualHex).toBe(expectedHex);
    });
  });
});
