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
