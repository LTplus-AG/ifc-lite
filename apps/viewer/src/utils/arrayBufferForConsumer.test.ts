/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { arrayBufferForConsumer } from './arrayBufferForConsumer.js';

it('keeps ordinary buffers and materializes shared source only at a consumer (#6537)', () => {
  const ordinary = new Uint8Array([1, 2, 3]).buffer;
  assert.equal(arrayBufferForConsumer(ordinary)(), ordinary);
  const source = new SharedArrayBuffer(3);
  new Uint8Array(source).set([4, 5, 6]);
  let copies = 0;
  const original = Uint8Array.prototype.slice;
  Uint8Array.prototype.slice = function(start?: number, end?: number) {
    if (this.buffer === source) copies++;
    return original.call(this, start, end);
  };
  try {
    const owned = arrayBufferForConsumer(source);
    assert.equal(copies, 0, 'preparing the consumer must not copy the source');
    const first = owned();
    assert.equal(copies, 1);
    assert.ok(first instanceof ArrayBuffer);
    assert.deepEqual([...new Uint8Array(first)], [4, 5, 6]);
    assert.equal(owned(), first, 'the same consumer owns one copy per load');
    assert.equal(copies, 1);
    new Uint8Array(first)[0] = 99;
    assert.equal(new Uint8Array(source)[0], 4, 'owned consumer bytes cannot mutate shared model source');
  } finally {
    Uint8Array.prototype.slice = original;
  }
});
