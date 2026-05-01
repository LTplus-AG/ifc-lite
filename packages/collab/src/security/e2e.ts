/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * End-to-end encryption (spec §14, v1.0).
 *
 * Optional: clients in a room share a symmetric per-room key; Y.Doc
 * updates are encrypted with AES-GCM-256 before they hit the
 * websocket. The server only routes ciphertext — it cannot read or
 * mutate the document.
 *
 * Trade-off (documented in the spec): server-side IFCX export is
 * unavailable without key escrow, because the server never sees
 * plaintext. Apps that want escrow can ship the key to a controlled
 * snapshot worker.
 *
 * Wire in:
 *   - Key derivation: PBKDF2(password, salt) → AES-GCM-256 key.
 *   - Frame format: `[1B version][12B IV][N B ciphertext]`. v1 only.
 *   - Key rotation: a new key is derived; both peers are notified;
 *     old keys are kept around for `gracePeriodMs` so in-flight frames
 *     don't fail.
 *   - Member-add: a member is rewrapped — existing members re-derive
 *     the room key with the new salt and post the new key envelope to
 *     the new member out of band (e.g. via app-level invite link).
 *
 * Implemented against the WebCrypto API so it works in the browser
 * and on Node 22+ without pulling in a crypto dep.
 */

const VERSION = 1;
const IV_LEN = 12;

/** Cross-runtime crypto handle. */
const subtle: SubtleCrypto = (() => {
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
    return globalThis.crypto.subtle;
  }
  // Node before 19 needs explicit import.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeCrypto = (globalThis as unknown as { require?: (m: string) => unknown }).require?.(
    'node:crypto',
  ) as { webcrypto?: { subtle?: SubtleCrypto } } | undefined;
  if (nodeCrypto?.webcrypto?.subtle) return nodeCrypto.webcrypto.subtle;
  throw new Error('@ifc-lite/collab: WebCrypto not available in this runtime');
})();

const randomBytes = (n: number): Uint8Array => {
  const out = new Uint8Array(n);
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(out);
    return out;
  }
  throw new Error('@ifc-lite/collab: secure RNG not available in this runtime');
};

export interface RoomKey {
  /** Key version — 1 for AES-GCM-256, monotonic for rotations. */
  version: number;
  /** The opaque WebCrypto handle. */
  key: CryptoKey;
  /** Created-at timestamp in ms. */
  createdAt: number;
}

export interface DeriveOptions {
  /** PBKDF2 iterations. Default 200_000. */
  iterations?: number;
  /** Hash. Default 'SHA-256'. */
  hash?: 'SHA-256' | 'SHA-384' | 'SHA-512';
}

/**
 * Derive a room key from a shared password + salt. Salt is typically
 * the room ID hashed; never reuse the same `(password, salt)` pair
 * across rooms.
 */
export async function deriveRoomKey(
  password: string,
  salt: Uint8Array,
  options: DeriveOptions = {},
): Promise<RoomKey> {
  const iterations = options.iterations ?? 200_000;
  const hash = options.hash ?? 'SHA-256';
  const passwordKey = await subtle.importKey(
    'raw',
    new TextEncoder().encode(password) as unknown as BufferSource,
    { name: 'PBKDF2' },
    false,
    ['deriveKey'],
  );
  const key = await subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations, hash },
    passwordKey,
    { name: 'AES-GCM', length: 256 },
    /* extractable */ true,
    ['encrypt', 'decrypt'],
  );
  return { version: 1, key, createdAt: Date.now() };
}

/** Generate a random AES-GCM-256 room key (no password). */
export async function generateRoomKey(): Promise<RoomKey> {
  const key = await subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    /* extractable */ true,
    ['encrypt', 'decrypt'],
  );
  return { version: 1, key, createdAt: Date.now() };
}

/** Export the raw key bytes so apps can persist or rewrap them. */
export async function exportRoomKey(key: RoomKey): Promise<{ version: number; bytes: Uint8Array }> {
  const raw = await subtle.exportKey('raw', key.key);
  return { version: key.version, bytes: new Uint8Array(raw) };
}

/** Re-import a previously exported key. */
export async function importRoomKey(
  version: number,
  bytes: Uint8Array,
): Promise<RoomKey> {
  const key = await subtle.importKey(
    'raw',
    bytes as unknown as BufferSource,
    { name: 'AES-GCM' },
    /* extractable */ true,
    ['encrypt', 'decrypt'],
  );
  return { version, key, createdAt: Date.now() };
}

/** Encrypt a plaintext frame. Adds a 13-byte header (`[ver][iv]`). */
export async function encryptFrame(plaintext: Uint8Array, key: RoomKey): Promise<Uint8Array> {
  const iv = randomBytes(IV_LEN);
  const ct = await subtle.encrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    key.key,
    plaintext as unknown as ArrayBuffer,
  );
  const ctBytes = new Uint8Array(ct);
  const frame = new Uint8Array(1 + IV_LEN + ctBytes.byteLength);
  frame[0] = VERSION;
  frame.set(iv, 1);
  frame.set(ctBytes, 1 + IV_LEN);
  return frame;
}

/**
 * Decrypt a frame using `keys`. Tries each key in order so callers can
 * pass `[currentKey, ...recentKeys]` to gracefully decode in-flight
 * frames around a rotation.
 */
export async function decryptFrame(frame: Uint8Array, keys: readonly RoomKey[]): Promise<Uint8Array> {
  if (frame.byteLength < 1 + IV_LEN) {
    throw new Error('@ifc-lite/collab: frame too small');
  }
  if (frame[0] !== VERSION) {
    throw new Error(`@ifc-lite/collab: unsupported frame version ${frame[0]}`);
  }
  const iv = frame.slice(1, 1 + IV_LEN);
  const ct = frame.slice(1 + IV_LEN);
  let lastErr: unknown;
  for (const key of keys) {
    try {
      const pt = await subtle.decrypt(
        { name: 'AES-GCM', iv: iv as unknown as BufferSource },
        key.key,
        ct as unknown as ArrayBuffer,
      );
      return new Uint8Array(pt);
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `@ifc-lite/collab: decryption failed against ${keys.length} key(s): ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}

/* ------------------------------------------------------------------ */
/* Key ring (rotation + grace period)                                  */
/* ------------------------------------------------------------------ */

export interface KeyRingOptions {
  /** Keep retired keys for this long after rotation, ms. Default 30_000. */
  gracePeriodMs?: number;
  /** Override `Date.now`. */
  now?: () => number;
}

export interface KeyRing {
  current(): RoomKey;
  /** Rotate: new key becomes current; previous key is retained for grace. */
  rotate(next: RoomKey): void;
  /** All keys — current + still-in-grace ones. Most-recent first. */
  active(): RoomKey[];
  /** Drop keys that are past grace. */
  prune(): number;
}

export function createKeyRing(initial: RoomKey, options: KeyRingOptions = {}): KeyRing {
  const grace = options.gracePeriodMs ?? 30_000;
  const now = options.now ?? Date.now;
  let cur: RoomKey = initial;
  const retired: { key: RoomKey; retiredAt: number }[] = [];

  const prune = (): number => {
    const cutoff = now() - grace;
    let dropped = 0;
    while (retired.length > 0 && retired[0].retiredAt < cutoff) {
      retired.shift();
      dropped += 1;
    }
    return dropped;
  };

  return {
    current: () => cur,
    rotate(next) {
      retired.push({ key: cur, retiredAt: now() });
      cur = next;
      prune();
    },
    active() {
      prune();
      return [cur, ...retired.map((r) => r.key)];
    },
    prune,
  };
}
