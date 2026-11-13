/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spatialBucketKey } from './symbolic-parse-cache-keys.js';

it('NEW-3: spatial digests retain the persisted FNV-64 contract', () => {
  const maps = [undefined, new Map<number, number>(), new Map([[9, -0.25], [2, 1e20], [0, -1000], [42, 1.123456789]])];
  for (const a of maps) for (const b of maps) {
    const serialise = (m: typeof a) => m ? [...m].sort(([x], [y]) => x - y).map(([id, v]) => `${id}:${v},`).join('') + ';' : '-;';
    let hash = 0xcbf29ce484222325n;
    for (const c of serialise(a) + serialise(b)) hash = BigInt.asUintN(64, (hash ^ BigInt(c.charCodeAt(0))) * 0x100000001b3n);
    assert.equal(spatialBucketKey(a, b), hash.toString(16).padStart(16, '0'));
    if (a) assert.equal(spatialBucketKey(new Map([...a].reverse()), b), spatialBucketKey(a, b));
  }
});

it('NEW-3: numeric FNV matches legacy UTF-16 BigInt FNV for random and adversarial maps', () => {
  const legacy = (a: ReadonlyMap<number, number> | undefined, b: ReadonlyMap<number, number> | undefined) => {
    let hash = 0xcbf29ce484222325n;
    const feed = (text: string) => {
      // Index UTF-16 code units, including lone surrogates, exactly as before.
      for (let i = 0; i < text.length; i++) hash = BigInt.asUintN(64, (hash ^ BigInt(text.charCodeAt(i))) * 0x100000001b3n);
    };
    for (const map of [a, b]) {
      if (!map) { feed('-;'); continue; }
      for (const [id, value] of [...map].sort(([x], [y]) => x - y)) feed(`${id}:${value},`);
      feed(';');
    }
    return hash.toString(16).padStart(16, '0');
  };
  let seed = 0x6129621;
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let round = 0; round < 500; round++) {
    const a = new Map<number, number>();
    const b = new Map<number, number>();
    for (let i = 0, n = next() % 150; i < n; i++) {
      a.set(next(), (next() - 0x80000000) * 10 ** ((next() % 600) - 300));
      b.set(next(), next() / 0xffffffff);
    }
    assert.equal(spatialBucketKey(a, b), legacy(a, b), `seeded round ${round}`);
  }
  for (const text of ['', '長いéΩ', '\u0000', '\ud800', '\udfff', '😀', 'a'.repeat(100_000), '\ud800é\udfff'.repeat(10_000)]) {
    // Deliberately malformed runtime values exercise the full UTF-16 feed,
    // beyond the ASCII numeric strings produced by valid spatial maps.
    const map = new Map([[1, text as unknown as number], [Infinity, NaN], [-0, -Infinity]]);
    assert.equal(spatialBucketKey(map, undefined), legacy(map, undefined));
    assert.equal(spatialBucketKey(new Map(), map), legacy(new Map(), map));
  }
});
