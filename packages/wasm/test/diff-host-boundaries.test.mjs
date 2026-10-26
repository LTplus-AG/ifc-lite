/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { engine } from './diff-host-helpers.mjs';

test('raw WASM projection DTO observations catch array/enumeration throws and recover (#8042)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  const sentinel = { failure: 'projection getter' };
  const match = { kind: 'renamed', base: [{ key: '\ud800' }], head: [{ key: 'h' }] };
  for (const input of [
    new Proxy([match], { get(target, key, receiver) { if (key === 'length') throw sentinel; return Reflect.get(target, key, receiver); } }),
    new Proxy([match], { get(target, key, receiver) { if (key === '0') throw sentinel; return Reflect.get(target, key, receiver); } }),
    [new Proxy(match, { ownKeys() { throw sentinel; } })],
    [{ ...match, get kind() { throw sentinel; } }],
    [{ ...match, base: [{ get key() { throw sentinel; } }] }],
  ]) {
    assert.throws(() => wasm.diffIdentityMapFromContentMatches(input), error => error === sentinel);
    assert.deepEqual(wasm.diffIdentityMapFromContentMatches([match]), [{ base: '\ud800', here: 'h', reason: 'content-match:renamed' }]);
  }
  const revoked = Proxy.revocable([], {}); revoked.revoke();
  assert.throws(() => wasm.diffIdentityMapFromContentMatches(revoked.proxy), TypeError);
  assert.deepEqual(wasm.diffIdentityMapFromContentMatches([]), []);
});

test('raw WASM normalizer retained map traversal survives GC, throw and reentry (#8042)', async context => {
  const wasm = await engine(context); if (!wasm) return;
  const sentinel = { failure: 'normalization callback' };
  for (const throws of [false, true]) {
    let retained;
    const values = [1];
    values.map = function (callback) {
      retained = callback;
      assert.equal(callback({ b: 2, a: 1 }), '{"a":1,"b":2}');
      assert.equal(wasm.diffNormalizeValue({ inner: [1] }), '{"inner":[1]}');
      if (throws) throw sentinel;
      return ['1'];
    };
    if (throws) assert.throws(() => wasm.diffNormalizeValue(values), error => error === sentinel);
    else assert.equal(wasm.diffNormalizeValue(values), '[1]');
    if (globalThis.gc) for (let i = 0; i < 3; i++) globalThis.gc();
    assert.equal(retained({ b: [2], a: 1 }), '{"a":1,"b":[2]}');
    assert.throws(() => retained({ get a() { throw sentinel; } }), error => error === sentinel);
    assert.equal(retained({ a: '\ud800' }), '{"a":"\\ud800"}');
    assert.equal(wasm.diffNormalizeValue([2]), '[2]');
  }
});
