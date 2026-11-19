/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Review probe for PR #9621: numeric FNV-1a-64 must be bit-identical to the BigInt original.
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spatialBucketKey } from '@/hooks/symbolic-parse-cache-keys.js';

// Verbatim pre-PR implementation (origin/main 004934fa88).
function oldKey(a?: ReadonlyMap<number, number>, b?: ReadonlyMap<number, number>): string {
  let hash = 0xcbf29ce484222325n;
  const feed = (value: string): void => {
    for (let i = 0; i < value.length; i++) {
      hash ^= BigInt(value.charCodeAt(i));
      hash = BigInt.asUintN(64, hash * 0x100000001b3n);
    }
  };
  const pairs = (map?: ReadonlyMap<number, number>): void => {
    if (!map) { feed('-;'); return; }
    for (const [id, value] of [...map].sort(([x], [y]) => x - y)) feed(`${id}:${value},`);
    feed(';');
  };
  pairs(a); pairs(b);
  return hash.toString(16).padStart(16, '0');
}
// The PR's feed loop, copied verbatim, driven over arbitrary UTF-16 strings
// (spatialBucketKey itself can only ever feed ASCII number renderings).
function newFeed(s: string): string {
  let high = 0xcbf29ce4, low = 0x84222325;
  for (let i = 0; i < s.length; i++) {
    low = (low ^ s.charCodeAt(i)) >>> 0;
    const product = low * 435;
    high = (Math.imul(high, 435) + Math.imul(low, 256) + Math.floor(product / 0x100000000)) >>> 0;
    low = product >>> 0;
  }
  return high.toString(16).padStart(8, '0') + low.toString(16).padStart(8, '0');
}
function oldFeed(s: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i++) {
    hash ^= BigInt(s.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}
let seed = 0x9e3779b9;
const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 2 ** 32; };
const specials = [0, -0, 1, -1, NaN, Infinity, -Infinity, 0.1, 1e21, 1e-7, 2 ** 31, 2 ** 32 - 1, 2 ** 32, 2 ** 53, -(2 ** 53), Number.MAX_VALUE, Number.MIN_VALUE, 123.456, -3.5];
const pick = () => (rnd() < 0.3 ? specials[Math.floor(rnd() * specials.length)] : (rnd() < 0.5 ? Math.floor(rnd() * 2 ** 31) : (rnd() - 0.5) * 1e6));

it('raw feed: 200k random UTF-16 strings incl. lone/paired surrogates, empty and long', () => {
  const cases = ['', '\u0000', '￿', '\ud800', '\udfff', '😀', 'é', 'x'.repeat(1_000_000)];
  for (let n = 0; n < 200_000; n++) {
    const len = Math.floor(rnd() * 40);
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(rnd() < 0.5 ? Math.floor(rnd() * 128) : Math.floor(rnd() * 65536));
    cases.push(s);
  }
  // Adversarial: every single code unit, and pairs driving `low` through 0 / 0xffffffff.
  for (let c = 0; c < 65536; c++) cases.push(String.fromCharCode(c), String.fromCharCode(c, 65535 - c));
  let mism = 0;
  for (const s of cases) if (newFeed(s) !== oldFeed(s)) { mism++; if (mism < 5) console.log('MISMATCH', JSON.stringify(s.slice(0, 20))); }
  assert.equal(mism, 0);
});

it('spatialBucketKey (shipped function) vs BigInt original: 20k random maps incl. NaN/-0/Inf, unsorted, undefined', () => {
  let mism = 0;
  for (let n = 0; n < 20_000; n++) {
    const mk = () => {
      if (rnd() < 0.1) return undefined;
      const m = new Map<number, number>();
      const k = Math.floor(rnd() * 60);
      for (let i = 0; i < k; i++) m.set(pick(), pick());
      return m;
    };
    const a = mk(), b = mk();
    if (spatialBucketKey(a, b) !== oldKey(a, b)) mism++;
  }
  const big = new Map<number, number>();
  for (let i = 0; i < 200_000; i++) big.set(200_000 - i, (i % 37) * 3.25);
  assert.equal(spatialBucketKey(big, big), oldKey(big, big));
  assert.equal(spatialBucketKey(undefined, undefined), oldKey(undefined, undefined));
  assert.equal(spatialBucketKey(new Map(), new Map()), oldKey(new Map(), new Map()));
  assert.equal(mism, 0);
});
