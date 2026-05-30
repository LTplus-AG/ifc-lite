/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Deterministic, input-only UUID generation.
 *
 * Produces an RFC-4122-shaped identifier (8-4-4-4-12 lowercase hex) whose 128
 * bits are derived purely from a seed string. The same seed always yields the
 * same UUID, with no dependence on the system clock or any random source. This
 * is what lets a BCF topic guid be a stable function of a clash-group id, so a
 * re-run of the same coordination produces byte-identical topic guids and the
 * round-trip back to clashes stays anchored.
 *
 * The 128 bits are filled from four 32-bit words. Each word starts from an
 * FNV-1a hash of the seed mixed with a distinct salt, then is run through a
 * short xorshift cascade so adjacent seeds (e.g. "g1" vs "g2") diffuse into
 * fully different words rather than differing in only a few low bits.
 */

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** 32-bit FNV-1a over the UTF-8-ish code units of `input`, seeded with `salt`. */
function fnv1a(input: string, salt: number): number {
  let hash = (FNV_OFFSET_BASIS ^ salt) >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    // Fold the full 16-bit code unit in two byte-sized steps so non-ASCII
    // comment-free seeds still contribute every bit.
    hash = (hash ^ (code & 0xff)) >>> 0;
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
    hash = (hash ^ ((code >>> 8) & 0xff)) >>> 0;
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

/** A short xorshift cascade to diffuse a 32-bit word. */
function xorshift32(value: number): number {
  let x = value >>> 0;
  x ^= x << 13;
  x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5;
  return x >>> 0;
}

/** Left-pad a non-negative 32-bit word to 8 lowercase hex chars. */
function hex32(value: number): string {
  return (value >>> 0).toString(16).padStart(8, '0');
}

/**
 * Stable RFC-4122-shaped UUID derived purely from `seed`.
 *
 * - 8-4-4-4-12 lowercase hex
 * - version nibble fixed to '4'
 * - variant nibble in {8, 9, a, b}
 */
export function uuidFromSeed(seed: string): string {
  // Four independent 32-bit words, each its own salt then xorshift-mixed.
  const w0 = xorshift32(fnv1a(seed, 0x9e3779b1));
  const w1 = xorshift32(fnv1a(seed, 0x85ebca77));
  const w2 = xorshift32(fnv1a(seed, 0xc2b2ae3d));
  const w3 = xorshift32(fnv1a(seed, 0x27d4eb2f));

  // Cross-mix so each output nibble depends on the whole seed, not one word.
  const a = xorshift32(w0 ^ Math.imul(w3, FNV_PRIME)) >>> 0;
  const b = xorshift32(w1 ^ Math.imul(w0, FNV_PRIME)) >>> 0;
  const c = xorshift32(w2 ^ Math.imul(w1, FNV_PRIME)) >>> 0;
  const d = xorshift32(w3 ^ Math.imul(w2, FNV_PRIME)) >>> 0;

  const hexA = hex32(a);
  const hexB = hex32(b);
  const hexC = hex32(c);
  const hexD = hex32(d);

  // Layout: AAAAAAAA-BBBB-4BBB-VCCC-CCCCDDDDDDDD
  //   time_low      = hexA            (8)
  //   time_mid      = hexB[0..4)      (4)
  //   time_hi_ver   = '4' + hexB[4..7) (4, version nibble forced to 4)
  //   clock_variant = variant + hexC[1..4) (4)
  //   node          = hexC[4..8) + hexD (12)
  const timeLow = hexA;
  const timeMid = hexB.slice(0, 4);
  const timeHiAndVersion = `4${hexB.slice(4, 7)}`;

  // Variant nibble: high two bits must be '10' -> one of 8, 9, a, b.
  // Derive it from the top nibble of hexC so it is still seed-dependent.
  const variantSource = parseInt(hexC[0], 16);
  const variantNibble = ((variantSource & 0x3) | 0x8).toString(16);
  const clockSeqAndVariant = `${variantNibble}${hexC.slice(1, 4)}`;

  const node = `${hexC.slice(4, 8)}${hexD}`;

  return `${timeLow}-${timeMid}-${timeHiAndVersion}-${clockSeqAndVariant}-${node}`;
}
