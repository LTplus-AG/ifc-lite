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
 *
 * TWO PATHS, ONE CLASS (B4.3). `new Rng(key)` is the public universe and is
 * exactly what it has always been - do not touch it, the whole committed corpus
 * and every anchor row is pinned to its bytes. `new Rng(key, salt)` is the
 * SALTED universe used by the benchmark's reporting split: same draw helpers,
 * different engine. It is keyed (HMAC-SHA256 over the stream name, salt as the
 * key) into a 128-bit sfc32 state instead of hashed into a 32-bit mulberry32
 * state, because 32 bits is brute-forceable against the served bytes and would
 * make the salt decorative - see the long note in lib/salt.mjs.
 */

import { normalizeSalt, deriveStreamState } from './salt.mjs';

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

/**
 * sfc32 (public domain, Chris Doty-Humphrey's small-fast-counting PRNG) over a
 * 128-bit state - the engine of the SALTED path. Chosen over widening
 * mulberry32 because it takes a full 128-bit seed with no key schedule of our
 * own devising, and its state is far past any offline sweep.
 */
export function sfc32(a, b, c, d) {
  let s0 = a >>> 0, s1 = b >>> 0, s2 = c >>> 0, s3 = d >>> 0;
  const next = function next() {
    s0 |= 0; s1 |= 0; s2 |= 0; s3 |= 0;
    const t = (((s0 + s1) | 0) + s3) | 0;
    s3 = (s3 + 1) | 0;
    s0 = s1 ^ (s1 >>> 9);
    s1 = (s2 + (s2 << 3)) | 0;
    s2 = (s2 << 21) | (s2 >>> 11);
    s2 = (s2 + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  // Standard warm-up: mix the raw key material before any draw is observable.
  for (let i = 0; i < 12; i++) next();
  return next;
}

/** Convenience wrapper with typed draw helpers over a single deterministic stream. */
export class Rng {
  /**
   * The salt is a PRIVATE field, not `this.salt`. An enumerable own property
   * would put the secret into `JSON.stringify(anything_holding_an_rng)` and
   * into every debugger/inspect dump, which is the quiet version of the argv
   * leak. A private field cannot be serialized, enumerated or read from
   * outside the class; `salted` below is the only thing callers may ask.
   */
  #salt;

  /**
   * @param {string|number} seed - the stream name, e.g. '42:corrupt'
   * @param {string} [salt] - '' / omitted = the public universe (mulberry32,
   *   byte-identical to v1); non-empty = the salted universe (keyed sfc32).
   */
  constructor(seed, salt = '') {
    this.#salt = normalizeSalt(salt);
    if (this.#salt === '') {
      this.seedValue = hashSeed(seed);
      this._next = mulberry32(this.seedValue);
      // Preserved verbatim: forks of an unsalted stream key off the HASH, not
      // the seed string, and the corpus depends on that exact spelling.
      this._forkBase = String(this.seedValue);
    } else {
      this.seedValue = null; // there is no 32-bit identity for a keyed stream
      this._next = sfc32(...deriveStreamState(this.#salt, seed));
      this._forkBase = String(seed);
    }
    this.draws = 0;
  }

  /** Which universe this stream belongs to. A boolean, never the material. */
  get salted() {
    return this.#salt !== '';
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

  /**
   * Derive an independent child stream (e.g. per-storey, per-room) without
   * disturbing this one. A fork of a salted stream stays salted - a child that
   * silently fell back to the public universe would be a hole in the mechanism.
   */
  fork(label) {
    return new Rng(`${this._forkBase}:${label}`, this.#salt);
  }
}
