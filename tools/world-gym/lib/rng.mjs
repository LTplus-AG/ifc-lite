/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Deterministic seeded RNG for the World Gym generator.
 *
 * No Date.now(), no Math.random(), no external entropy of any kind. A given
 * seed (number or string) always produces the exact same stream of draws,
 * which is the whole point: `generator.mjs --seed 42` must emit a
 * byte-identical IFC file every time, on every machine.
 *
 * Algorithm: mulberry32 (public domain), seeded via an FNV-1a hash of the
 * input so string seeds ("frame:42") and numeric seeds both work.
 */

/** FNV-1a hash of a string/number seed to a uint32. */
export function hashSeed(input) {
  let h = 0x811c9dc5;
  const s = String(input);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 PRNG factory - returns a `() => float in [0,1)` closure. */
export function mulberry32(seedUint32) {
  let a = seedUint32 >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Convenience wrapper with typed draw helpers over a single deterministic stream. */
export class Rng {
  constructor(seed) {
    this.seedValue = hashSeed(seed);
    this._next = mulberry32(this.seedValue);
    this.draws = 0;
  }

  /** Float in [0, 1). */
  float() {
    this.draws += 1;
    return this._next();
  }

  /** Float in [min, max). */
  range(min, max) {
    return min + this.float() * (max - min);
  }

  /** Integer in [min, max] inclusive. */
  int(min, max) {
    return Math.floor(this.range(min, max + 1));
  }

  /** Uniform pick from an array. */
  pick(arr) {
    return arr[Math.floor(this.float() * arr.length)];
  }

  /** Bernoulli draw with probability p of true. */
  bool(p = 0.5) {
    return this.float() < p;
  }

  /** Derive an independent child stream (e.g. per-storey, per-room) without disturbing this one. */
  fork(label) {
    return new Rng(`${this.seedValue}:${label}`);
  }
}
