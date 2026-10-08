/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Node identity for Studio documents.
 *
 * - `uuidv7()` mints a fresh, time-ordered RFC 9562 version-7 UUID. It is the
 *   only impure id source in the package and is called by hosts (UI, agent,
 *   import) when they build ops; the reducer never calls it.
 * - `deriveId(seed, salt)` is the pure counterpart the reducer uses when an
 *   op needs ids it was not handed (e.g. the facets a `spec.duplicate`
 *   creates): a deterministic name-based UUID (version 8, RFC 9562 §5.8)
 *   from an FNV-1a hash of `seed` and `salt`. The same op therefore always
 *   produces the same ids, which keeps `apply` a pure function and replays
 *   of a persisted op log byte-identical.
 */

/** A lower-case hyphenated UUID string. */
export type Uuid = string;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** True for a lower-case hyphenated UUID of any version. */
export function isUuid(value: unknown): value is Uuid {
  return typeof value === 'string' && UUID_RE.test(value);
}

export interface UuidV7Source {
  /** Milliseconds since the Unix epoch. Defaults to `Date.now()`. */
  now?: () => number;
  /** Fills `bytes` with random data. Defaults to `crypto.getRandomValues`. */
  random?: (bytes: Uint8Array<ArrayBuffer>) => void;
}

function defaultRandom(bytes: Uint8Array<ArrayBuffer>): void {
  globalThis.crypto.getRandomValues(bytes);
}

let lastMs = -1;
let lastCounter = 0;

/**
 * Mint a UUIDv7. Ids minted within the same millisecond stay strictly
 * increasing: the 12-bit `rand_a` field is used as a counter seeded from
 * random data (RFC 9562 §6.2, method 1), and the timestamp is bumped when
 * the counter overflows.
 */
export function uuidv7(source: UuidV7Source = {}): Uuid {
  const random = source.random ?? defaultRandom;
  let ms = Math.floor((source.now ?? Date.now)());
  const bytes = new Uint8Array(16);
  random(bytes);
  if (ms <= lastMs) {
    ms = lastMs;
    lastCounter += 1;
    if (lastCounter > 0xfff) {
      ms += 1;
      lastCounter = ((bytes[6] & 0x07) << 8) | bytes[7];
    }
  } else {
    // Seed with the top bit clear so a burst has room to count upwards.
    lastCounter = ((bytes[6] & 0x07) << 8) | bytes[7];
  }
  lastMs = ms;
  // 48-bit big-endian timestamp.
  let t = ms;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = t % 256;
    t = Math.floor(t / 256);
  }
  bytes[6] = 0x70 | ((lastCounter >> 8) & 0x0f);
  bytes[7] = lastCounter & 0xff;
  bytes[8] = 0x80 | (bytes[8] & 0x3f);
  return format(bytes);
}

const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/** 64-bit FNV-1a over UTF-16 code units, starting from `basis`. */
export function fnv1a64(input: string, basis: bigint = 0xcbf29ce484222325n): bigint {
  let h = basis;
  for (let i = 0; i < input.length; i++) {
    h ^= BigInt(input.charCodeAt(i));
    h = (h * FNV_PRIME) & MASK_64;
  }
  return h;
}

/**
 * Pure, deterministic UUIDv8 derived from `seed` and `salt`. Distinct
 * `(seed, salt)` pairs give distinct ids with overwhelming probability
 * (two 64-bit FNV-1a lanes with different offset bases).
 */
export function deriveId(seed: string, salt: string): Uuid {
  const input = `${seed}\u0000${salt}`;
  const hi = fnv1a64(input);
  const lo = fnv1a64(input, 0x6c62272e07bb0142n);
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    bytes[i] = Number((hi >> BigInt(56 - i * 8)) & 0xffn);
    bytes[8 + i] = Number((lo >> BigInt(56 - i * 8)) & 0xffn);
  }
  bytes[6] = 0x80 | (bytes[6] & 0x0f);
  bytes[8] = 0x80 | (bytes[8] & 0x3f);
  return format(bytes);
}

function format(bytes: Uint8Array): Uuid {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
